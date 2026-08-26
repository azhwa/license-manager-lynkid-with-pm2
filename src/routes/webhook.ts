import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, LynkPayload } from '../types';
import { getMapping, findLicenseByEmail } from '../db/queries';
import { generateLicenseKey } from '../utils/license-key';
import { verifyLynkSignature } from '../utils/signature';
import { decryptMerchantKey } from '../utils/merchant-key';
import { jsonError, isoNow, normalizeEmail } from '../utils/http';
import { resolveMaxDevices } from '../utils/entitlement';

type LynkAccount = { id: number; slug: string; merchant_key_ciphertext: string };

export const webhookRoutes = new Hono<AppContext>();

async function handleWebhook(c: Context<AppContext>, accountSlug?: string) {
  const rawPayload = await c.req.text();
  let payload: LynkPayload;
  try { payload = JSON.parse(rawPayload) as LynkPayload; } catch { return jsonError(c, 400, 'Invalid JSON payload'); }
  const data = payload.data?.message_data;
  if (payload.event === 'webhook.test' || payload.event === 'test' || data?.message_action === 'TEST') {
    return c.json({ success: true, message: 'Webhook test received' });
  }
  // Lynk currently sends message_id inside message_data. Keep the outer
  // location as a fallback for older payloads and the original spec.
  const messageId = data?.message_id ?? payload.data?.message_id;
  const email = normalizeEmail(data?.customer?.email);
  const refId = data?.refId;
  const item = data?.items?.[0];
  const rawGrandTotal = data?.totals?.grandTotal;
  const grandTotal = typeof rawGrandTotal === 'number'
    ? rawGrandTotal
    : typeof rawGrandTotal === 'string'
      ? Number(rawGrandTotal.replace(/[^\d.-]/g, ''))
      : Number.NaN;
  const missingFields = [
    !messageId ? 'message_id' : null,
    !email ? 'customer.email' : null,
    !refId ? 'message_data.refId' : null,
    !item?.title ? 'message_data.items[0].title' : null,
    !Number.isFinite(grandTotal) ? 'message_data.totals.grandTotal' : null,
  ].filter((field): field is string => field !== null);
  if (missingFields.length) return jsonError(c, 400, 'Missing required Lynk.id fields', { fields: missingFields });
  const requiredMessageId = messageId as string;
  const requiredEmail = email as string;
  const requiredRefId = refId as string;
  const requiredTitle = item?.title as string;

  const account = accountSlug
    ? await c.env.DB.prepare('SELECT id, slug, merchant_key_ciphertext FROM lynk_accounts WHERE slug = ? AND is_active = 1').bind(accountSlug).first<LynkAccount>()
    : null;
  if (accountSlug && !account) return jsonError(c, 404, 'Lynk account webhook not found');

  let merchantKey = c.env.LYNK_MERCHANT_KEY;
  if (account) {
    if (!c.env.MERCHANT_CONFIG_ENCRYPTION_KEY) return jsonError(c, 500, 'MERCHANT_CONFIG_ENCRYPTION_KEY is not configured');
    try { merchantKey = await decryptMerchantKey(account.merchant_key_ciphertext, c.env.MERCHANT_CONFIG_ENCRYPTION_KEY); }
    catch { return jsonError(c, 500, 'Unable to decrypt Lynk account configuration'); }
  }
  if (!merchantKey) return jsonError(c, 500, 'LYNK_MERCHANT_KEY is not configured');

  const valid = await verifyLynkSignature(c.req.header('X-Lynk-Signature') ?? null, grandTotal, requiredRefId, requiredMessageId, merchantKey);
  const accountId = account?.id ?? null;
  const log = await c.env.DB.prepare('INSERT INTO webhook_logs(lynk_account_id, message_id, raw_payload, signature_valid, processed, error_message) VALUES (?, ?, ?, ?, 0, ?) RETURNING id').bind(accountId, requiredMessageId, rawPayload, valid ? 1 : 0, valid ? null : 'Invalid signature').first<{ id: number }>();
  if (!valid) return jsonError(c, 401, 'Invalid webhook signature');

  // Prefix account-specific transactions so identical message IDs from two accounts cannot collide.
  const transactionMessageId = account ? `${account.id}:${requiredMessageId}` : requiredMessageId;
  const duplicate = await c.env.DB.prepare('SELECT id FROM transactions WHERE message_id = ?').bind(transactionMessageId).first();
  if (duplicate) return c.json({ success: true, duplicate: true });

  const mapping = await getMapping(c.env.DB, requiredTitle);
  if (!mapping) return jsonError(c, 422, 'No active product mapping found for this item');
  const now = new Date();
  const license = await findLicenseByEmail(c.env.DB, requiredEmail);
  const previousEnd = license?.current_period_end ?? null;
  const wasActive = Boolean(license?.current_period_end && new Date(license.current_period_end).getTime() > now.getTime() && license.status === 'active');
  const newEnd = new Date((wasActive ? new Date(license?.current_period_end as string) : now).getTime() + mapping.duration_days * 86_400_000).toISOString();
  const renewalType = !license ? 'new' : wasActive ? 'stacked' : 'reactivated';
  const licenseKey = license?.key ?? generateLicenseKey();
  const maxDevices = resolveMaxDevices(license?.max_devices ?? 1, mapping.max_devices, wasActive);
  const statements = license
    ? [c.env.DB.prepare("UPDATE licenses SET plan_type = ?, status = 'active', current_period_end = ?, max_devices = ?, updated_at = ? WHERE id = ?").bind(mapping.plan_type, newEnd, maxDevices, isoNow(), license.id), c.env.DB.prepare('INSERT INTO transactions(lynk_account_id, message_id, refId, email, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, signature_verified, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').bind(accountId, transactionMessageId, refId, email, item.title, grandTotal, mapping.duration_days, previousEnd, newEnd, renewalType, rawPayload)]
    : [c.env.DB.prepare("INSERT INTO licenses(email, key, plan_type, status, current_period_end, max_devices) VALUES (?, ?, ?, 'active', ?, ?)").bind(email, licenseKey, mapping.plan_type, newEnd, maxDevices), c.env.DB.prepare('INSERT INTO transactions(lynk_account_id, message_id, refId, email, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, signature_verified, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').bind(accountId, transactionMessageId, refId, email, item.title, grandTotal, mapping.duration_days, previousEnd, newEnd, renewalType, rawPayload)];
  try {
    await c.env.DB.batch(statements);
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET processed = 1 WHERE id = ?').bind(log.id).run();
    return c.json({ success: true, account: account?.slug ?? 'legacy', license_key: licenseKey, renewal_type: renewalType, expires_at: newEnd });
  } catch (error) {
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET error_message = ? WHERE id = ?').bind(String(error), log.id).run();
    return jsonError(c, 500, 'Webhook processing failed');
  }
}

webhookRoutes.post('/lynkid/:slug', (c) => handleWebhook(c, c.req.param('slug')));
// Backward compatible route for the legacy LYNK_MERCHANT_KEY secret.
webhookRoutes.post('/lynkid', (c) => handleWebhook(c));

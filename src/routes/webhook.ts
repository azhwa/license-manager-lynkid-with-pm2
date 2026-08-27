import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, LynkPayload } from '../types';
import { getMapping, findLicenseByEmail } from '../db/queries';
import { generateLicenseKey } from '../utils/license-key';
import { verifyLynkSignature } from '../utils/signature';
import { decryptMerchantKey } from '../utils/merchant-key';
import { jsonError, isoNow, normalizeCustomerName, normalizeEmail, normalizePhone, parseTimestamp } from '../utils/http';
import { resolveMaxDevices } from '../utils/entitlement';

type LynkAccount = { id: number; slug: string; merchant_key_ciphertext: string };

export const webhookRoutes = new Hono<AppContext>();

async function handleWebhook(c: Context<AppContext>, accountSlug?: string) {
  const rawPayload = await c.req.text();
  if (!rawPayload.trim()) return c.json({ success: true, message: 'Webhook endpoint reachable' });
  let payload: LynkPayload;
  try { payload = JSON.parse(rawPayload) as LynkPayload; } catch { return jsonError(c, 400, 'Invalid JSON payload'); }
  if (!payload.event && !payload.data) return c.json({ success: true, message: 'Webhook endpoint reachable' });
  const data = payload.data?.message_data;
  if ((payload.event && payload.event !== 'payment.received') || data?.message_action === 'TEST') return c.json({ success: true, message: 'Webhook event acknowledged' });
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
  const customerName = normalizeCustomerName(data?.customer?.name);
  const customerPhone = normalizePhone(data?.customer?.phone);
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
  const bannedAccount = await c.env.DB.prepare('SELECT id FROM banned_accounts WHERE is_active = 1 AND (email = ? COLLATE NOCASE OR (? IS NOT NULL AND phone = ?)) LIMIT 1').bind(requiredEmail, customerPhone, customerPhone).first<{ id: number }>();
  if (bannedAccount) {
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET processed = 1, error_message = ? WHERE id = ?').bind('Account is banned', log.id).run();
    await c.env.DB.prepare('INSERT INTO admin_audit_logs(action, target_type, target_id, details) VALUES (?, ?, ?, ?)').bind('account.purchase_blocked', 'account', requiredEmail, JSON.stringify({ reason: 'account_banned', phone: customerPhone, product_title: requiredTitle })).run();
    return c.json({ success: true, granted: false, reason: 'account_banned' });
  }
  const license = await findLicenseByEmail(c.env.DB, requiredEmail);
  const isTrialProduct = Boolean(mapping.is_trial) || mapping.plan_type.trim().toLowerCase() === 'trial';
  const isTrialLicense = Boolean(license && (license.access_type === 'trial' || license.plan_type.trim().toLowerCase() === 'trial'));

  const rejectTrial = async (reason: string) => {
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET processed = 1, error_message = ? WHERE id = ?').bind(reason, log.id).run();
    await c.env.DB.prepare('INSERT INTO admin_audit_logs(action, license_id, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)').bind('trial.rejected', license?.id ?? null, 'trial', requiredRefId, JSON.stringify({ reason, email: requiredEmail, phone: customerPhone, product_title: requiredTitle })).run();
    return c.json({ success: true, granted: false, reason });
  };

  if (isTrialProduct) {
    if (license) return rejectTrial('trial_already_used');
    const previousClaim = await c.env.DB.prepare('SELECT id FROM trial_claims WHERE email = ? COLLATE NOCASE OR (? IS NOT NULL AND phone = ?) LIMIT 1').bind(requiredEmail, customerPhone, customerPhone).first<{ id: number }>();
    if (previousClaim) return rejectTrial('trial_already_used');

    const trialEnd = new Date(now.getTime() + mapping.duration_days * 86_400_000).toISOString();
    const trialKey = generateLicenseKey();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare('INSERT OR IGNORE INTO trial_claims(email, phone, message_id, refId, claimed_at) VALUES (?, ?, ?, ?, ?)').bind(requiredEmail, customerPhone, transactionMessageId, requiredRefId, isoNow()),
        c.env.DB.prepare("INSERT INTO licenses(email, name, phone, key, plan_type, access_type, status, current_period_end, trial_started_at, trial_ends_at, trial_used_at, max_devices) SELECT ?, ?, ?, ?, ?, 'trial', 'active', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM trial_claims WHERE message_id = ?)").bind(requiredEmail, customerName, customerPhone, trialKey, mapping.plan_type, trialEnd, isoNow(), trialEnd, isoNow(), mapping.max_devices, transactionMessageId),
        c.env.DB.prepare("INSERT INTO transactions(lynk_account_id, message_id, refId, email, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, is_trial, signature_verified, raw_payload) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, 1, ? WHERE EXISTS (SELECT 1 FROM licenses WHERE email = ? COLLATE NOCASE AND key = ?)").bind(accountId, transactionMessageId, requiredRefId, requiredEmail, requiredTitle, grandTotal, mapping.duration_days, null, trialEnd, rawPayload, requiredEmail, trialKey),
      ]);
      const createdTransaction = await c.env.DB.prepare('SELECT id FROM transactions WHERE message_id = ?').bind(transactionMessageId).first<{ id: number }>();
      if (!createdTransaction) return rejectTrial('trial_already_used');
      const createdLicense = await findLicenseByEmail(c.env.DB, requiredEmail);
      if (createdLicense) await c.env.DB.prepare('UPDATE trial_claims SET license_id = ? WHERE message_id = ?').bind(createdLicense.id, transactionMessageId).run();
      if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET processed = 1 WHERE id = ?').bind(log.id).run();
      return c.json({ success: true, granted: true, account: account?.slug ?? 'legacy', license_key: trialKey, renewal_type: 'new', expires_at: trialEnd });
    } catch (error) {
      if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET error_message = ? WHERE id = ?').bind(String(error), log.id).run();
      return jsonError(c, 500, 'Webhook processing failed');
    }
  }

  const previousEnd = license?.current_period_end ?? null;
  const previousEndDate = parseTimestamp(license?.current_period_end ?? null);
  const wasActive = Boolean(previousEndDate && previousEndDate.getTime() > now.getTime() && license?.status === 'active');
  const baseDate = wasActive && previousEndDate ? previousEndDate : now;
  const newEnd = new Date(baseDate.getTime() + mapping.duration_days * 86_400_000).toISOString();
  const renewalType = isTrialLicense ? 'converted' : !license ? 'new' : wasActive ? 'stacked' : 'reactivated';
  const licenseKey = license?.key ?? generateLicenseKey();
  const maxDevices = resolveMaxDevices(license?.max_devices ?? 1, mapping.max_devices, wasActive);
  const statements = license
    ? [c.env.DB.prepare("UPDATE licenses SET name = COALESCE(?, name), phone = COALESCE(?, phone), plan_type = ?, access_type = 'paid', converted_at = COALESCE(?, converted_at), status = 'active', current_period_end = ?, max_devices = ?, updated_at = ? WHERE id = ?").bind(customerName, customerPhone, mapping.plan_type, isTrialLicense ? isoNow() : null, newEnd, maxDevices, isoNow(), license.id), c.env.DB.prepare('INSERT INTO transactions(lynk_account_id, message_id, refId, email, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, is_trial, signature_verified, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)').bind(accountId, transactionMessageId, requiredRefId, requiredEmail, requiredTitle, grandTotal, mapping.duration_days, previousEnd, newEnd, renewalType, rawPayload)]
    : [c.env.DB.prepare("INSERT INTO licenses(email, name, phone, key, plan_type, access_type, status, current_period_end, max_devices) VALUES (?, ?, ?, ?, ?, 'paid', 'active', ?, ?)").bind(requiredEmail, customerName, customerPhone, licenseKey, mapping.plan_type, newEnd, maxDevices), c.env.DB.prepare('INSERT INTO transactions(lynk_account_id, message_id, refId, email, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, is_trial, signature_verified, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)').bind(accountId, transactionMessageId, requiredRefId, requiredEmail, requiredTitle, grandTotal, mapping.duration_days, previousEnd, newEnd, renewalType, rawPayload)];
  try {
    await c.env.DB.batch(statements);
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET processed = 1 WHERE id = ?').bind(log.id).run();
    return c.json({ success: true, account: account?.slug ?? 'legacy', license_key: licenseKey, renewal_type: renewalType, expires_at: newEnd });
  } catch (error) {
    if (log?.id) await c.env.DB.prepare('UPDATE webhook_logs SET error_message = ? WHERE id = ?').bind(String(error), log.id).run();
    return jsonError(c, 500, 'Webhook processing failed');
  }
}

webhookRoutes.get('/lynkid/:slug', (c) => c.json({ success: true, message: 'Webhook endpoint reachable' }));
webhookRoutes.post('/lynkid/:slug', (c) => handleWebhook(c, c.req.param('slug')));
// Backward compatible route for the legacy LYNK_MERCHANT_KEY secret.
webhookRoutes.get('/lynkid', (c) => c.json({ success: true, message: 'Webhook endpoint reachable' }));
webhookRoutes.post('/lynkid', (c) => handleWebhook(c));

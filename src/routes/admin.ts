import { Hono } from 'hono';
import type { AppContext } from '../types';
import { requireAdmin } from '../middleware/auth';
import { endOfDayInTimezone, isoNow, jsonError, normalizeCustomerName, normalizeEmail } from '../utils/http';
import { encryptMerchantKey } from '../utils/merchant-key';
import { writeAudit } from '../utils/audit';
import { generateLicenseKey } from '../utils/license-key';

export const adminRoutes = new Hono<AppContext>();
adminRoutes.use('*', requireAdmin);

function normalizeSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

function normalizeMaxDevices(value: unknown): number | null {
  const maxDevices = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(maxDevices) && maxDevices >= 1 && maxDevices <= 100 ? maxDevices : null;
}

function normalizePlanType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const planType = value.trim();
  return planType && planType.length <= 50 && !/[\r\n]/.test(planType) ? planType : null;
}

function normalizeExpiresAt(value: unknown, timeZone = 'UTC'): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const rawValue = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(rawValue) ? endOfDayInTimezone(rawValue, timeZone) : rawValue;
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function publicAccount(row: Record<string, unknown>) {
  return { ...row, webhook_path: `/webhook/lynkid/${row.slug}` };
}

adminRoutes.get('/lynk-accounts', async (c) => {
  const result = await c.env.DB.prepare('SELECT id, name, slug, is_active, created_at, updated_at FROM lynk_accounts ORDER BY created_at DESC').all<Record<string, unknown>>();
  return c.json({ accounts: result.results.map(publicAccount) });
});

adminRoutes.post('/lynk-accounts', async (c) => {
  const body = await c.req.json<{ name?: string; slug?: string; merchant_key?: string; is_active?: boolean }>().catch(() => ({} as { name?: string; slug?: string; merchant_key?: string; is_active?: boolean }));
  const name = body.name?.trim();
  const slug = normalizeSlug(body.slug);
  const merchantKey = body.merchant_key?.trim();
  if (!name || !slug || !merchantKey) return jsonError(c, 400, 'name, slug, and merchant_key are required');
  if (!c.env.MERCHANT_CONFIG_ENCRYPTION_KEY) return jsonError(c, 500, 'MERCHANT_CONFIG_ENCRYPTION_KEY is not configured');
  try {
    const ciphertext = await encryptMerchantKey(merchantKey, c.env.MERCHANT_CONFIG_ENCRYPTION_KEY);
    const result = await c.env.DB.prepare('INSERT INTO lynk_accounts(name, slug, merchant_key_ciphertext, is_active) VALUES (?, ?, ?, ?) RETURNING id, name, slug, is_active, created_at, updated_at').bind(name, slug, ciphertext, body.is_active === false ? 0 : 1).first<Record<string, unknown>>();
    await writeAudit(c.env.DB, 'lynk_account.created', { targetType: 'lynk_account', targetId: result?.id as number | undefined, details: { name, slug } });
    return c.json({ account: publicAccount(result as Record<string, unknown>) }, 201);
  } catch (error) { return jsonError(c, 409, 'An account with that slug already exists', String(error)); }
});

adminRoutes.put('/lynk-accounts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ name?: string; slug?: string; merchant_key?: string; is_active?: boolean }>().catch(() => ({} as { name?: string; slug?: string; merchant_key?: string; is_active?: boolean }));
  const name = body.name?.trim();
  const slug = normalizeSlug(body.slug);
  if (!Number.isInteger(id) || !name || !slug) return jsonError(c, 400, 'Invalid account payload');
  const existing = await c.env.DB.prepare('SELECT id, name, slug, merchant_key_ciphertext, is_active FROM lynk_accounts WHERE id = ?').bind(id).first<{ id: number; name: string; slug: string; merchant_key_ciphertext: string; is_active: number }>();
  if (!existing) return jsonError(c, 404, 'Lynk account not found');
  let ciphertext = existing.merchant_key_ciphertext;
  if (body.merchant_key?.trim()) {
    if (!c.env.MERCHANT_CONFIG_ENCRYPTION_KEY) return jsonError(c, 500, 'MERCHANT_CONFIG_ENCRYPTION_KEY is not configured');
    ciphertext = await encryptMerchantKey(body.merchant_key.trim(), c.env.MERCHANT_CONFIG_ENCRYPTION_KEY);
  }
  try {
    const isActive = typeof body.is_active === 'boolean' ? (body.is_active ? 1 : 0) : existing.is_active;
    const result = await c.env.DB.prepare('UPDATE lynk_accounts SET name = ?, slug = ?, merchant_key_ciphertext = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, slug, is_active, created_at, updated_at').bind(name, slug, ciphertext, isActive, id).first<Record<string, unknown>>();
    await writeAudit(c.env.DB, 'lynk_account.updated', { targetType: 'lynk_account', targetId: id, details: { name, slug, is_active: isActive } });
    return c.json({ account: publicAccount(result as Record<string, unknown>) });
  } catch (error) { return jsonError(c, 409, 'An account with that slug already exists', String(error)); }
});

adminRoutes.delete('/lynk-accounts/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid Lynk account id');
  const existing = await c.env.DB.prepare('SELECT id FROM lynk_accounts WHERE id = ?').bind(id).first<{ id: number }>();
  if (!existing) return jsonError(c, 404, 'Lynk account not found');
  const history = await c.env.DB.prepare('SELECT (SELECT COUNT(*) FROM transactions WHERE lynk_account_id = ?) + (SELECT COUNT(*) FROM webhook_logs WHERE lynk_account_id = ?) AS total').bind(id, id).first<{ total: number }>();
  if ((history?.total ?? 0) > 0) return jsonError(c, 409, 'This account has webhook history; deactivate it instead of deleting');
  await c.env.DB.prepare('DELETE FROM lynk_accounts WHERE id = ?').bind(id).run();
  await writeAudit(c.env.DB, 'lynk_account.deleted', { targetType: 'lynk_account', targetId: id });
  return c.body(null, 204);
});

adminRoutes.get('/mapping', async (c) => {
  const result = await c.env.DB.prepare('SELECT id, title_pattern, duration_days, plan_type, max_devices, is_trial, is_active, created_at FROM product_mapping ORDER BY created_at DESC').all();
  return c.json({ mappings: result.results });
});

adminRoutes.post('/mapping', async (c) => {
  const body = await c.req.json<{ title_pattern?: string; duration_days?: number; plan_type?: string; max_devices?: number; is_trial?: boolean; is_active?: boolean }>().catch(() => ({} as { title_pattern?: string; duration_days?: number; plan_type?: string; max_devices?: number; is_trial?: boolean; is_active?: boolean }));
  const titlePattern = body.title_pattern?.trim();
  const planType = normalizePlanType(body.plan_type);
  const maxDevices = normalizeMaxDevices(body.max_devices);
  const isTrial = typeof body.is_trial === 'boolean' ? body.is_trial : planType?.toLowerCase() === 'trial';
  if (!titlePattern || !Number.isInteger(body.duration_days) || (body.duration_days as number) < 1 || planType === null || maxDevices === null) return jsonError(c, 400, 'title_pattern, duration_days, max_devices, and a valid plan_type are required');
  try {
    const result = await c.env.DB.prepare('INSERT INTO product_mapping(title_pattern, duration_days, plan_type, max_devices, is_trial, is_active) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, title_pattern, duration_days, plan_type, max_devices, is_trial, is_active, created_at').bind(titlePattern, body.duration_days as number, planType, maxDevices, isTrial ? 1 : 0, body.is_active === false ? 0 : 1).first<Record<string, unknown>>();
    await writeAudit(c.env.DB, 'mapping.created', { targetType: 'mapping', targetId: result?.id as number | undefined, details: { title_pattern: titlePattern, max_devices: maxDevices } });
    return c.json({ mapping: result }, 201);
  } catch (error) { return jsonError(c, 409, 'A mapping with that title pattern already exists', String(error)); }
});

adminRoutes.put('/mapping/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ title_pattern?: string; duration_days?: number; plan_type?: string; max_devices?: number; is_trial?: boolean; is_active?: boolean }>().catch(() => ({} as { title_pattern?: string; duration_days?: number; plan_type?: string; max_devices?: number; is_trial?: boolean; is_active?: boolean }));
  const titlePattern = body.title_pattern?.trim();
  const planType = normalizePlanType(body.plan_type);
  const maxDevices = normalizeMaxDevices(body.max_devices);
  const isTrial = typeof body.is_trial === 'boolean' ? body.is_trial : planType?.toLowerCase() === 'trial';
  if (!Number.isInteger(id) || !titlePattern || !Number.isInteger(body.duration_days) || (body.duration_days as number) < 1 || planType === null || maxDevices === null) return jsonError(c, 400, 'Invalid mapping payload');
  const result = await c.env.DB.prepare('UPDATE product_mapping SET title_pattern = ?, duration_days = ?, plan_type = ?, max_devices = ?, is_trial = ?, is_active = ? WHERE id = ? RETURNING id, title_pattern, duration_days, plan_type, max_devices, is_trial, is_active, created_at').bind(titlePattern, body.duration_days as number, planType, maxDevices, isTrial ? 1 : 0, body.is_active === false ? 0 : 1, id).first<Record<string, unknown>>();
  if (!result) return jsonError(c, 404, 'Mapping not found');
  await writeAudit(c.env.DB, 'mapping.updated', { targetType: 'mapping', targetId: id, details: { title_pattern: titlePattern, max_devices: maxDevices } });
  return c.json({ mapping: result });
});

adminRoutes.delete('/mapping/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM product_mapping WHERE id = ?').bind(Number(c.req.param('id'))).run();
  if (!result.meta.changes) return jsonError(c, 404, 'Mapping not found');
  await writeAudit(c.env.DB, 'mapping.deleted', { targetType: 'mapping', targetId: Number(c.req.param('id')) });
  return c.body(null, 204);
});

adminRoutes.delete('/licenses/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const license = await c.env.DB.prepare('SELECT id, email, key, is_banned FROM licenses WHERE id = ?').bind(id).first<{ id: number; email: string; key: string; is_banned: number }>();
  if (!license) return jsonError(c, 404, 'License not found');
  if (license.is_banned) return jsonError(c, 409, 'Unban the account before deleting its license');
  await c.env.DB.prepare('DELETE FROM licenses WHERE id = ?').bind(id).run();
  await writeAudit(c.env.DB, 'license.deleted', { targetType: 'license', targetId: id, details: { email: license.email, key: license.key, source: 'admin' } });
  return c.body(null, 204);
});

adminRoutes.post('/licenses/:id/ban', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 250) || null : null;
  const license = await c.env.DB.prepare('SELECT id, email, phone, is_banned FROM licenses WHERE id = ?').bind(id).first<{ id: number; email: string; phone: string | null; is_banned: number }>();
  if (!license) return jsonError(c, 404, 'License not found');
  const now = isoNow();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO banned_accounts(email, phone, license_id, reason, is_active, banned_at, unbanned_at) VALUES (?, ?, ?, ?, 1, ?, NULL) ON CONFLICT(email) DO UPDATE SET phone = excluded.phone, license_id = excluded.license_id, reason = excluded.reason, is_active = 1, banned_at = excluded.banned_at, unbanned_at = NULL").bind(license.email, license.phone, id, reason, now),
      c.env.DB.prepare('UPDATE licenses SET is_banned = 1, updated_at = ? WHERE id = ?').bind(now, id),
    ]);
    await writeAudit(c.env.DB, 'account.banned', { licenseId: id, targetType: 'account', targetId: license.email, details: { reason, phone: license.phone } });
    return c.json({ success: true, status: 'banned' });
  } catch (error) { return jsonError(c, 409, 'Unable to ban this account because its phone number is already associated with another ban', String(error)); }
});

adminRoutes.post('/licenses/:id/unban', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const license = await c.env.DB.prepare('SELECT id, email, phone, is_banned FROM licenses WHERE id = ?').bind(id).first<{ id: number; email: string; phone: string | null; is_banned: number }>();
  if (!license) return jsonError(c, 404, 'License not found');
  const now = isoNow();
  await c.env.DB.prepare('UPDATE banned_accounts SET is_active = 0, unbanned_at = ? WHERE email = ? COLLATE NOCASE OR (? IS NOT NULL AND phone = ?)').bind(now, license.email, license.phone, license.phone).run();
  await c.env.DB.prepare('UPDATE licenses SET is_banned = 0, updated_at = ? WHERE id = ?').bind(now, id).run();
  await writeAudit(c.env.DB, 'account.unbanned', { licenseId: id, targetType: 'account', targetId: license.email, details: { phone: license.phone } });
  return c.json({ success: true, status: 'unbanned' });
});

adminRoutes.get('/licenses', async (c) => {
  const email = c.req.query('email')?.trim().toLowerCase();
  const select = 'SELECT licenses.*, (SELECT COUNT(*) FROM activations WHERE activations.license_id = licenses.id) AS devices_used FROM licenses';
  const query = email ? `${select} WHERE email = ? COLLATE NOCASE ORDER BY created_at DESC` : `${select} ORDER BY created_at DESC LIMIT 100`;
  const result = await c.env.DB.prepare(query).bind(...(email ? [email] : [])).all();
  return c.json({ licenses: result.results });
});

adminRoutes.post('/licenses', async (c) => {
  const body = await c.req.json<{
    email?: string;
    name?: string;
    key?: string;
    plan_type?: string;
    duration_days?: number;
    max_devices?: number;
  }>().catch(() => ({} as { email?: string; name?: string; key?: string; plan_type?: string; duration_days?: number; max_devices?: number }));
  const email = normalizeEmail(body.email);
  const name = normalizeCustomerName(body.name);
  const key = (body.key?.trim() || generateLicenseKey()).toUpperCase();
  const planType = normalizePlanType(body.plan_type);
  const durationDays = Number(body.duration_days);
  const maxDevices = Number(body.max_devices);
  if (!email || !/^[A-Z0-9-]{8,64}$/.test(key) || planType === null || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650 || !Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) {
    return jsonError(c, 400, 'email, valid key, duration_days, max_devices, and a valid plan_type are required');
  }

  const isTrial = planType.toLowerCase() === 'trial';
  if (isTrial) {
    const claimed = await c.env.DB.prepare('SELECT id FROM trial_claims WHERE email = ? COLLATE NOCASE LIMIT 1').bind(email).first<{ id: number }>();
    if (claimed) return jsonError(c, 409, 'Customer has already used the Trial');
  }
  const currentPeriodEnd = new Date(Date.now() + durationDays * 86_400_000).toISOString();
  const now = isoNow();
  try {
    const license = await c.env.DB.prepare(
      "INSERT INTO licenses(email, name, key, plan_type, access_type, status, current_period_end, trial_started_at, trial_ends_at, trial_used_at, max_devices, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?) RETURNING id, email, name, key, plan_type, access_type, status, current_period_end, trial_started_at, trial_ends_at, trial_used_at, max_devices, created_at, updated_at"
    ).bind(email, name, key, planType, isTrial ? 'trial' : 'paid', currentPeriodEnd, isTrial ? now : null, isTrial ? currentPeriodEnd : null, isTrial ? now : null, maxDevices, now).first<Record<string, unknown>>();
    if (isTrial && license?.id) {
      await c.env.DB.prepare('INSERT INTO trial_claims(email, license_id, message_id, refId, claimed_at) VALUES (?, ?, ?, ?, ?)').bind(email, license.id as number, `admin:license:${license.id}`, `admin:${license.id}`, now).run();
    }
    await writeAudit(c.env.DB, 'license.created', { licenseId: license?.id as number | undefined, targetType: 'license', targetId: license?.id as number | undefined, details: { email, name, plan_type: planType, duration_days: durationDays, max_devices: maxDevices, source: 'manual' } });
    return c.json({ success: true, license }, 201);
  } catch {
    return jsonError(c, 409, 'Email atau license key sudah digunakan');
  }
});

adminRoutes.put('/licenses/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{
    email?: string;
    name?: string;
    plan_type?: string;
    expires_at?: string;
    max_devices?: number;
  }>().catch(() => ({} as { email?: string; name?: string; plan_type?: string; expires_at?: string; max_devices?: number }));
  const email = normalizeEmail(body.email);
  const name = normalizeCustomerName(body.name);
  const planType = normalizePlanType(body.plan_type);
  const expiresAt = normalizeExpiresAt(body.expires_at, c.env.APP_TIMEZONE || 'UTC');
  const maxDevices = normalizeMaxDevices(body.max_devices);
  if (!Number.isInteger(id) || !email || planType === null || expiresAt === null || maxDevices === null) {
    return jsonError(c, 400, 'email, plan_type, expires_at, and a valid max_devices are required');
  }

  const existing = await c.env.DB.prepare('SELECT id, status, access_type, plan_type FROM licenses WHERE id = ?').bind(id).first<{ id: number; status: string; access_type: string; plan_type: string }>();
  if (!existing) return jsonError(c, 404, 'License not found');
  if (planType.toLowerCase() === 'trial' && existing.access_type !== 'trial' && existing.plan_type.toLowerCase() !== 'trial') return jsonError(c, 409, 'Paid licenses cannot be changed into Trial');
  const usedDevices = (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM activations WHERE license_id = ?').bind(id).first<{ count: number }>())?.count ?? 0;
  if (usedDevices > maxDevices) return jsonError(c, 409, 'max_devices cannot be lower than the current active device count', { max_devices: maxDevices, used_devices: usedDevices });

  const nextStatus = existing.status === 'revoked' ? 'revoked' : new Date(expiresAt).getTime() > Date.now() ? 'active' : 'expired';
  try {
    const license = await c.env.DB.prepare(
      "UPDATE licenses SET email = ?, name = COALESCE(?, name), plan_type = ?, access_type = CASE WHEN lower(?) = 'trial' THEN 'trial' ELSE 'paid' END, current_period_end = ?, max_devices = ?, status = ?, updated_at = ? WHERE id = ? RETURNING id, email, name, key, plan_type, access_type, status, current_period_end, trial_started_at, trial_ends_at, trial_used_at, max_devices, created_at, updated_at"
    ).bind(email, name, planType, planType, expiresAt, maxDevices, nextStatus, isoNow(), id).first<Record<string, unknown>>();
    await writeAudit(c.env.DB, 'license.updated', { licenseId: id, targetType: 'license', targetId: id, details: { email, name, plan_type: planType, expires_at: expiresAt, max_devices: maxDevices } });
    return c.json({ success: true, license });
  } catch {
    return jsonError(c, 409, 'Email sudah digunakan oleh license lain');
  }
});

adminRoutes.get('/licenses/:id/activations', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const license = await c.env.DB.prepare('SELECT id, key, max_devices FROM licenses WHERE id = ?').bind(id).first<{ id: number; key: string; max_devices: number }>();
  if (!license) return jsonError(c, 404, 'License not found');
  const result = await c.env.DB.prepare('SELECT id, device_hash, device_name, platform, activated_at, last_seen FROM activations WHERE license_id = ? ORDER BY activated_at ASC').bind(id).all();
  return c.json({ license, activations: result.results });
});

adminRoutes.delete('/licenses/:id/activations/:activationId', async (c) => {
  const licenseId = Number(c.req.param('id'));
  const activationId = Number(c.req.param('activationId'));
  if (!Number.isInteger(licenseId) || !Number.isInteger(activationId)) return jsonError(c, 400, 'Invalid activation id');
  const activation = await c.env.DB.prepare('SELECT device_hash FROM activations WHERE id = ? AND license_id = ?').bind(activationId, licenseId).first<{ device_hash: string }>();
  if (!activation) return jsonError(c, 404, 'Activation not found');
  await c.env.DB.prepare('DELETE FROM activations WHERE id = ? AND license_id = ?').bind(activationId, licenseId).run();
  await writeAudit(c.env.DB, 'activation.unbound', { licenseId, targetType: 'activation', targetId: activationId, details: { device_hash: activation.device_hash } });
  return c.body(null, 204);
});

adminRoutes.post('/licenses/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const license = await c.env.DB.prepare('SELECT status FROM licenses WHERE id = ?').bind(id).first<{ status: string }>();
  if (!license) return jsonError(c, 404, 'License not found');
  await c.env.DB.prepare("UPDATE licenses SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  await writeAudit(c.env.DB, 'license.revoked', { licenseId: id, targetType: 'license', targetId: id, details: { previous_status: license.status } });
  return c.json({ success: true, status: 'revoked' });
});

adminRoutes.post('/licenses/:id/reactivate', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return jsonError(c, 400, 'Invalid license id');
  const license = await c.env.DB.prepare('SELECT status, current_period_end, is_banned FROM licenses WHERE id = ?').bind(id).first<{ status: string; current_period_end: string | null; is_banned: number }>();
  if (!license) return jsonError(c, 404, 'License not found');
  if (license.is_banned) return jsonError(c, 409, 'Banned accounts must be unbanned before reactivation');
  if (!license.current_period_end || new Date(license.current_period_end).getTime() <= Date.now()) return jsonError(c, 409, 'Expired licenses cannot be reactivated');
  await c.env.DB.prepare("UPDATE licenses SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
  await writeAudit(c.env.DB, 'license.reactivated', { licenseId: id, targetType: 'license', targetId: id, details: { previous_status: license.status } });
  return c.json({ success: true, status: 'active' });
});

adminRoutes.get('/audit-logs', async (c) => {
  const result = await c.env.DB.prepare('SELECT id, action, license_id, target_type, target_id, details, created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT 200').all();
  return c.json({ logs: result.results });
});

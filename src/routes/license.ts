import { Hono } from 'hono';
import type { AppContext, LicenseRecord, Platform } from '../types';
import { findLicenseByEmail, findLicenseByKey } from '../db/queries';
import { daysRemaining, isActive, jsonError, isoNow } from '../utils/http';
import { verifyTurnstile } from '../utils/turnstile';
import { signJwt } from '../utils/jwt';
import { checkRateLimit, createRateLimit } from '../middleware/rate-limit';

export const licenseRoutes = new Hono<AppContext>();
licenseRoutes.use('/check', checkRateLimit);
licenseRoutes.use('/activate', createRateLimit({ scope: 'license-activate', maxRequests: 20, windowSeconds: 60 }));

function normalizeDeviceHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function normalizeDeviceName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 100) : null;
}

function publicLicense(license: LicenseRecord, refId = license.email, now = new Date()) {
  const active = isActive(license.current_period_end, license.status, now);
  return { refId, license_key: license.key, status: active ? 'active' : license.status === 'revoked' ? 'revoked' : 'expired', current_period_end: license.current_period_end, days_remaining: daysRemaining(license.current_period_end, now), plan_type: license.plan_type };
}

licenseRoutes.post('/check', async (c) => {
  const body = await c.req.json<{ ref_id?: string; turnstile_token?: string }>().catch(() => ({} as { ref_id?: string; turnstile_token?: string }));
  const refId = body.ref_id?.trim();
  if (!refId || refId.length < 8 || refId.length > 128) return jsonError(c, 400, 'A valid reference ID is required');
  if (!(await verifyTurnstile(body.turnstile_token, c.req.header('CF-Connecting-IP'), c.env))) return jsonError(c, 403, 'Turnstile verification failed');
  const transaction = await c.env.DB.prepare('SELECT email, refId FROM transactions WHERE refId = ? ORDER BY created_at DESC LIMIT 1').bind(refId).first<{ email: string; refId: string }>();
  const license = transaction ? await findLicenseByEmail(c.env.DB, transaction.email) : null;
  return c.json({ licenses: license && transaction ? [publicLicense(license, transaction.refId)] : [] });
});

licenseRoutes.post('/activate', async (c) => {
  const body = await c.req.json<{ license_key?: string; device_hash?: string; platform?: Platform; device_name?: string }>().catch(() => ({} as { license_key?: string; device_hash?: string; platform?: Platform; device_name?: string }));
  const key = body.license_key?.trim().toUpperCase();
  const deviceHash = normalizeDeviceHash(body.device_hash);
  const deviceName = normalizeDeviceName(body.device_name);
  if (!key || !deviceHash || !['android', 'web'].includes(body.platform ?? '')) return jsonError(c, 400, 'license_key, device_hash (SHA-256), and platform are required');
  if (body.device_name !== undefined && deviceName === null) return jsonError(c, 400, 'device_name must be a valid string');
  if (!c.env.JWT_SECRET) return jsonError(c, 500, 'JWT_SECRET is not configured');
  const license = await findLicenseByKey(c.env.DB, key);
  if (!license) return jsonError(c, 404, 'License not found');
  if (!isActive(license.current_period_end, license.status)) return jsonError(c, 403, 'License is not active');
  const existing = await c.env.DB.prepare('SELECT id FROM activations WHERE license_id = ? AND device_hash = ?').bind(license.id, deviceHash).first<{ id: number }>();
  let slotUsed: number;
  if (existing) {
    await c.env.DB.prepare('UPDATE activations SET last_seen = ?, platform = ?, device_name = ? WHERE id = ?').bind(isoNow(), body.platform as Platform, deviceName, existing.id).run();
    slotUsed = (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM activations WHERE license_id = ?').bind(license.id).first<{ count: number }>())?.count ?? 1;
  } else {
    // The conditional INSERT is evaluated atomically by SQLite/Turso, so two
    // concurrent first-time activations cannot both consume the last slot.
    const inserted = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO activations(license_id, device_hash, device_name, platform) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM activations WHERE license_id = ?) < ?'
    ).bind(license.id, deviceHash, deviceName, body.platform as Platform, license.id, license.max_devices).run();
    if (!inserted.meta.changes) {
      const raced = await c.env.DB.prepare('SELECT id FROM activations WHERE license_id = ? AND device_hash = ?').bind(license.id, deviceHash).first<{ id: number }>();
      if (!raced) {
        const used = (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM activations WHERE license_id = ?').bind(license.id).first<{ count: number }>())?.count ?? license.max_devices;
        return jsonError(c, 409, 'Maximum device limit reached', { max_devices: license.max_devices, used_devices: used });
      }
      await c.env.DB.prepare('UPDATE activations SET last_seen = ?, platform = ?, device_name = ? WHERE id = ?').bind(isoNow(), body.platform as Platform, deviceName, raced.id).run();
    }
    slotUsed = (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM activations WHERE license_id = ?').bind(license.id).first<{ count: number }>())?.count ?? 1;
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: license.key, role: 'license', device_hash: deviceHash, iat: now, exp: now + 24 * 60 * 60 }, c.env.JWT_SECRET);
  return c.json({ success: true, message: 'Device activated successfully', device_slot_used: slotUsed, max_devices: license.max_devices, expires_at: license.current_period_end, token });
});

licenseRoutes.get('/validate', async (c) => {
  const key = c.req.query('license_key')?.trim().toUpperCase();
  const deviceHash = normalizeDeviceHash(c.req.query('device_hash'));
  if (!key || !deviceHash) return jsonError(c, 400, 'license_key and device_hash (SHA-256) are required');
  const license = await findLicenseByKey(c.env.DB, key);
  if (!license) return c.json({ valid: false, status: 'not_found', expires_at: null, days_remaining: 0 });
  const activation = await c.env.DB.prepare('SELECT id FROM activations WHERE license_id = ? AND device_hash = ?').bind(license.id, deviceHash).first<{ id: number }>();
  const active = Boolean(activation) && isActive(license.current_period_end, license.status);
  const response = { valid: active, status: active ? 'active' : license.status === 'revoked' ? 'revoked' : 'expired', expires_at: license.current_period_end, days_remaining: daysRemaining(license.current_period_end), plan_type: license.plan_type };
  if (activation) await c.env.DB.prepare('UPDATE activations SET last_seen = ? WHERE id = ?').bind(isoNow(), activation.id).run();
  return c.json(response);
});

import { describe, expect, it } from 'vitest';
import { formatLicenseKey } from '../src/utils/license-key';
import { daysRemaining, endOfDayInTimezone, isActive, normalizeCustomerName, normalizePhone, parseTimestamp } from '../src/utils/http';
import { signJwt, verifyJwt } from '../src/utils/jwt';
import { sha256Hex } from '../src/utils/signature';
import { decryptMerchantKey, encryptMerchantKey } from '../src/utils/merchant-key';
import { resolveMaxDevices } from '../src/utils/entitlement';

describe('license utilities', () => {
  it('formats a license key in four groups', () => expect(formatLicenseKey(new Uint8Array(16))).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/));
  it('calculates remaining days rounded up', () => expect(daysRemaining('2026-08-25T00:00:00.000Z', new Date('2026-08-24T12:00:00.000Z'))).toBe(1));
  it('treats SQLite timestamps without a timezone as UTC', () => {
    const parsed = parseTimestamp('2026-08-27 00:00:00');
    expect(parsed?.toISOString()).toBe('2026-08-27T00:00:00.000Z');
    expect(isActive('2026-08-27 00:00:00', 'active', new Date('2026-08-26T23:59:59.000Z'))).toBe(true);
  });
  it('normalizes customer names from Lynk', () => expect(normalizeCustomerName('  Budi   Santoso  ')).toBe('Budi Santoso'));
  it('normalizes Indonesian phone numbers for account matching', () => expect(normalizePhone('0812-3456-7890')).toBe('6281234567890'));
  it('converts date-only expiry to the configured timezone', () => expect(endOfDayInTimezone('2026-08-27', 'Asia/Jakarta')).toBe('2026-08-27T16:59:59.999Z'));
  it('signs and verifies jwt claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt({ sub: 'admin', role: 'admin', iat: now, exp: now + 300 }, 'secret');
    expect((await verifyJwt(token, 'secret'))?.sub).toBe('admin');
    expect(await verifyJwt(token, 'wrong')).toBeNull();
  });
  it('creates the Lynk signature input digest', async () => expect(await sha256Hex('50000abc123messagekey')).toHaveLength(64));
  it('encrypts and decrypts merchant keys', async () => {
    const encrypted = await encryptMerchantKey('merchant-key', 'master-secret');
    expect(encrypted).not.toContain('merchant-key');
    expect(await decryptMerchantKey(encrypted, 'master-secret')).toBe('merchant-key');
  });
  it('stacks the highest active product device limit and resets after expiry', () => {
    let maxDevices = resolveMaxDevices(1, 1, false); // P1 starts the license.
    maxDevices = resolveMaxDevices(maxDevices, 1, true); // P2 renews at the same tier.
    maxDevices = resolveMaxDevices(maxDevices, 3, true); // P3 upgrades the active period.
    expect(maxDevices).toBe(3);
    expect(resolveMaxDevices(maxDevices, 1, false)).toBe(1); // Expired, then a new P1 cycle.
  });
});

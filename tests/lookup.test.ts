import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

function createMockDb(license: Record<string, unknown> | null) {
  return {
    prepare: (_query: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => license,
        all: async () => ({ results: license ? [license] : [] }),
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  } as any;
}

describe('POST /license/lookup', () => {
  it('returns 400 when email is invalid', async () => {
    const res = await app.request('/license/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invalid-email' }),
    }, {
      DB: createMockDb(null),
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('A valid email is required');
  });

  it('returns null license when email is not found in database', async () => {
    const res = await app.request('/license/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'notfound@example.com' }),
    }, {
      DB: createMockDb(null),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { license: unknown };
    expect(data.license).toBeNull();
  });

  it('returns masked license key when active license is found', async () => {
    const mockLicense = {
      id: 1,
      name: 'Budi Santoso',
      email: 'budi@example.com',
      key: 'A1B2-C3D4-E5F6-G7H8',
      status: 'active',
      current_period_end: '2026-12-31T23:59:59.000Z',
      plan_type: 'Bimonthly',
      access_type: 'paid',
      is_banned: 0,
      trial_ends_at: null,
      max_devices: 2,
    };

    const res = await app.request('/license/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'budi@example.com' }),
    }, {
      DB: createMockDb(mockLicense),
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { license: Record<string, unknown> };
    expect(data.license).not.toBeNull();
    expect(data.license.name).toBe('Budi Santoso');
    expect(data.license.status).toBe('active');
    expect(data.license.plan_type).toBe('Bimonthly');
    // Ensure the key is masked, NOT plain text
    expect(data.license.license_key).toBe('A1B2-****-****-G7H8');
  });
});

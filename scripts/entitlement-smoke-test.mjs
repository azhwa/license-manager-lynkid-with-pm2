import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const baseUrl = (process.env.API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const localEnv = Object.assign({}, ...['.env'].filter((file) => fs.existsSync(file)).map((file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith('#') && line.includes('=')).map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }))));
const merchantKey = process.env.LYNK_MERCHANT_KEY || localEnv.LYNK_MERCHANT_KEY;
const username = process.env.ADMIN_USERNAME || localEnv.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD || localEnv.ADMIN_PASSWORD;
if (!merchantKey || !username || !password) throw new Error('Set LYNK_MERCHANT_KEY, ADMIN_USERNAME, and ADMIN_PASSWORD before running the entitlement smoke test');
if (process.env.SMOKE_TEST_ALLOW_WRITE !== 'true') throw new Error('This smoke test writes real license data. Set SMOKE_TEST_ALLOW_WRITE=true explicitly.');

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const login = await call('/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
assert.equal(login.response.status, 200);
const auth = { Authorization: `Bearer ${login.body.token}` };
const runId = Date.now();
const email = `entitlement-${runId}@example.com`;
const mappings = [
  { title_pattern: `Smoke P1 ${runId}`, duration_days: 30, plan_type: 'monthly', max_devices: 1, is_active: true },
  { title_pattern: `Smoke P2 ${runId}`, duration_days: 60, plan_type: 'bimonthly', max_devices: 1, is_active: true },
  { title_pattern: `Smoke P3 ${runId}`, duration_days: 365, plan_type: 'bimonthly', max_devices: 3, is_active: true }
];
const mappingIds = [];
let license = null;

try {
  for (const mapping of mappings) {
    const created = await call('/admin/mapping', { method: 'POST', headers: auth, body: JSON.stringify(mapping) });
    assert.equal(created.response.status, 201);
    mappingIds.push(created.body.mapping.id);
  }

  let previousEnd = null;
  for (const [index, mapping] of mappings.entries()) {
    const messageId = `entitlement-${runId}-${index}`;
    const refId = `entitlement-ref-${runId}-${index}`;
    const payload = { event: 'payment.received', data: { message_action: 'SUCCESS', message_code: '0', message_data: { customer: { name: `Smoke Customer ${runId}`, email }, items: [{ title: mapping.title_pattern, price: 10000, qty: 1 }], refId, totals: { grandTotal: 10000 }, message_id: messageId } } };
    const rawPayload = JSON.stringify(payload);
    const signature = crypto.createHash('sha256').update(`10000${refId}${messageId}${merchantKey}`).digest('hex');
    const webhook = await call('/webhook/lynkid', { method: 'POST', headers: { 'X-Lynk-Signature': signature }, body: rawPayload });
    assert.equal(webhook.response.status, 200);

    const result = await call(`/admin/licenses?email=${encodeURIComponent(email)}`, { headers: auth });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.licenses.length, 1);
    license = result.body.licenses[0];
    assert.equal(license.max_devices, index === 2 ? 3 : 1);
    if (previousEnd) assert.ok(new Date(license.current_period_end).getTime() > new Date(previousEnd).getTime());
    previousEnd = license.current_period_end;
  }
} finally {
  for (const id of mappingIds) await call(`/admin/mapping/${id}`, { method: 'DELETE', headers: auth });
}

console.log(JSON.stringify({ ok: true, email, license_id: license?.id, max_devices_after_p1_p2_p3: license?.max_devices }, null, 2));

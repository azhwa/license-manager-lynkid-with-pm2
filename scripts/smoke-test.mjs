import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const baseUrl = (process.env.API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const localEnv = Object.assign({}, ...['.env', '.dev.vars'].filter((file) => fs.existsSync(file)).map((file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line && !line.trimStart().startsWith('#') && line.includes('=')).map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }))));
const merchantKey = process.env.LYNK_MERCHANT_KEY || localEnv.LYNK_MERCHANT_KEY;
const username = process.env.ADMIN_USERNAME || localEnv.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD || localEnv.ADMIN_PASSWORD;
if (!merchantKey || !username || !password) throw new Error('Set LYNK_MERCHANT_KEY, ADMIN_USERNAME, and ADMIN_PASSWORD before running smoke test');
const email = `smoke-${Date.now()}@example.com`;
const messageId = `smoke-${Date.now()}`;

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const health = await call('/health');
assert.equal(health.response.status, 200);

const login = await call('/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
assert.equal(login.response.status, 200);
assert.ok(login.body.token);
const auth = { Authorization: `Bearer ${login.body.token}` };

const mappings = await call('/admin/mapping', { headers: auth });
assert.equal(mappings.response.status, 200);
assert.ok(mappings.body.mappings.length > 0);
const selectedMapping = mappings.body.mappings.find((mapping) => mapping.title_pattern === 'Aplikasi Autogas 2 Bulan') || mappings.body.mappings[0];
const maxDevices = Number(selectedMapping.max_devices);
assert.ok(Number.isInteger(maxDevices) && maxDevices > 0);

const payload = {
  event: 'payment.received',
  data: {
    message_action: 'SUCCESS',
    message_code: '0',
    message_data: {
      customer: { email },
      items: [{ title: 'Aplikasi Autogas 2 Bulan', price: 50000, qty: 1 }],
      refId: `ref-${messageId}`,
      totals: { grandTotal: 50000 }
    },
    message_id: messageId
  }
};
const rawPayload = JSON.stringify(payload);
const signature = crypto.createHash('sha256').update(`50000ref-${messageId}${messageId}${merchantKey}`).digest('hex');
const webhook = await call('/webhook/lynkid', { method: 'POST', headers: { 'X-Lynk-Signature': signature }, body: rawPayload });
assert.equal(webhook.response.status, 200);
assert.equal(webhook.body.success, true);

const check = await call('/license/check', { method: 'POST', body: JSON.stringify({ ref_id: `ref-${messageId}` }) });
assert.equal(check.response.status, 200);
assert.equal(check.body.licenses.length, 1);
const key = check.body.licenses[0].license_key;
const deviceHash = (suffix) => crypto.createHash('sha256').update(`${messageId}:${suffix}`).digest('hex');

const activate = await call('/license/activate', { method: 'POST', body: JSON.stringify({ license_key: key, device_hash: deviceHash('1'), platform: 'web' }) });
assert.equal(activate.response.status, 200);
assert.equal(activate.body.success, true);

for (let index = 2; index <= maxDevices; index += 1) {
  const extraActivation = await call('/license/activate', { method: 'POST', body: JSON.stringify({ license_key: key, device_hash: deviceHash(String(index)), platform: index % 2 === 0 ? 'android' : 'web' }) });
  assert.equal(extraActivation.response.status, 200);
}
const overLimit = await call('/license/activate', { method: 'POST', body: JSON.stringify({ license_key: key, device_hash: deviceHash('over-limit'), platform: 'web' }) });
assert.equal(overLimit.response.status, 409);

const licenseList = await call(`/admin/licenses?email=${encodeURIComponent(email)}`, { headers: auth });
assert.equal(licenseList.response.status, 200);
assert.equal(licenseList.body.licenses.length, 1);
const licenseId = licenseList.body.licenses[0].id;
const activationList = await call(`/admin/licenses/${licenseId}/activations`, { headers: auth });
assert.equal(activationList.response.status, 200);
assert.equal(activationList.body.activations.length, maxDevices);
const unbind = await call(`/admin/licenses/${licenseId}/activations/${activationList.body.activations[0].id}`, { method: 'DELETE', headers: auth });
assert.equal(unbind.response.status, 204);
const rebound = await call('/license/activate', { method: 'POST', body: JSON.stringify({ license_key: key, device_hash: deviceHash('1'), platform: 'web' }) });
assert.equal(rebound.response.status, 200);

const validate = await call(`/license/validate?license_key=${encodeURIComponent(key)}&device_hash=${deviceHash('1')}`);
assert.equal(validate.response.status, 200);
assert.equal(validate.body.valid, true);
const revoke = await call(`/admin/licenses/${licenseId}/revoke`, { method: 'POST', headers: auth });
assert.equal(revoke.response.status, 200);
const revokedValidate = await call(`/license/validate?license_key=${encodeURIComponent(key)}&device_hash=${deviceHash('1')}`);
assert.equal(revokedValidate.response.status, 200);
assert.equal(revokedValidate.body.valid, false);
assert.equal(revokedValidate.body.status, 'revoked');
const reactivate = await call(`/admin/licenses/${licenseId}/reactivate`, { method: 'POST', headers: auth });
assert.equal(reactivate.response.status, 200);

const duplicate = await call('/webhook/lynkid', { method: 'POST', headers: { 'X-Lynk-Signature': signature }, body: rawPayload });
assert.equal(duplicate.response.status, 200);
assert.equal(duplicate.body.duplicate, true);
const invalidSignature = await call('/webhook/lynkid', { method: 'POST', headers: { 'X-Lynk-Signature': 'invalid' }, body: rawPayload });
assert.equal(invalidSignature.response.status, 401);

console.log(JSON.stringify({ ok: true, license_key: key, expires_at: validate.body.expires_at, device_limit: overLimit.response.status, replay_protected: duplicate.body.duplicate, invalid_signature: invalidSignature.response.status }, null, 2));

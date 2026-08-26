import type { JwtClaims } from '../types';

function base64Url(value: ArrayBuffer | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(normalized);
}
async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await getKey(secret), new TextEncoder().encode(data));
  return `${data}.${base64Url(signature)}`;
}
export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const valid = await crypto.subtle.verify('HMAC', await getKey(secret), Uint8Array.from(decodeBase64Url(signature), (char) => char.charCodeAt(0)), new TextEncoder().encode(`${header}.${payload}`));
    if (!valid) return null;
    const claims = JSON.parse(decodeBase64Url(payload)) as JwtClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch { return null; }
}

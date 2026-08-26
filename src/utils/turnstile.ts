import type { Env } from '../types';

export async function verifyTurnstile(token: unknown, remoteip: string | undefined, env: Env): Promise<boolean> {
  if (env.TURNSTILE_ENABLED !== 'true') return true;
  if (typeof token !== 'string' || !token || !env.TURNSTILE_SECRET_KEY) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (remoteip) body.set('remoteip', remoteip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    if (!response.ok) return false;
    const result = await response.json<{ success?: boolean }>();
    return result.success === true;
  } catch {
    return false;
  }
}

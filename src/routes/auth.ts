import { Hono } from 'hono';
import type { AppContext } from '../types';
import { signJwt } from '../utils/jwt';
import { jsonError } from '../utils/http';
import { createRateLimit } from '../middleware/rate-limit';
import { verifyTurnstile } from '../utils/turnstile';

export const authRoutes = new Hono<AppContext>();
authRoutes.use('/login', createRateLimit({ scope: 'admin-login', maxRequests: 5, windowSeconds: 900 }));

authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string; turnstile_token?: string }>().catch(() => ({} as { username?: string; password?: string; turnstile_token?: string }));
  const username = c.env.ADMIN_USERNAME;
  const password = c.env.ADMIN_PASSWORD;
  if (!username || !password || !c.env.JWT_SECRET) return jsonError(c, 500, 'Admin authentication is not configured');
  if (!(await verifyTurnstile(body.turnstile_token, c.req.header('CF-Connecting-IP'), c.env))) return jsonError(c, 403, 'Turnstile verification failed');
  if (body.username !== username || body.password !== password) return jsonError(c, 401, 'Invalid username or password');
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: username, role: 'admin', iat: now, exp: now + 8 * 60 * 60 }, c.env.JWT_SECRET);
  return c.json({ token, expires_in: 8 * 60 * 60, user: { username, role: 'admin' } });
});

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from './types';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { licenseRoutes } from './routes/license';
import { webhookRoutes } from './routes/webhook';
import { jsonError } from './utils/http';

const app = new Hono<AppContext>();
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  const allowedOrigins = (c.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  return cors({ origin: (origin) => allowedOrigins.includes(origin) ? origin : null, allowHeaders: ['Content-Type', 'Authorization', 'X-Lynk-Signature'], allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] })(c, next);
});
app.get('/', (c) => c.json({ name: 'License Manager API', version: '0.1.0', status: 'ok' }));
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get('/health/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return c.json({ status: 'ok', database: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Readiness check failed', error);
    return c.json({ status: 'error', database: 'unavailable', timestamp: new Date().toISOString() }, 503);
  }
});
app.route('/admin', authRoutes);
app.route('/admin', adminRoutes);
app.route('/license', licenseRoutes);
app.route('/webhook', webhookRoutes);
app.notFound((c) => jsonError(c, 404, 'Route not found'));
app.onError((error, c) => { console.error(error); return jsonError(c, 500, 'Internal server error'); });

export async function runMaintenance(env: AppContext['Bindings']): Promise<void> {
  await env.DB.prepare("UPDATE licenses SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND current_period_end <= CURRENT_TIMESTAMP").run();
  await env.DB.prepare("DELETE FROM webhook_logs WHERE created_at < datetime('now', '-30 days')").run();
}
export { app };

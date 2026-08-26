import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app, runMaintenance } from '../index';
import { createNodeRuntime } from './env';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');

const { env, database } = await createNodeRuntime(process.env);
const server = serve({
  fetch: (request) => app.fetch(request, env),
  hostname: host,
  port,
}, (info) => {
  console.log(`License Manager API listening on http://${info.address}:${info.port}`);
  console.log(`Turso database: ${process.env.TURSO_DATABASE_URL}`);
});

const maintenanceTimer = setInterval(() => {
  runMaintenance(env).catch((error) => console.error('Scheduled maintenance failed', error));
}, 24 * 60 * 60 * 1000);
maintenanceTimer.unref();
runMaintenance(env).catch((error) => console.error('Initial maintenance failed', error));

function shutdown(signal: string): void {
  console.log(`${signal} received; shutting down`);
  clearInterval(maintenanceTimer);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

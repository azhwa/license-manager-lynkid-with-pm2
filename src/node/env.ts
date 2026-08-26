import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { MemoryKVNamespace, NodeD1Database } from './db';

function required(values: NodeJS.ProcessEnv, name: string): string {
  const value = values[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function createNodeRuntime(values: NodeJS.ProcessEnv) {
  const turnstileEnabled = (values.TURNSTILE_ENABLED ?? 'true').trim().toLowerCase();
  if (!['true', 'false'].includes(turnstileEnabled)) throw new Error('TURNSTILE_ENABLED must be true or false');
  if (turnstileEnabled === 'true') required(values, 'TURNSTILE_SECRET_KEY');

  const databaseUrl = required(values, 'TURSO_DATABASE_URL');
  const databaseToken = required(values, 'TURSO_AUTH_TOKEN');
  const database = await NodeD1Database.open(databaseUrl, databaseToken);
  const env: Env = {
    DB: database as unknown as D1Database,
    KV_CACHE: new MemoryKVNamespace() as unknown as KVNamespace,
    LYNK_MERCHANT_KEY: values.LYNK_MERCHANT_KEY?.trim() || undefined,
    MERCHANT_CONFIG_ENCRYPTION_KEY: required(values, 'MERCHANT_CONFIG_ENCRYPTION_KEY'),
    JWT_SECRET: required(values, 'JWT_SECRET'),
    ADMIN_USERNAME: required(values, 'ADMIN_USERNAME'),
    ADMIN_PASSWORD: required(values, 'ADMIN_PASSWORD'),
    TURNSTILE_SECRET_KEY: values.TURNSTILE_SECRET_KEY?.trim() || '',
    TURNSTILE_ENABLED: turnstileEnabled,
    CORS_ORIGIN: required(values, 'CORS_ORIGIN'),
  };
  return { env, database };
}

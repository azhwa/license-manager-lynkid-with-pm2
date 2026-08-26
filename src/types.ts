import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export type PlanType = 'trial' | 'monthly' | 'bimonthly' | 'yearly';
export type LicenseStatus = 'active' | 'expired' | 'revoked';
export type Platform = 'android' | 'web';

export interface Env {
  DB: D1Database;
  KV_CACHE: KVNamespace;
  LYNK_MERCHANT_KEY?: string;
  MERCHANT_CONFIG_ENCRYPTION_KEY?: string;
  JWT_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_ENABLED: string;
  CORS_ORIGIN: string;
}

export interface LynkPayload {
  event?: string;
  data?: {
    message_action?: string;
    message_code?: string;
    message_data?: {
      createdAt?: string;
      customer?: { email?: string; name?: string; phone?: string };
      items?: Array<{ title?: string; price?: number; qty?: number; uuid?: string }>;
      refId?: string;
      totals?: { grandTotal?: number };
      message_id?: string;
    };
    message_id?: string;
  };
}

export interface LicenseRecord {
  id: number;
  email: string;
  key: string;
  plan_type: PlanType;
  status: LicenseStatus;
  current_period_end: string | null;
  trial_ends_at: string | null;
  max_devices: number;
  created_at: string;
  updated_at: string;
}

export interface JwtClaims {
  sub: string;
  role: 'admin' | 'license';
  iat: number;
  exp: number;
  device_hash?: string;
}

export interface AppContext {
  Bindings: Env;
  Variables: { claims?: JwtClaims };
}

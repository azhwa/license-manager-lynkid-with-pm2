export type PlanType = string;
export type LicenseStatus = 'active' | 'expired' | 'revoked';
export type Platform = 'android' | 'web';

export type DatabaseValue = string | number | bigint | Uint8Array | null | boolean | Date;

export interface PreparedStatementBinding {
  bind(...values: DatabaseValue[]): PreparedStatementBinding;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface DatabaseBinding {
  prepare(sql: string): PreparedStatementBinding;
  batch(statements: PreparedStatementBinding[]): Promise<unknown[]>;
}

export interface Env {
  DB: DatabaseBinding;
  APP_TIMEZONE?: string;
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
      message_action?: string;
      createdAt?: string;
      customer?: { email?: string; name?: string; phone?: string };
      items?: Array<{ title?: string; price?: number; qty?: number; uuid?: string }>;
      refId?: string;
      totals?: { grandTotal?: number | string };
      message_id?: string;
    };
    message_id?: string;
  };
}

export interface LicenseRecord {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  key: string;
  plan_type: PlanType;
  access_type: 'trial' | 'paid';
  status: LicenseStatus;
  is_banned: number;
  current_period_end: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_used_at: string | null;
  converted_at: string | null;
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

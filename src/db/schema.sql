PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT,
  phone TEXT,
  key TEXT UNIQUE NOT NULL,
  plan_type TEXT NOT NULL,
  access_type TEXT NOT NULL DEFAULT 'paid' CHECK (access_type IN ('trial', 'paid')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1)),
  current_period_end TEXT,
  trial_started_at TEXT,
  trial_ends_at TEXT,
  trial_used_at TEXT,
  converted_at TEXT,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);

CREATE TABLE IF NOT EXISTS banned_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT,
  license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL,
  reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  banned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unbanned_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_accounts_email ON banned_accounts(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_accounts_phone ON banned_accounts(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  device_name TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'web')),
  activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(license_id, device_hash)
);
CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id);

CREATE TABLE IF NOT EXISTS lynk_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  merchant_key_ciphertext TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lynk_accounts_active ON lynk_accounts(is_active);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  refId TEXT NOT NULL,
  email TEXT NOT NULL,
  gateway TEXT NOT NULL DEFAULT 'lynkid',
  product_title TEXT NOT NULL,
  amount INTEGER NOT NULL,
  duration_days_applied INTEGER NOT NULL,
  previous_period_end TEXT,
  new_period_end TEXT NOT NULL,
  renewal_type TEXT NOT NULL CHECK (renewal_type IN ('new', 'stacked', 'reactivated', 'converted')),
  is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1)),
  signature_verified INTEGER NOT NULL DEFAULT 1,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transactions_email ON transactions(email);
CREATE INDEX IF NOT EXISTS idx_transactions_refId ON transactions(refId);

CREATE TABLE IF NOT EXISTS trial_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT,
  license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL,
  message_id TEXT UNIQUE NOT NULL,
  refId TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_claims_email ON trial_claims(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_claims_phone ON trial_claims(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_pattern TEXT UNIQUE NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  plan_type TEXT NOT NULL,
  is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_mapping_active ON product_mapping(is_active);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  raw_payload TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_message_id ON webhook_logs(message_id);

INSERT OR IGNORE INTO product_mapping(title_pattern, duration_days, plan_type, is_trial)
VALUES ('Aplikasi Autogas 2 Bulan', 60, 'bimonthly', 0);

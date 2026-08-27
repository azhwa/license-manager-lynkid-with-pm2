-- Enforce one Trial claim per customer identity and distinguish Trial access.
ALTER TABLE licenses ADD COLUMN access_type TEXT NOT NULL DEFAULT 'paid' CHECK (access_type IN ('trial', 'paid'));
ALTER TABLE licenses ADD COLUMN trial_started_at TEXT;
ALTER TABLE licenses ADD COLUMN trial_used_at TEXT;
ALTER TABLE licenses ADD COLUMN converted_at TEXT;
ALTER TABLE transactions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1));
ALTER TABLE product_mapping ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1));

-- Existing installations have a CHECK constraint without `converted`.
PRAGMA foreign_keys = OFF;
CREATE TABLE transactions_trial_upgrade (
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lynk_account_id INTEGER REFERENCES lynk_accounts(id)
);
INSERT INTO transactions_trial_upgrade(id, message_id, refId, email, gateway, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, is_trial, signature_verified, raw_payload, created_at, lynk_account_id)
SELECT id, message_id, refId, email, gateway, product_title, amount, duration_days_applied, previous_period_end, new_period_end, renewal_type, is_trial, signature_verified, raw_payload, created_at, lynk_account_id FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_trial_upgrade RENAME TO transactions;
CREATE INDEX IF NOT EXISTS idx_transactions_email ON transactions(email);
CREATE INDEX IF NOT EXISTS idx_transactions_refId ON transactions(refId);
CREATE INDEX IF NOT EXISTS idx_transactions_lynk_account ON transactions(lynk_account_id);
PRAGMA foreign_keys = ON;

UPDATE product_mapping SET is_trial = 1 WHERE lower(plan_type) = 'trial';
UPDATE licenses
SET access_type = 'trial',
    trial_started_at = COALESCE(trial_started_at, created_at),
    trial_ends_at = COALESCE(trial_ends_at, current_period_end),
    trial_used_at = COALESCE(trial_used_at, created_at)
WHERE lower(plan_type) = 'trial';

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
INSERT OR IGNORE INTO trial_claims(email, license_id, message_id, refId, claimed_at)
SELECT email, id, 'migration:license:' || id, email, COALESCE(trial_used_at, created_at)
FROM licenses WHERE access_type = 'trial';

CREATE TABLE IF NOT EXISTS lynk_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  merchant_key_ciphertext TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE transactions ADD COLUMN lynk_account_id INTEGER REFERENCES lynk_accounts(id);
ALTER TABLE webhook_logs ADD COLUMN lynk_account_id INTEGER REFERENCES lynk_accounts(id);

CREATE INDEX IF NOT EXISTS idx_lynk_accounts_active ON lynk_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_transactions_lynk_account ON transactions(lynk_account_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_lynk_account ON webhook_logs(lynk_account_id);

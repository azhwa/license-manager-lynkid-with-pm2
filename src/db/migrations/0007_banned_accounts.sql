-- Allow administrators to remove an entitlement or block an account permanently.
ALTER TABLE licenses ADD COLUMN phone TEXT;
ALTER TABLE licenses ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1));

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

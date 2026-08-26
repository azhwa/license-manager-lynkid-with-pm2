ALTER TABLE product_mapping ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0);

-- Existing one- and two-month products use the one-device tier.
UPDATE product_mapping
SET max_devices = 1
WHERE lower(title_pattern) LIKE '%1 bulan%'
   OR lower(title_pattern) LIKE '%2 bulan%';

-- Apply the three-device tier when the existing catalog already contains a
-- one-year Auto Gas product. Missing products remain configurable in Admin.
UPDATE product_mapping
SET max_devices = 3
WHERE lower(title_pattern) LIKE '%1 tahun%'
   OR lower(title_pattern) LIKE '%12 bulan%';

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  license_id INTEGER REFERENCES licenses(id) ON DELETE SET NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_license ON admin_audit_logs(license_id);

-- Existing licenses no longer depend on the removed environment default.
-- Their active entitlement is recalculated from matched purchases; if no
-- matching mapping exists, use the one-device baseline.
UPDATE licenses
SET max_devices = COALESCE((
  SELECT MAX(pm.max_devices)
  FROM transactions t
  JOIN product_mapping pm ON t.product_title LIKE '%' || pm.title_pattern || '%'
  WHERE t.email = licenses.email
    AND t.new_period_end > CURRENT_TIMESTAMP
), 1);

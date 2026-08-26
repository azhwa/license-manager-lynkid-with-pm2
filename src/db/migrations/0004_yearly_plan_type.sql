-- Expand the product plan enum for the one-year product tier.
CREATE TABLE product_mapping_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_pattern TEXT UNIQUE NOT NULL,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  plan_type TEXT NOT NULL CHECK (plan_type IN ('trial', 'monthly', 'bimonthly', 'yearly')),
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO product_mapping_new(id, title_pattern, duration_days, plan_type, max_devices, is_active, created_at)
SELECT id, title_pattern, duration_days, plan_type, max_devices, is_active, created_at
FROM product_mapping;

DROP TABLE product_mapping;
ALTER TABLE product_mapping_new RENAME TO product_mapping;
CREATE INDEX IF NOT EXISTS idx_product_mapping_active ON product_mapping(is_active);

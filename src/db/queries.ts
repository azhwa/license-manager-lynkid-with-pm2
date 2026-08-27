import type { DatabaseBinding, LicenseRecord, PlanType } from '../types';

export async function findLicenseByEmail(db: DatabaseBinding, email: string): Promise<LicenseRecord | null> {
  return db.prepare('SELECT * FROM licenses WHERE email = ? COLLATE NOCASE LIMIT 1').bind(email).first<LicenseRecord>();
}
export async function findLicenseByKey(db: DatabaseBinding, key: string): Promise<LicenseRecord | null> {
  return db.prepare('SELECT * FROM licenses WHERE key = ? LIMIT 1').bind(key.toUpperCase()).first<LicenseRecord>();
}
export async function getMapping(db: DatabaseBinding, title: string): Promise<{ duration_days: number; plan_type: PlanType; max_devices: number; is_trial: number } | null> {
  return db.prepare("SELECT duration_days, plan_type, max_devices, is_trial FROM product_mapping WHERE is_active = 1 AND ? LIKE '%' || title_pattern || '%' ORDER BY LENGTH(title_pattern) DESC LIMIT 1").bind(title).first<{ duration_days: number; plan_type: PlanType; max_devices: number; is_trial: number }>();
}

import type { D1Database } from '@cloudflare/workers-types';

export async function writeAudit(
  db: D1Database,
  action: string,
  options: { licenseId?: number | null; targetType?: string; targetId?: string | number; details?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO admin_audit_logs(action, license_id, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      action,
      options.licenseId ?? null,
      options.targetType ?? null,
      options.targetId === undefined ? null : String(options.targetId),
      options.details ? JSON.stringify(options.details) : null
    ).run();
  } catch {
    // Audit logging must not make the primary admin operation fail.
  }
}

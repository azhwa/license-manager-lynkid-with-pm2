import 'dotenv/config';
import { TursoDatabase } from './db';

const databaseUrl = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!databaseUrl || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');

const database = await TursoDatabase.open(databaseUrl, authToken);
try {
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
  const countTables = ['licenses', 'activations', 'transactions', 'trial_claims', 'banned_accounts', 'product_mapping', 'webhook_logs', 'lynk_accounts', 'admin_audit_logs'] as const;
  const counts = await Promise.all(countTables.map(async (table) => [table, (await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())?.count ?? 0] as const));
  console.log(JSON.stringify({
    migrated: true,
    database: databaseUrl,
    tables: tables.results.map((table) => table.name),
    counts: Object.fromEntries(counts),
  }, null, 2));
} finally {
  database.close();
}

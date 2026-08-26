import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

const exportFile = process.argv[2] || '.d1-data-export.sql';
const databaseUrl = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
if (!databaseUrl || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');

const dataStatements = readFileSync(exportFile, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.startsWith('PRAGMA defer_foreign_keys') && !line.startsWith('INSERT INTO "d1_migrations"') && !line.startsWith('INSERT INTO "sqlite_sequence"'));

const client = createClient({ url: databaseUrl, authToken, intMode: 'number', readYourWrites: true, concurrency: 8 });
try {
  await client.batch([
    { sql: 'PRAGMA defer_foreign_keys=TRUE' },
    ...dataStatements.map((sql) => ({ sql })),
  ], 'write');
  console.log(JSON.stringify({ imported: true, database: databaseUrl, statements: dataStatements.length }, null, 2));
} finally {
  client.close();
}

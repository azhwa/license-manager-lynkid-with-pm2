import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type Client, type InStatement, type InValue, type Row } from '@libsql/client';

type BoundValue = InValue;

function rowAsObject(row: Row): Record<string, unknown> {
  // libSQL rows expose named properties, matching the object shape returned by D1.
  return row as unknown as Record<string, unknown>;
}

async function hasColumn(client: Client, table: string, column: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => row[1] === column || row.name === column);
}

async function ensureCurrentSchema(client: Client): Promise<void> {
  if (!await hasColumn(client, 'transactions', 'lynk_account_id')) {
    await client.execute('ALTER TABLE transactions ADD COLUMN lynk_account_id INTEGER REFERENCES lynk_accounts(id)');
  }
  if (!await hasColumn(client, 'webhook_logs', 'lynk_account_id')) {
    await client.execute('ALTER TABLE webhook_logs ADD COLUMN lynk_account_id INTEGER REFERENCES lynk_accounts(id)');
  }
  if (!await hasColumn(client, 'product_mapping', 'max_devices')) {
    await client.execute('ALTER TABLE product_mapping ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0)');
  }

  await client.executeMultiple(`
    CREATE INDEX IF NOT EXISTS idx_lynk_accounts_active ON lynk_accounts(is_active);
    CREATE INDEX IF NOT EXISTS idx_transactions_lynk_account ON transactions(lynk_account_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_lynk_account ON webhook_logs(lynk_account_id);
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
  `);

  // Upgrade databases created by a Worker version whose CHECK constraint did
  // not yet include the yearly plan.
  const mappingResult = await client.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'product_mapping'");
  const mappingSql = mappingResult.rows[0]?.[0] ?? mappingResult.rows[0]?.sql;
  if (typeof mappingSql === 'string' && !mappingSql.includes("'yearly'")) {
    await client.executeMultiple(`
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
      SELECT id, title_pattern, duration_days,
        CASE WHEN plan_type IN ('trial', 'monthly', 'bimonthly', 'yearly') THEN plan_type ELSE 'monthly' END,
        max_devices, is_active, created_at
      FROM product_mapping;
      DROP TABLE product_mapping;
      ALTER TABLE product_mapping_new RENAME TO product_mapping;
      CREATE INDEX IF NOT EXISTS idx_product_mapping_active ON product_mapping(is_active);
    `);
  }
}

export class NodeD1PreparedStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly values: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.client, this.sql, values);
  }

  toInStatement(): InStatement {
    return { sql: this.sql, args: this.values };
  }

  async first<T>(): Promise<T | null> {
    const result = await this.client.execute(this.toInStatement());
    return result.rows.length ? rowAsObject(result.rows[0]) as T : null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const result = await this.client.execute(this.toInStatement());
    return { results: result.rows.map((row) => rowAsObject(row) as T) };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const result = await this.client.execute(this.toInStatement());
    return {
      meta: {
        changes: result.rowsAffected,
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

export class NodeD1Database {
  private constructor(private readonly client: Client) {}

  static async open(url: string, authToken: string): Promise<NodeD1Database> {
    const client = createClient({ url, authToken, intMode: 'number', readYourWrites: true, concurrency: 8 });
    try {
      const schemaPath = resolve(process.cwd(), 'src/db/schema.sql');
      await client.executeMultiple(readFileSync(schemaPath, 'utf8'));
      await ensureCurrentSchema(client);
      return new NodeD1Database(client);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  prepare(sql: string): NodeD1PreparedStatement {
    return new NodeD1PreparedStatement(this.client, sql);
  }

  async batch(statements: NodeD1PreparedStatement[]): Promise<unknown[]> {
    await this.client.batch(statements.map((statement) => statement.toInStatement()), 'write');
    return [];
  }

  close(): void {
    this.client.close();
  }
}

export class MemoryKVNamespace {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    const entry = this.values.get(key);
    if (!entry || (entry.expiresAt !== null && entry.expiresAt <= Date.now())) {
      this.values.delete(key);
      return null;
    }
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const ttl = options?.expirationTtl;
    this.values.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

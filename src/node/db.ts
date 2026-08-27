import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type Client, type InStatement, type Row } from '@libsql/client';
import type { DatabaseBinding, DatabaseValue, PreparedStatementBinding } from '../types';

type BoundValue = DatabaseValue;

function rowAsObject(row: Row): Record<string, unknown> {
  // libSQL rows expose named properties, matching the object shape used by routes.
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
  if (!await hasColumn(client, 'licenses', 'name')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN name TEXT');
  }
  if (!await hasColumn(client, 'licenses', 'access_type')) {
    await client.execute("ALTER TABLE licenses ADD COLUMN access_type TEXT NOT NULL DEFAULT 'paid' CHECK (access_type IN ('trial', 'paid'))");
  }
  if (!await hasColumn(client, 'licenses', 'trial_started_at')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN trial_started_at TEXT');
  }
  if (!await hasColumn(client, 'licenses', 'trial_used_at')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN trial_used_at TEXT');
  }
  if (!await hasColumn(client, 'licenses', 'converted_at')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN converted_at TEXT');
  }
  if (!await hasColumn(client, 'licenses', 'phone')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN phone TEXT');
  }
  if (!await hasColumn(client, 'licenses', 'is_banned')) {
    await client.execute('ALTER TABLE licenses ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1))');
  }
  if (!await hasColumn(client, 'transactions', 'is_trial')) {
    await client.execute('ALTER TABLE transactions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1))');
  }
  if (!await hasColumn(client, 'product_mapping', 'is_trial')) {
    await client.execute('ALTER TABLE product_mapping ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1))');
  }
  await client.executeMultiple(`
    UPDATE product_mapping SET is_trial = 1 WHERE lower(plan_type) = 'trial';
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
  `);

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

async function runSchemaMigrations(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const migrations: Array<{ version: number; name: string; apply: (database: Client) => Promise<void> }> = [
    { version: 1, name: 'baseline-current-schema', apply: ensureCurrentSchema },
    {
      version: 2,
      name: 'custom-plan-types',
      apply: async (database) => {
        const [licensesSql, mappingsSql] = await Promise.all([
          database.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'licenses'"),
          database.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'product_mapping'"),
        ]);
        const licensesDefinition = String(licensesSql.rows[0]?.[0] ?? licensesSql.rows[0]?.sql ?? '');
        const mappingsDefinition = String(mappingsSql.rows[0]?.[0] ?? mappingsSql.rows[0]?.sql ?? '');
        if (!licensesDefinition.includes('plan_type IN') && !mappingsDefinition.includes('plan_type IN')) return;

        await database.execute('PRAGMA foreign_keys = OFF');
        try {
          await database.executeMultiple(`
            CREATE TABLE licenses_custom_plan (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT UNIQUE NOT NULL COLLATE NOCASE,
              key TEXT UNIQUE NOT NULL,
              plan_type TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
              current_period_end TEXT,
              trial_ends_at TEXT,
              max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO licenses_custom_plan(id, email, key, plan_type, status, current_period_end, trial_ends_at, max_devices, created_at, updated_at)
              SELECT id, email, key, plan_type, status, current_period_end, trial_ends_at, max_devices, created_at, updated_at FROM licenses;
            DROP TABLE licenses;
            ALTER TABLE licenses_custom_plan RENAME TO licenses;
            CREATE INDEX IF NOT EXISTS idx_licenses_email ON licenses(email);
            CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
            CREATE TABLE product_mapping_custom_plan (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title_pattern TEXT UNIQUE NOT NULL,
              duration_days INTEGER NOT NULL CHECK (duration_days > 0),
              plan_type TEXT NOT NULL,
              max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO product_mapping_custom_plan(id, title_pattern, duration_days, plan_type, max_devices, is_active, created_at)
              SELECT id, title_pattern, duration_days, plan_type, max_devices, is_active, created_at FROM product_mapping;
            DROP TABLE product_mapping;
            ALTER TABLE product_mapping_custom_plan RENAME TO product_mapping;
            CREATE INDEX IF NOT EXISTS idx_product_mapping_active ON product_mapping(is_active);
          `);
        } finally {
          await database.execute('PRAGMA foreign_keys = ON');
        }
      },
    },
    {
      version: 3,
      name: 'license-customer-name',
      apply: async (database) => {
        if (!await hasColumn(database, 'licenses', 'name')) {
          await database.execute('ALTER TABLE licenses ADD COLUMN name TEXT');
        }
      },
    },
    {
      version: 4,
      name: 'trial-entitlements',
      apply: async (database) => {
        if (!await hasColumn(database, 'licenses', 'access_type')) await database.execute("ALTER TABLE licenses ADD COLUMN access_type TEXT NOT NULL DEFAULT 'paid' CHECK (access_type IN ('trial', 'paid'))");
        if (!await hasColumn(database, 'licenses', 'trial_started_at')) await database.execute('ALTER TABLE licenses ADD COLUMN trial_started_at TEXT');
        if (!await hasColumn(database, 'licenses', 'trial_used_at')) await database.execute('ALTER TABLE licenses ADD COLUMN trial_used_at TEXT');
        if (!await hasColumn(database, 'licenses', 'converted_at')) await database.execute('ALTER TABLE licenses ADD COLUMN converted_at TEXT');
        if (!await hasColumn(database, 'transactions', 'is_trial')) await database.execute('ALTER TABLE transactions ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1))');
        if (!await hasColumn(database, 'product_mapping', 'is_trial')) await database.execute('ALTER TABLE product_mapping ADD COLUMN is_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_trial IN (0, 1))');
        const transactionDefinition = await database.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'");
        const transactionSql = String(transactionDefinition.rows[0]?.[0] ?? transactionDefinition.rows[0]?.sql ?? '');
        if (transactionSql && !transactionSql.includes("'converted'")) {
          await database.execute('PRAGMA foreign_keys = OFF');
          try {
            await database.executeMultiple(`
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
            `);
          } finally {
            await database.execute('PRAGMA foreign_keys = ON');
          }
        }
        await database.executeMultiple(`
          UPDATE product_mapping SET is_trial = 1 WHERE lower(plan_type) = 'trial';
          UPDATE licenses
          SET access_type = 'trial', trial_started_at = COALESCE(trial_started_at, created_at),
              trial_ends_at = COALESCE(trial_ends_at, current_period_end), trial_used_at = COALESCE(trial_used_at, created_at)
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
        `);
      },
    },
    {
      version: 5,
      name: 'banned-accounts',
      apply: async (database) => {
        if (!await hasColumn(database, 'licenses', 'phone')) await database.execute('ALTER TABLE licenses ADD COLUMN phone TEXT');
        if (!await hasColumn(database, 'licenses', 'is_banned')) await database.execute('ALTER TABLE licenses ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0, 1))');
        await database.executeMultiple(`
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
        `);
      },
    },
  ];
  for (const migration of migrations) {
    const applied = await client.execute({
      sql: 'SELECT version FROM app_schema_migrations WHERE version = ?',
      args: [migration.version],
    });
    if (applied.rows.length) continue;
    await migration.apply(client);
    await client.execute({
      sql: 'INSERT OR IGNORE INTO app_schema_migrations(version, name) VALUES (?, ?)',
      args: [migration.version, migration.name],
    });
  }
}

export class TursoPreparedStatement implements PreparedStatementBinding {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly values: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]): TursoPreparedStatement {
    return new TursoPreparedStatement(this.client, this.sql, values);
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

export class TursoDatabase implements DatabaseBinding {
  private constructor(private readonly client: Client) {}

  static async open(url: string, authToken: string): Promise<TursoDatabase> {
    const client = createClient({ url, authToken, intMode: 'number', readYourWrites: true, concurrency: 8 });
    try {
      const schemaPath = resolve(process.cwd(), 'src/db/schema.sql');
      await client.executeMultiple(readFileSync(schemaPath, 'utf8'));
      await runSchemaMigrations(client);
      return new TursoDatabase(client);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  prepare(sql: string): TursoPreparedStatement {
    return new TursoPreparedStatement(this.client, sql);
  }

  async batch(statements: TursoPreparedStatement[]): Promise<unknown[]> {
    await this.client.batch(statements.map((statement) => statement.toInStatement()), 'write');
    return [];
  }

  close(): void {
    this.client.close();
  }
}

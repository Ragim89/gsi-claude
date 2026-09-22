/**
 * Minimal forward-only SQL migration runner.
 * Runs as the schema owner (DATABASE_OWNER_URL), applies apps/api/migrations/*.sql in name order,
 * each in its own transaction, and records them in schema_migrations.
 * Also makes sure the RLS-bound application role `gsi_app` exists with APP_DB_PASSWORD.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { config } from '../config';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function migrate(log: (m: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: config.databaseOwnerUrl });
  await client.connect();
  try {
    // Serialize concurrent runners (e.g. several API replicas starting at once).
    await client.query('SELECT pg_advisory_lock(727001)');

    const role = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'gsi_app'`);
    const pw = quoteLiteral(config.appDbPassword);
    if (role.rowCount === 0) {
      await client.query(`CREATE ROLE gsi_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
      log('created role gsi_app');
    } else {
      await client.query(`ALTER ROLE gsi_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log('migrations up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

import { Client } from 'pg';

/**
 * Creates a throwaway `gsi_test` database, applies every migration to it and seeds the
 * reference data (branches, users, clients, commodities, FX rates) — but not the year of
 * demo invoices, which tests neither need nor should depend on.
 *
 * Runs once before the integration suite. Nothing here touches the development database:
 * the connection strings come from the environment set by the `test` service in
 * docker-compose.yml, and the database name must end in `_test` or setup refuses to run.
 */
export default async function setup() {
  const owner = process.env.DATABASE_OWNER_URL;
  if (!owner) throw new Error('DATABASE_OWNER_URL is required for integration tests');

  const dbName = new URL(owner).pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error(`refusing to run integration tests against "${dbName}" — the database name must end in _test`);
  }

  const maintenanceUrl = new URL(owner);
  maintenanceUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: maintenanceUrl.toString() });
  await admin.connect();
  try {
    // Drop first: a leftover database from a failed run would hide schema changes.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  // Imported lazily: config reads the environment when it is first touched.
  const { migrate } = await import('../src/db/migrate');
  const { seed } = await import('../src/db/seed');
  await migrate(() => undefined);
  await seed({ volume: false });
}

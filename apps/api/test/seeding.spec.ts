import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { seedReports } from '../src/db/seed-reports';
import { createTestApp } from './app';

/**
 * Seeding must be safe to run again.
 *
 * The development database grew by forty reports on every API restart because the seed read
 * `SEED_REPORTS` as "issue this many more" rather than "the demo should hold this many".
 */
describe('demo seeding is idempotent', () => {
  let app: INestApplication;
  let db: DbService;

  const countReports = () =>
    db.tx(null, async (tx) => (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM reports'))!.n);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DbService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('issues nothing when the register already holds the target number', async () => {
    const before = await countReports();

    await seedReports(app, before);
    expect(await countReports()).toBe(before);

    // And running it a second time changes nothing either — the actual regression.
    await seedReports(app, before);
    expect(await countReports()).toBe(before);
  }, 60_000);

  it('issues nothing at all when the target is zero', async () => {
    const before = await countReports();
    await seedReports(app, 0);
    expect(await countReports()).toBe(before);
  });

  it('never removes reports that are already there', async () => {
    const before = await countReports();
    await seedReports(app, Math.max(0, before - 5));
    expect(await countReports()).toBe(before);
  });
});

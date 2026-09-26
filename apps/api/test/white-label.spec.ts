import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 13.5: organization branding (migration 027) has to do two things at once —
 * leave the existing GSI deployment looking exactly as it did, and let a second inspection
 * company change name/colours/logo without anyone touching core code. This spec proves both:
 * the first two tests read GSI's own branding (backfilled by the migration), the third swaps in
 * a temporary "second company" profile directly in the database — the same mechanism a real
 * second deployment's bootstrap-admin.mjs run would use — and shows the public endpoint picks
 * it up with nothing else changed, then restores GSI's row so no other spec is affected.
 */
describe('white-label: organization branding', () => {
  let app: INestApplication;
  let admin: Session;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /org/brand needs no session — the login screen calls it before anyone is signed in', async () => {
    const res = await request(app.getHttpServer()).get('/api/org/brand').expect(200);
    expect(res.body.name).toBe('General Survey Inspection');
    expect(res.body.shortName).toBe('GSI');
    expect(res.body.productName).toBe('GSI ONE');
    expect(res.body.primaryColor).toBe('#105098');
    expect(res.body.secondaryColor).toBe('#5888C0');
  });

  it('GET /org (authenticated) carries the same branding fields', async () => {
    const res = await as(app, admin).get('/api/org').expect(200);
    expect(res.body.shortName).toBe('GSI');
    expect(res.body.productName).toBe('GSI ONE');
  });

  it('a second company\'s branding replaces GSI\'s everywhere the core reads it, with no code change', async () => {
    const db = app.get(DbService);
    const before = await db.tx(admin.user as never, (tx) =>
      tx.one<{ short_name: string; product_name: string; primary_color: string; secondary_color: string }>(
        'SELECT short_name, product_name, primary_color, secondary_color FROM organizations ORDER BY code LIMIT 1',
      ),
    );

    try {
      await db.tx(admin.user as never, (tx) =>
        tx.exec(
          `UPDATE organizations SET name = $1, short_name = $2, product_name = $3,
                                     primary_color = $4, secondary_color = $5
           WHERE code = 'GSI'`,
          ['Acme Marine Surveyors', 'ACME', 'Acme ONE', '#7A1FA2', '#B266D6'],
        ),
      );

      const res = await request(app.getHttpServer()).get('/api/org/brand').expect(200);
      expect(res.body.name).toBe('Acme Marine Surveyors');
      expect(res.body.shortName).toBe('ACME');
      expect(res.body.productName).toBe('Acme ONE');
      expect(res.body.primaryColor).toBe('#7A1FA2');
      expect(res.body.secondaryColor).toBe('#B266D6');
    } finally {
      await db.tx(admin.user as never, (tx) =>
        tx.exec(
          `UPDATE organizations SET name = 'General Survey Inspection', short_name = $1,
                                     product_name = $2, primary_color = $3, secondary_color = $4
           WHERE code = 'GSI'`,
          [before!.short_name, before!.product_name, before!.primary_color, before!.secondary_color],
        ),
      );
    }
  });
});

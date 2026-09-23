import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * Phase 1: the organisational hierarchy, permissions and the audit trail.
 *
 * The interesting case is a second office in a country that already has one — that is what
 * the old flat branch model could not express, and what a country manager is for.
 */
describe('hierarchy, permissions and audit', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisorTr: Session;
  let istanbul: { id: string; code: string };
  let mersinId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisorTr = await login(app, ACCOUNTS.supervisorTr);

    const branches = (await as(app, admin).get('/api/branches').expect(200)).body;
    istanbul = branches.find((b: { code: string }) => b.code === 'TR');

    // A second Turkish office. Created directly in the database because opening an office is
    // an administrative act with no API of its own yet.
    const db = app.get(DbService);
    mersinId = await db.tx(admin.user as never, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO branches (code, country, city, currency, locale, ui_locales, timezone, legal_name, address)
         VALUES ('MER', 'TR', 'Mersin', 'TRY', 'tr', ARRAY['tr','en'], 'Europe/Istanbul',
                 'GSI Mersin — test office', 'Mersin, Türkiye')
         ON CONFLICT (code) DO UPDATE SET city = EXCLUDED.city
         RETURNING id`,
      );
      return row!.id;
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('places both Turkish offices under one country', async () => {
    const countries = (await as(app, admin).get('/api/org/countries').expect(200)).body;
    const turkey = countries.find((c: { code: string }) => c.code === 'TR');
    expect(turkey).toBeTruthy();
    expect(turkey.offices).toBe(2);
    expect(turkey.name).toBe('Türkiye');
  });

  it('gives an office user their own office only, even inside their country', async () => {
    const branches = (await as(app, supervisorTr).get('/api/branches').expect(200)).body;
    expect(branches).toHaveLength(1);
    expect(branches[0].id).toBe(istanbul.id);
  });

  it('widens the same user to the whole country when they are given the country role', async () => {
    await as(app, admin)
      .put(`/api/admin/users/${supervisorTr.user.id}/roles`)
      .send({ roles: ['country_manager'] })
      .expect(200);

    // The token still says nothing about permissions: they are resolved per request, so the
    // change takes effect without signing in again.
    const branches = (await as(app, supervisorTr).get('/api/branches').expect(200)).body;
    expect(branches.map((b: { id: string }) => b.id).sort()).toEqual([istanbul.id, mersinId].sort());
  });

  it('restores the office scope when the role is taken away again', async () => {
    await as(app, admin)
      .put(`/api/admin/users/${supervisorTr.user.id}/roles`)
      .send({ roles: ['supervisor'] })
      .expect(200);
    const branches = (await as(app, supervisorTr).get('/api/branches').expect(200)).body;
    expect(branches).toHaveLength(1);
  });

  it('lists the permission catalogue and the roles built from it', async () => {
    const permissions = (await as(app, admin).get('/api/admin/permissions').expect(200)).body;
    expect(permissions.length).toBeGreaterThan(30);
    expect(permissions.some((p: { code: string }) => p.code === 'job.approve')).toBe(true);

    const roles = (await as(app, admin).get('/api/admin/roles').expect(200)).body;
    const inspector = roles.find((r: { code: string }) => r.code === 'inspector');
    expect(inspector.scope).toBe('own');
    expect(inspector.permissions).toContain('job.submit');
    expect(inspector.permissions).not.toContain('job.approve');
  });

  it('applies a change to a role without anyone signing in again', async () => {
    // A supervisor cannot read the audit log…
    await as(app, supervisorTr).get('/api/admin/audit').expect(403);

    const before = (await as(app, admin).get('/api/admin/roles').expect(200)).body
      .find((r: { code: string }) => r.code === 'supervisor').permissions;
    await as(app, admin)
      .put('/api/admin/roles/supervisor/permissions')
      .send({ permissions: [...before, 'audit.read'] })
      .expect(200);

    const after = (await as(app, admin).get('/api/admin/roles').expect(200)).body
      .find((r: { code: string }) => r.code === 'supervisor').permissions;
    expect(after).toContain('audit.read');

    // …until the role is given the permission.
    await as(app, supervisorTr).get('/api/admin/audit').expect(200);

    await as(app, admin)
      .put('/api/admin/roles/supervisor/permissions')
      .send({ permissions: before })
      .expect(200);
    await as(app, supervisorTr).get('/api/admin/audit').expect(403);
  });

  it('records sign-ins, including the ones that failed', async () => {
    const res = await as(app, admin).get('/api/admin/audit?action=auth.login').expect(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.rows[0].action).toMatch(/^auth\.login/);

    await login(app, ACCOUNTS.admin, 'definitely-not-the-password').catch(() => undefined);
    const failed = await as(app, admin).get('/api/admin/audit?action=auth.login.failed').expect(200);
    expect(failed.body.total).toBeGreaterThan(0);
    expect(failed.body.rows[0].metadata.reason).toBe('wrong_password');
  });

  it('records what was done to a record, with before and after', async () => {
    const roleChanges = await as(app, admin).get('/api/admin/audit?action=role.manage').expect(200);
    expect(roleChanges.body.total).toBeGreaterThan(0);
    const entry = roleChanges.body.rows.find((r: { entityType: string }) => r.entityType === 'user');
    expect(entry.beforeData.roles).toBeDefined();
    expect(entry.afterData.roles).toBeDefined();
    expect(entry.userEmail).toBe(ACCOUNTS.admin);
  });

  it('archives a client instead of deleting it, and says so in the log', async () => {
    const created = await as(app, admin)
      .post('/api/clients')
      .send({ name: `Archive me ${Date.now()}`, country: 'TR' })
      .expect(201);

    await as(app, admin).delete(`/api/clients/${created.body.id}`).expect(204);

    // Gone from every list and from the record itself…
    await as(app, admin).get(`/api/clients/${created.body.id}`).expect(404);
    const list = (await as(app, admin).get('/api/clients?search=Archive me').expect(200)).body;
    expect(list).toHaveLength(0);

    // …but still in the database, and the archiving is on record.
    const db = app.get(DbService);
    const row = await db.tx(
      admin.user as never,
      (tx) => tx.one<{ deleted_at: string }>('SELECT deleted_at FROM clients WHERE id = $1', [created.body.id]),
      { includeArchived: true },
    );
    expect(row?.deleted_at).toBeTruthy();

    const log = await as(app, admin).get('/api/admin/audit?action=client.archive').expect(200);
    expect(log.body.rows[0].entityId).toBe(created.body.id);
  });

  it('keeps the audit log read-only: there is no way to change or remove an entry', async () => {
    const db = app.get(DbService);
    // The application's database role has no UPDATE or DELETE grant on the table at all.
    await expect(
      db.tx(admin.user as never, (tx) => tx.exec('DELETE FROM audit_logs WHERE true')),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.tx(admin.user as never, (tx) => tx.exec(`UPDATE audit_logs SET action = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i);
  });
});

import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * Branch isolation and role gating — the two rules the whole platform depends on.
 *
 * Isolation is enforced by PostgreSQL Row-Level Security, not by the services, so these tests
 * deliberately go through the HTTP layer: if a policy is dropped or a query bypasses the
 * security context, one of these fails.
 */
describe('branch isolation and role gating', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisorTr: Session;
  let supervisorRo: Session;
  let inspectorTr: Session;
  let branches: { id: string; code: string }[];

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisorTr = await login(app, ACCOUNTS.supervisorTr);
    supervisorRo = await login(app, ACCOUNTS.supervisorRo);
    inspectorTr = await login(app, ACCOUNTS.inspectorTr);
    branches = (await as(app, admin).get('/api/branches').expect(200)).body;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('shows every branch to HQ and only their own to a branch user', () => {
    expect(branches.length).toBeGreaterThanOrEqual(8);
    expect(branches.map((b) => b.code)).toContain('RO');
  });

  it('keeps a branch user inside their own branch', async () => {
    const own = await as(app, supervisorRo).get('/api/branches').expect(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0].code).toBe('RO');
  });

  it('does not leak clients of another branch', async () => {
    const trClients = (await as(app, supervisorTr).get('/api/clients').expect(200)).body.rows;
    const roClients = (await as(app, supervisorRo).get('/api/clients').expect(200)).body.rows;
    expect(trClients.length).toBeGreaterThan(0);
    expect(roClients.length).toBeGreaterThan(0);
    const trNames = new Set(trClients.map((c: { name: string }) => c.name));
    for (const client of roClients) expect(trNames.has(client.name)).toBe(false);
    for (const client of roClients) expect(client.branchCode).toBe('RO');
  });

  it('ignores a forged branchId: a branch user cannot query another branch', async () => {
    const tr = branches.find((b) => b.code === 'TR')!;
    const res = await as(app, supervisorRo).get(`/api/clients?branchId=${tr.id}`).expect(200);
    // RLS filters the rows regardless of what the query string asks for.
    for (const client of res.body.rows) expect(client.branchCode).toBe('RO');
  });

  it('refuses to create a client in another branch', async () => {
    const tr = branches.find((b) => b.code === 'TR')!;
    const res = await as(app, supervisorRo)
      .post('/api/clients')
      .send({ name: 'Cross-branch attempt', branchId: tr.id });
    expect([201, 403]).toContain(res.status);
    if (res.status === 201) {
      // If the API accepted it, it must have been forced into the caller's own branch.
      expect(res.body.branchCode).toBe('RO');
    }
  });

  it('gives an inspector only the jobs they are actually on', async () => {
    const jobs = (await as(app, inspectorTr).get('/api/jobs').expect(200)).body.rows;
    expect(jobs.length).toBeGreaterThan(0);

    for (const job of jobs as { id: string; assignedInspectorId: string | null }[]) {
      if (job.assignedInspectorId === inspectorTr.user.id) continue;

      // Since PHASE 4 an inspector is also on a job through its inspections: being sent to
      // one inspection of a nomination is what gives them the job it belongs to.
      const assignments = (await as(app, inspectorTr).get(`/api/jobs/${job.id}/assignments`).expect(200)).body;
      const onJob = assignments.some((a: { userId: string }) => a.userId === inspectorTr.user.id);

      const inspections = (await as(app, inspectorTr).get(`/api/inspections?jobId=${job.id}`).expect(200)).body;
      const onInspection = inspections.rows.some(
        (i: { leadInspectorId: string | null; assignees?: { userId: string }[] }) =>
          i.leadInspectorId === inspectorTr.user.id ||
          (i.assignees ?? []).some((a) => a.userId === inspectorTr.user.id),
      );

      expect(onJob || onInspection).toBe(true);
    }
  });

  it('keeps finance away from operational roles', async () => {
    await as(app, inspectorTr).get('/api/finance/dashboard').expect(403);
    await as(app, inspectorTr).get('/api/finance/invoices').expect(403);
    await as(app, inspectorTr).get('/api/assets').expect(403);
  });

  it('keeps administration away from non-admins', async () => {
    await as(app, inspectorTr).get('/api/users').expect(403);
    await as(app, supervisorTr).post('/api/reference/commodities').send({ code: 'X', group: 'other' }).expect(403);
  });

  it('does not let an inspector export or import anything', async () => {
    // Moving data in or out of the system needs its own permission, which field roles do not
    // have — the whole area is closed, not just the finance sections inside it.
    await as(app, inspectorTr).get('/api/export/sections').expect(403);
    await as(app, inspectorTr).get('/api/import/sections').expect(403);
  });

  it('offers a supervisor the sections their permissions cover, and no more', async () => {
    const sections = (await as(app, supervisorTr).get('/api/export/sections').expect(200)).body.sections;
    expect(sections).toContain('jobs');
    expect(sections).toContain('clients');
    // A supervisor may read finance figures, so those sections are offered too.
    expect(sections).toContain('invoices');

    const importSections = (await as(app, supervisorTr).get('/api/import/sections').expect(200)).body.sections;
    expect(importSections).toContain('clients');
    expect(importSections).not.toContain('invoices');
  });

  it('lets HQ see the whole group', async () => {
    const clients = (await as(app, admin).get('/api/clients').expect(200)).body.rows;
    const codes = new Set(clients.map((c: { branchCode: string }) => c.branchCode));
    expect(codes.size).toBeGreaterThan(1);
  });
});

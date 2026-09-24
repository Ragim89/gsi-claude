import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The job list as an operations screen actually uses it — paged, searched, filtered, sorted —
 * plus the things that must never break: unique numbers under concurrency, scope, archiving,
 * and the links to reports, finance and the checklist that other modules depend on.
 */
describe('jobs: listing, numbering, scope and archive', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let supervisorRo: Session;
  let inspector: Session;
  let clientId: string;
  let created: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    supervisorRo = await login(app, ACCOUNTS.supervisorRo);
    inspector = await login(app, ACCOUNTS.inspectorTr);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `List Testing ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gives every job a unique number, even when several are opened at once', async () => {
    // Ten simultaneous creations: the counter is a row updated inside the transaction, so
    // this is the case that would break a MAX(id)+1 scheme.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        as(app, supervisor)
          .post('/api/jobs')
          .send({
            clientId,
            type: 'weight_supervision',
            location: `Berth ${i + 1}`,
            priority: i % 3 === 0 ? 'urgent' : 'normal',
            clientReference: `REF-${i}`,
            commodity: i % 2 === 0 ? 'Milling wheat' : 'Feed barley',
          }),
      ),
    );
    for (const res of results) expect(res.status).toBe(201);

    const numbers = results.map((r) => r.body.jobNumber);
    created = results.map((r) => r.body.id);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toMatch(/^TR-J-\d{4}-\d{5}$/);
  });

  it('keeps the number it was given', async () => {
    const before = (await as(app, supervisor).get(`/api/jobs/${created[0]}`).expect(200)).body.jobNumber;
    await as(app, supervisor).patch(`/api/jobs/${created[0]}`).send({ location: 'Somewhere else' }).expect(200);
    const after = (await as(app, supervisor).get(`/api/jobs/${created[0]}`).expect(200)).body.jobNumber;
    expect(after).toBe(before);
  });

  it('pages through the list with a total', async () => {
    const first = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&limit=4&offset=0`).expect(200)).body;
    const second = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&limit=4&offset=4`).expect(200)).body;
    expect(first.total).toBe(10);
    expect(first.rows).toHaveLength(4);
    expect(second.rows).toHaveLength(4);
    const ids = new Set(first.rows.map((j: { id: string }) => j.id));
    for (const job of second.rows) expect(ids.has(job.id)).toBe(false);
  });

  it('searches by number, client reference and commodity', async () => {
    const number = (await as(app, supervisor).get(`/api/jobs/${created[0]}`).expect(200)).body.jobNumber;

    const byNumber = (await as(app, supervisor).get(`/api/jobs?search=${number}`).expect(200)).body;
    expect(byNumber.rows.map((j: { id: string }) => j.id)).toContain(created[0]);

    const byReference = (await as(app, supervisor).get('/api/jobs?search=REF-3').expect(200)).body;
    expect(byReference.total).toBeGreaterThan(0);

    const byCommodity = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&search=Feed barley`).expect(200)).body;
    expect(byCommodity.total).toBe(5);
  });

  it('filters by priority, status and client', async () => {
    const urgent = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&priority=urgent`).expect(200)).body;
    expect(urgent.total).toBe(4);
    for (const job of urgent.rows) expect(job.priority).toBe('urgent');

    const drafts = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&status=draft`).expect(200)).body;
    expect(drafts.total).toBe(10);

    const active = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&active=true`).expect(200)).body;
    expect(active.total).toBe(10);
  });

  it('sorts by the columns the list offers', async () => {
    const asc = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&sort=jobNumber&dir=asc`).expect(200)).body;
    const desc = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}&sort=jobNumber&dir=desc`).expect(200)).body;
    expect(asc.rows[0].jobNumber < asc.rows[1].jobNumber).toBe(true);
    expect(desc.rows[0].jobNumber).toBe(asc.rows[asc.rows.length - 1].jobNumber);
  });

  it('refuses a sort column that is not offered, instead of interpolating it', async () => {
    await as(app, supervisor).get('/api/jobs?sort=; DROP TABLE inspection_jobs').expect(400);
  });

  it('keeps a job inside its office and country', async () => {
    // A supervisor in Romania cannot see a Turkish job, by id or through a forged filter.
    await as(app, supervisorRo).get(`/api/jobs/${created[0]}`).expect(404);
    const forged = (await as(app, supervisorRo).get('/api/jobs?branchId=' + created[0]).expect(200)).body;
    expect(forged.rows.every((j: { branchCode: string }) => j.branchCode === 'RO')).toBe(true);
  });

  it('shows an inspector only the jobs they are on', async () => {
    const mine = (await as(app, inspector).get('/api/jobs?mine=true').expect(200)).body;
    for (const job of mine.rows) {
      const assigned =
        job.assignedInspectorId === inspector.user.id ||
        (job.assignees ?? []).some((a: { userId: string }) => a.userId === inspector.user.id);
      expect(assigned).toBe(true);
    }
    // None of the drafts just created are theirs.
    expect(mine.rows.map((j: { id: string }) => j.id)).not.toContain(created[0]);
  });

  it('archives a job and takes it out of the list, then restores it', async () => {
    const id = created[9];
    await as(app, supervisor).delete(`/api/jobs/${id}`).expect(204);

    const list = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}`).expect(200)).body;
    expect(list.rows.map((j: { id: string }) => j.id)).not.toContain(id);
    await as(app, supervisor).get(`/api/jobs/${id}`).expect(404);

    const archive = (await as(app, supervisor).get('/api/jobs/archived').expect(200)).body;
    expect(archive.rows.map((j: { id: string }) => j.id)).toContain(id);

    await as(app, supervisor).post(`/api/jobs/${id}/restore`).expect(200);
    const back = (await as(app, supervisor).get(`/api/jobs?clientId=${clientId}`).expect(200)).body;
    expect(back.rows.map((j: { id: string }) => j.id)).toContain(id);
  });

  it('records archiving and restoring in the audit log', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${created[9]}`).expect(200)).body;
    const actions = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('job.archive');
    expect(actions).toContain('job.restore');
  });

  it('refuses a stale form instead of overwriting newer data', async () => {
    const id = created[1];
    const job = (await as(app, supervisor).get(`/api/jobs/${id}`).expect(200)).body;

    // Someone else saves first.
    await as(app, supervisor).patch(`/api/jobs/${id}`).send({ instructions: 'Saved by the first person' }).expect(200);

    // The second person's form still carries the old version.
    const stale = await as(app, supervisor)
      .patch(`/api/jobs/${id}`)
      .send({ version: job.version, instructions: 'Saved by the second person' });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/changed by someone else/i);

    const after = (await as(app, supervisor).get(`/api/jobs/${id}`).expect(200)).body;
    expect(after.instructions).toBe('Saved by the first person');
  });
});

/**
 * Regression: the modules that were built on top of jobs before this phase must keep working
 * after the schema moved underneath them.
 */
describe('jobs: what other modules depend on', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('still exports jobs, with the columns the export promised', async () => {
    const csv = (await as(app, supervisor).get('/api/export/jobs?sep=comma').expect(200)).text;
    const header = csv.split('\r\n')[0];
    expect(header).toContain('Job no.');
    expect(header).toContain('Client');
    expect(header).toContain('Status');
  });

  it('still exports everything as one archive', async () => {
    const res = await as(app, supervisor).get('/api/export/all').expect(200);
    expect(res.headers['content-type']).toContain('zip');
  });

  it('still imports clients, which jobs are attached to', async () => {
    const sections = (await as(app, supervisor).get('/api/import/sections').expect(200)).body;
    expect(sections.sections).toContain('clients');
  });

  it('keeps the finance link on a job: an invoice raised against it resolves both ways', async () => {
    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Finance link ${Date.now()}`, country: 'TR' })
      .expect(201);
    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId: client.body.id, type: 'sampling', location: 'Port of Derince' })
      .expect(201);

    const invoice = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: client.body.id,
        jobId: job.body.id,
        lines: [{ description: 'Sampling services', quantity: 1, unitPrice: 1200 }],
        taxRate: 20,
      })
      .expect(201);
    expect(invoice.body.jobId).toBe(job.body.id);
    expect(invoice.body.jobNumber).toBe(job.body.jobNumber);

    // And the job is still reachable from the invoice's side.
    await as(app, admin).get(`/api/jobs/${invoice.body.jobId}`).expect(200);
  });

  it('keeps issued reports readable and verifiable after the schema change', async () => {
    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Report link ${Date.now()}`, country: 'TR' })
      .expect(201);
    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId: client.body.id, type: 'cleanliness', location: 'Port of Mersin' })
      .expect(201);

    await as(app, supervisor).post(`/api/jobs/${job.body.id}/transitions`).send({ action: 'confirm' }).expect(200);
    await as(app, supervisor)
      .post(`/api/jobs/${job.body.id}/assignments`)
      .send({ userId: supervisor.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, supervisor).post(`/api/jobs/${job.body.id}/transitions`).send({ action: 'start' }).expect(200);

    const items: { id: string }[] = (await as(app, supervisor).get(`/api/jobs/${job.body.id}/checklist`).expect(200)).body;
    for (const item of items) {
      await as(app, supervisor).patch(`/api/jobs/${job.body.id}/checklist/${item.id}`).send({ result: 'ok' }).expect(200);
    }
    await as(app, supervisor).post(`/api/jobs/${job.body.id}/transitions`).send({ action: 'submit' }).expect(200);
    const approved = await as(app, supervisor)
      .post(`/api/jobs/${job.body.id}/transitions`)
      .send({ action: 'approve' })
      .expect(200);

    const report = approved.body.report;
    expect(report.reportNumber).toBeTruthy();

    const verify = await as(app, admin).get(`/api/public/verify/${report.verificationToken}`).expect(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.jobNumber).toBe(job.body.jobNumber);
  }, 60_000);

  it('keeps the checklist attached to its job', async () => {
    const jobs = (await as(app, admin).get('/api/jobs?limit=1').expect(200)).body;
    const items = (await as(app, admin).get(`/api/jobs/${jobs.rows[0].id}/checklist`).expect(200)).body;
    expect(Array.isArray(items)).toBe(true);
  });
});

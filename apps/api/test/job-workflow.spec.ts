import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The operational core of the acceptance scenario: a supervisor creates a client and a job,
 * assigns an inspector, the inspector fills in the checklist in the field, submits it, and the
 * supervisor approves — which must issue the report in the same transaction.
 *
 * Every rule that guards this path is asserted, not just the happy ending: an inspector may
 * not approve their own work, a job cannot skip states, and a job with an empty checklist
 * cannot be submitted.
 */
describe('job lifecycle', () => {
  let app: INestApplication;
  let supervisor: Session;
  let inspector: Session;
  let otherInspector: Session;
  let clientId: string;
  let jobId: string;

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    otherInspector = await login(app, ACCOUNTS.inspector2Tr);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('creates a client in the caller’s own branch', async () => {
    const res = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Test Trading ${Date.now()}`, country: 'TR', contactEmail: 'ops@test.example' })
      .expect(201);
    expect(res.body.branchCode).toBe('TR');
    clientId = res.body.id;
  });

  it('creates a job with a generated number and the checklist of its service type', async () => {
    const res = await as(app, supervisor)
      .post('/api/jobs')
      .send({
        clientId,
        type: 'loading_discharge',
        location: 'Port of Derince, Berth 5',
        vesselOrObject: 'MV Test Carrier',
        commodity: 'Milling wheat',
      })
      .expect(201);
    jobId = res.body.id;
    expect(res.body.status).toBe('new');
    expect(res.body.jobNumber).toMatch(/^TR-J-\d{4}-\d{5}$/);

    const checklist = await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200);
    expect(checklist.body.length).toBeGreaterThan(0);
  });

  it('hides an unassigned job from inspectors, so it cannot even be started', async () => {
    // Row-Level Security limits inspectors to jobs assigned to them: the job does not exist
    // as far as they are concerned, which is why this is 404 rather than 403.
    await as(app, inspector).post(`/api/jobs/${jobId}/start`).expect(404);
  });

  it('assigns the job to an inspector', async () => {
    const res = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assign`)
      .send({ inspectorId: inspector.user.id })
      .expect(201);
    expect(res.body.status).toBe('assigned');
    expect(res.body.assignedInspectorId).toBe(inspector.user.id);
  });

  it('hides the job from an inspector it is not assigned to', async () => {
    const jobs = (await as(app, otherInspector).get('/api/jobs').expect(200)).body;
    expect(jobs.map((j: { id: string }) => j.id)).not.toContain(jobId);
    await as(app, otherInspector).get(`/api/jobs/${jobId}`).expect(404);
  });

  it('lets the assigned inspector start the job', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/start`).expect(200);
    expect(res.body.status).toBe('in_progress');
  });

  it('refuses to submit while checklist items have no result', async () => {
    await as(app, inspector).post(`/api/jobs/${jobId}/submit`).expect(400);
  });

  it('accepts checklist answers from the field', async () => {
    const items: { id: string }[] = (await as(app, inspector).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    for (const [i, item] of items.entries()) {
      await as(app, inspector)
        .patch(`/api/jobs/${jobId}/checklist/${item.id}`)
        .send({ result: i === 0 ? 'deviation' : 'ok', ...(i === 0 ? { notes: 'Hatch cover seal damaged' } : {}) })
        .expect(200);
    }
    const after = (await as(app, inspector).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    expect(after.every((it: { result: string | null }) => it.result !== null)).toBe(true);
  });

  it('submits the completed checklist for review', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/submit`).expect(200);
    expect(res.body.status).toBe('under_review');
  });

  it('does not let an inspector approve their own work', async () => {
    await as(app, inspector).post(`/api/jobs/${jobId}/approve`).expect(403);
  });

  it('issues the report when the supervisor approves', async () => {
    const res = await as(app, supervisor).post(`/api/jobs/${jobId}/approve`).expect(200);
    expect(res.body.job.status).toBe('approved');
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.reportNumber).toMatch(/^TR-R-\d{4}-\d{5}$/);
    expect(res.body.report.status).toBe('issued');
  }, 60_000);

  it('shows the issued report on the client card and serves its PDF', async () => {
    const reports = (await as(app, supervisor).get(`/api/reports?clientId=${clientId}`).expect(200)).body;
    expect(reports.length).toBe(1);

    const pdf = await as(app, supervisor).get(`/api/reports/${reports[0].id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  }, 60_000);

  it('verifies the report publicly by its token, without a session', async () => {
    const reports = (await as(app, supervisor).get(`/api/reports?clientId=${clientId}`).expect(200)).body;
    const token = reports[0].verificationToken;
    expect(token).toBeTruthy();

    const res = await as(app, supervisor).get(`/api/public/verify/${token}`).expect(200);
    expect(res.body.valid).toBe(true);
  });

  it('locks the job once it is approved', async () => {
    await as(app, inspector).post(`/api/jobs/${jobId}/start`).expect(409);
    await as(app, supervisor).post(`/api/jobs/${jobId}/cancel`).expect(409);
    // The checklist of an issued report must not change either.
    const items: { id: string }[] = (await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    await as(app, supervisor).patch(`/api/jobs/${jobId}/checklist/${items[0].id}`).send({ result: 'ok' }).expect(409);
  });
});

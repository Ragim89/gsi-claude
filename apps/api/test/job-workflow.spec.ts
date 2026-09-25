import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The Phase 3 acceptance scenario, end to end: operations opens a draft from a phone call,
 * fills it in, confirms it, a team is assigned, the work runs, is paused and resumed, the
 * checklist is filled in the field, reviewed and approved — which issues the report.
 *
 * Every rule that guards the path is asserted too, because a workflow that only works when
 * used correctly is not a workflow.
 */
describe('job lifecycle', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let otherInspector: Session;
  let inspectorRo: Session;
  let clientId: string;
  let contactId: string;
  let contractId: string;
  let jobId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    otherInspector = await login(app, ACCOUNTS.inspector2Tr);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Lifecycle Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const contact = await as(app, supervisor)
      .post(`/api/clients/${clientId}/contacts`)
      .send({ fullName: 'Deniz Operations', email: 'ops@lifecycle.example', isPrimary: true })
      .expect(201);
    contactId = contact.body.id;

    const contract = await as(app, supervisor)
      .post('/api/contracts')
      .send({ clientId, contractNo: `LC-${Date.now()}`, status: 'active', paymentTermsDays: 30 })
      .expect(201);
    contractId = contract.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('opens a draft with only what is known so far', async () => {
    const res = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'loading_discharge', priority: 'high' })
      .expect(201);
    jobId = res.body.id;
    expect(res.body.status).toBe('draft');
    expect(res.body.priority).toBe('high');
    // The number is allocated at creation and never changes afterwards.
    expect(res.body.jobNumber).toMatch(/^TR-J-\d{4}-\d{5}$/);

    const checklist = await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200);
    expect(checklist.body.length).toBeGreaterThan(0);
  });

  it('refuses to confirm a draft that is missing what a job needs', async () => {
    // Everything is there except the place of inspection and the contract details.
    const res = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'start' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cannot be started/i);
  });

  it('takes the rest of the details, including the client contact and contract', async () => {
    const res = await as(app, supervisor)
      .patch(`/api/jobs/${jobId}`)
      .send({
        location: 'Port of Derince, Berth 5',
        city: 'Kocaeli',
        vesselOrObject: 'MV Lifecycle',
        objectKind: 'vessel',
        commodity: 'Milling wheat',
        clientContactId: contactId,
        contractId,
        clientReference: 'PO-99812',
        requestedDate: '2026-10-01',
        internalNotes: 'Client called at 08:40, wants the surveyor on board by 09:00.',
      })
      .expect(200);
    expect(res.body.clientContactName).toBe('Deniz Operations');
    expect(res.body.contractRef).toBeTruthy();
    expect(res.body.requestedDate).toBe('2026-10-01');
  });

  it('refuses a contract that belongs to somebody else', async () => {
    const other = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Someone else ${Date.now()}`, country: 'TR' })
      .expect(201);
    const foreign = await as(app, supervisor)
      .post('/api/contracts')
      .send({ clientId: other.body.id, contractNo: `OTHER-${Date.now()}` })
      .expect(201);

    const res = await as(app, supervisor).patch(`/api/jobs/${jobId}`).send({ contractId: foreign.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/another client/i);
  });

  it('confirms the job once it is complete', async () => {
    const res = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'confirm' })
      .expect(200);
    expect(res.body.job.status).toBe('confirmed');
  });

  it('assigns a team, and the job becomes assigned', async () => {
    const lead = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    expect(lead.body).toHaveLength(1);

    await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assignments`)
      .send({ userId: otherInspector.user.id, role: 'sampler' })
      .expect(201);

    const job = (await as(app, supervisor).get(`/api/jobs/${jobId}`).expect(200)).body;
    expect(job.status).toBe('assigned');
    expect(job.assignedInspectorId).toBe(inspector.user.id);
    expect(job.assignees).toHaveLength(2);
  });

  it('refuses to assign somebody from another office', async () => {
    const res = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assignments`)
      .send({ userId: inspectorRo.user.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/office/i);
  });

  it('shows the job to everyone assigned to it, not only to the lead', async () => {
    const mine = (await as(app, otherInspector).get('/api/jobs?mine=true').expect(200)).body;
    expect(mine.rows.map((j: { id: string }) => j.id)).toContain(jobId);
  });

  it('hides the job from an inspector who is not on it', async () => {
    const jobs = (await as(app, inspectorRo).get('/api/jobs').expect(200)).body;
    expect(jobs.rows.map((j: { id: string }) => j.id)).not.toContain(jobId);
    await as(app, inspectorRo).get(`/api/jobs/${jobId}`).expect(404);
  });

  it('lets the assigned inspector start the work', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'start' }).expect(200);
    expect(res.body.job.status).toBe('in_progress');
  });

  it('insists on a reason before putting a job on hold', async () => {
    const res = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'hold' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reason/i);
  });

  it('holds and resumes, returning the job to what it was doing', async () => {
    const held = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'hold', reason: 'Vessel delayed by weather' })
      .expect(200);
    expect(held.body.job.status).toBe('on_hold');

    const resumed = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'resume' })
      .expect(200);
    expect(resumed.body.job.status).toBe('in_progress');
  });

  it('refuses to submit while checklist items have no result', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'submit' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/checklist/i);
  });

  it('accepts checklist answers from the field', async () => {
    const items: { id: string }[] = (await as(app, inspector).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    for (const [i, item] of items.entries()) {
      await as(app, inspector)
        .patch(`/api/jobs/${jobId}/checklist/${item.id}`)
        .send({ result: i === 0 ? 'deviation' : 'ok', ...(i === 0 ? { notes: 'Hatch cover seal damaged' } : {}) })
        .expect(200);
    }
  });

  it('submits the completed checklist for review', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'submit' }).expect(200);
    expect(res.body.job.status).toBe('under_review');
  });

  it('does not let an inspector approve their own work', async () => {
    const res = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  it('issues the report when the supervisor approves', async () => {
    const res = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'approve' })
      .expect(200);
    expect(res.body.job.status).toBe('approved');
    expect(res.body.report.reportNumber).toMatch(/^TR-R-\d{4}-\d{5}$/);
    expect(res.body.report.status).toBe('issued');
  }, 60_000);

  it('shows the issued report on the client card and serves its PDF', async () => {
    const page = (await as(app, supervisor).get(`/api/reports?clientId=${clientId}`).expect(200)).body;
    expect(page.total).toBe(1);
    expect(page.rows[0].reportType).toBe('inspection_report');
    const pdf = await as(app, supervisor).get(`/api/reports/${page.rows[0].id}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  }, 60_000);

  it('verifies the report publicly by its token, without a session', async () => {
    const page = (await as(app, supervisor).get(`/api/reports?clientId=${clientId}`).expect(200)).body;
    const res = await as(app, supervisor).get(`/api/public/verify/${page.rows[0].verificationToken}`).expect(200);
    expect(res.body.valid).toBe(true);
    // The public check names the document and the office that issued it, never the client.
    expect(res.body.reportNumber).toBe(page.rows[0].reportNumber);
    expect(res.body.clientName).toBeUndefined();
  });

  it('completes and closes the job, and then it is locked', async () => {
    const completed = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'complete' })
      .expect(200);
    expect(completed.body.job.status).toBe('completed');

    const closed = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'close' })
      .expect(200);
    expect(closed.body.job.status).toBe('closed');

    // A closed job is final: no transition, no edit, no checklist change.
    const reopen = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'start' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.message).toMatch(/closed/i);

    await as(app, supervisor).patch(`/api/jobs/${jobId}`).send({ instructions: 'too late' }).expect(409);

    const items: { id: string }[] = (await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    await as(app, supervisor).patch(`/api/jobs/${jobId}/checklist/${items[0].id}`).send({ result: 'ok' }).expect(409);
  });

  it('kept the whole story in the status history', async () => {
    const history = (await as(app, supervisor).get(`/api/jobs/${jobId}/history`).expect(200)).body;
    const path = history.map((h: { toStatus: string }) => h.toStatus);
    expect(path).toEqual([
      'draft',
      'confirmed',
      'assigned',
      'in_progress',
      'on_hold',
      'in_progress',
      'under_review',
      'approved',
      'completed',
      'closed',
    ]);

    const hold = history.find((h: { toStatus: string }) => h.toStatus === 'on_hold');
    expect(hold.reason).toBe('Vessel delayed by weather');
    expect(hold.changedByName).toBeTruthy();
  });

  it('recorded every step in the audit log as well', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${jobId}`).expect(200)).body;
    const actions = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('job.create');
    expect(actions).toContain('job.confirm');
    expect(actions).toContain('job.assign');
    expect(actions).toContain('job.hold');
    expect(actions).toContain('job.approve');
    expect(actions).toContain('job.close');
  });
});

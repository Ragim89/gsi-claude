import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The Phase 4 acceptance scenario, end to end: a job is opened, a second inspection is booked
 * on it, an inspector is assigned, the work is started from the field, the checklist is filled
 * in batches, findings and measurements are recorded, the inspection is completed, reviewed
 * and approved — and then proves it cannot be quietly edited afterwards.
 */
describe('inspection lifecycle', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let otherInspector: Session;
  let inspectorRo: Session;
  let clientId: string;
  let jobId: string;
  /** The inspection the job opened for itself. */
  let firstId: string;
  /** A second inspection booked on the same job — the discharge survey. */
  let inspectionId: string;
  let findingId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    otherInspector = await login(app, ACCOUNTS.inspector2Tr);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Inspection Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({
        clientId,
        type: 'loading_discharge',
        location: 'Port of Derince, Berth 5',
        vesselOrObject: 'MV Inspection',
      })
      .expect(201);
    jobId = job.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('opens an inspection with the job, carrying the checklist', async () => {
    const list = (await as(app, supervisor).get(`/api/inspections?jobId=${jobId}`).expect(200)).body;
    expect(list.rows).toHaveLength(1);
    firstId = list.rows[0].id;
    expect(list.rows[0].inspectionNumber).toMatch(/^TR-INS-\d{4}-\d{5}$/);
    expect(list.rows[0].status).toBe('draft');
    expect(list.rows[0].checklistTotal).toBeGreaterThan(0);
  });

  it('books a second inspection on the same job', async () => {
    const res = await as(app, supervisor)
      .post('/api/inspections')
      .send({
        jobId,
        type: 'weight_supervision',
        location: 'Port of Derince, Berth 5',
        scheduledStart: '2026-10-02T06:00:00.000Z',
      })
      .expect(201);
    inspectionId = res.body.id;
    // A scheduled start means it is scheduled, not a draft.
    expect(res.body.status).toBe('scheduled');
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.checklistTotal).toBeGreaterThan(0);
    expect(res.body.id).not.toBe(firstId);
  });

  it('keeps the two checklists apart, even where they ask the same question', async () => {
    const a = (await as(app, supervisor).get(`/api/inspections/${firstId}/checklist`).expect(200)).body;
    const b = (await as(app, supervisor).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    const ids = new Set([...a.items, ...b.items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(a.items.length + b.items.length);
  });

  it('assigns a lead inspector and a second pair of hands', async () => {
    const lead = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    expect(lead.body).toHaveLength(1);

    await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: otherInspector.user.id, role: 'sampler' })
      .expect(201);

    const x = (await as(app, supervisor).get(`/api/inspections/${inspectionId}`).expect(200)).body;
    expect(x.leadInspectorId).toBe(inspector.user.id);
    expect(x.assignees).toHaveLength(2);
  });

  it('refuses to assign somebody from another office', async () => {
    const res = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspectorRo.user.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/office/i);
  });

  it('shows it to everyone on it, and hides it from an inspector who is not', async () => {
    const mine = (await as(app, otherInspector).get('/api/inspections?mine=true').expect(200)).body;
    expect(mine.rows.map((x: { id: string }) => x.id)).toContain(inspectionId);

    const foreign = (await as(app, inspectorRo).get('/api/inspections').expect(200)).body;
    expect(foreign.rows.map((x: { id: string }) => x.id)).not.toContain(inspectionId);
    await as(app, inspectorRo).get(`/api/inspections/${inspectionId}`).expect(404);
  });

  it('will not complete an inspection that has not started', async () => {
    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'complete' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/scheduled/i);
  });

  it('starts the field work, stamping the actual start and moving the job with it', async () => {
    // The job must be confirmed and assigned for the inspection to carry it into progress.
    await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'confirm' }).expect(200);
    await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);

    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'start' })
      .expect(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.actualStart).toBeTruthy();

    const job = (await as(app, supervisor).get(`/api/jobs/${jobId}`).expect(200)).body;
    expect(job.status).toBe('in_progress');
  });

  it('saves a batch of checklist answers in one request', async () => {
    const before = (await as(app, inspector).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    expect(before.requiredRemaining).toBeGreaterThan(0);

    const answers = before.items
      .slice(0, 2)
      .map((item: { id: string }, i: number) => ({
        itemId: item.id,
        result: i === 0 ? 'deviation' : 'ok',
        notes: i === 0 ? 'Hatch cover seal damaged' : null,
      }));

    const after = await as(app, inspector)
      .patch(`/api/inspections/${inspectionId}/checklist`)
      .send({ answers })
      .expect(200);
    expect(after.body.answered).toBe(2);
    expect(after.body.requiredRemaining).toBe(before.requiredRemaining - 2);
    expect(after.body.items.find((i: { id: string }) => i.id === answers[0].itemId).notes).toBe(
      'Hatch cover seal damaged',
    );
  });

  it('refuses answers that belong to a different inspection', async () => {
    const other = (await as(app, supervisor).get(`/api/inspections/${firstId}/checklist`).expect(200)).body;
    const res = await as(app, inspector)
      .patch(`/api/inspections/${inspectionId}/checklist`)
      .send({ answers: [{ itemId: other.items[0].id, result: 'ok' }] });
    expect(res.status).toBe(404);
  });

  it('records a finding and a measurement', async () => {
    const finding = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/findings`)
      .send({
        title: 'Hatch cover seal damaged',
        severity: 'major',
        category: 'cargo_securing',
        description: 'Rubber gasket torn over two metres on hatch 3.',
        recommendation: 'Replace before loading resumes.',
      })
      .expect(201);
    findingId = finding.body.id;
    expect(finding.body.status).toBe('open');

    const measurement = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/measurements`)
      .send({ measurementType: 'moisture', valueNumeric: 12.4, unit: '%', position: 'Hold 3' })
      .expect(201);
    expect(measurement.body.valueNumeric).toBe(12.4);

    const x = (await as(app, inspector).get(`/api/inspections/${inspectionId}`).expect(200)).body;
    expect(x.findingCount).toBe(1);
    expect(x.measurementCount).toBe(1);
  });

  it('refuses a measurement with no value at all', async () => {
    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/measurements`)
      .send({ measurementType: 'temperature', unit: 'C' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/value/i);
  });

  it('blocks completion while required checklist items are unanswered', async () => {
    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'complete' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required checklist/i);
  });

  it('completes once every required item has an answer', async () => {
    const checklist = (await as(app, inspector).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    const rest = checklist.items
      .filter((i: { result: string | null }) => !i.result)
      .map((i: { id: string }) => ({ itemId: i.id, result: 'ok' }));
    if (rest.length) {
      await as(app, inspector).patch(`/api/inspections/${inspectionId}/checklist`).send({ answers: rest }).expect(200);
    }

    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'complete' })
      .expect(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.actualEnd).toBeTruthy();
  });

  it('closes the checklist to further edits the moment it is completed', async () => {
    const checklist = (await as(app, inspector).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    expect(checklist.editable).toBe(false);
    const res = await as(app, inspector)
      .patch(`/api/inspections/${inspectionId}/checklist`)
      .send({ answers: [{ itemId: checklist.items[0].id, result: 'na' }] });
    expect(res.status).toBe(409);
  });

  it('submits for review, and does not let the inspector approve their own work', async () => {
    const submitted = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'submit_review' })
      .expect(200);
    expect(submitted.body.status).toBe('under_review');

    const res = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'approve' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  it('returns work for rework with a reason, and insists on having one', async () => {
    const noReason = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'return' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason/i);

    const returned = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'return', reason: 'Photograph the damaged seal' })
      .expect(200);
    expect(returned.body.status).toBe('in_progress');
    expect(returned.body.reviewComment).toBe('Photograph the damaged seal');
  });

  it('refuses a save built on a stale copy of the record', async () => {
    const x = (await as(app, supervisor).get(`/api/inspections/${inspectionId}`).expect(200)).body;
    await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}`)
      .send({ weatherConditions: 'Fine, wind SW 4', version: x.version })
      .expect(200);

    // Same version again: somebody else has written since this copy was read.
    const stale = await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}`)
      .send({ siteConditions: 'Berth dry', version: x.version });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/another user/i);
  });

  it('approves, recording who did it and when', async () => {
    await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'complete' })
      .expect(200);
    await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'submit_review' })
      .expect(200);

    const res = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'approve' })
      .expect(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.reviewedBy).toBe(supervisor.user.id);
    expect(res.body.reviewedAt).toBeTruthy();
  });

  it('cannot be edited after approval — not the record, not the checklist, not the evidence', async () => {
    await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}`)
      .send({ conclusion: 'Quietly rewritten' })
      .expect(409);

    const checklist = (await as(app, supervisor).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}/checklist`)
      .send({ answers: [{ itemId: checklist.items[0].id, result: 'na' }] })
      .expect(409);

    await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/findings`)
      .send({ title: 'Something else entirely' })
      .expect(409);
  });

  it('still lets a finding be resolved after approval — follow-up is not a rewrite', async () => {
    const resolved = await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}/findings/${findingId}`)
      .send({ status: 'resolved' })
      .expect(200);
    expect(resolved.body.status).toBe('resolved');

    const rewrite = await as(app, supervisor)
      .patch(`/api/inspections/${inspectionId}/findings/${findingId}`)
      .send({ title: 'Never happened' });
    expect(rewrite.status).toBe(409);
  });

  it('reopens an approved inspection only with a reason, and says so in the history', async () => {
    const noReason = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'reopen' });
    expect(noReason.status).toBe(400);

    const reopened = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'reopen', reason: 'Client disputes the moisture reading' })
      .expect(200);
    expect(reopened.body.status).toBe('in_progress');
  });

  it('kept the whole story in the status history', async () => {
    const history = (await as(app, supervisor).get(`/api/inspections/${inspectionId}/history`).expect(200)).body;
    const path = history.map((h: { toStatus: string }) => h.toStatus);
    expect(path).toEqual([
      'scheduled',
      'in_progress',
      'completed',
      'under_review',
      'in_progress',
      'completed',
      'under_review',
      'approved',
      'in_progress',
    ]);

    const reopen = history[history.length - 1];
    expect(reopen.reason).toBe('Client disputes the moisture reading');
    expect(reopen.changedByName).toBeTruthy();
  });

  it('recorded every step in the audit log as well', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${inspectionId}`).expect(200)).body;
    const actions: string[] = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('inspection.create');
    expect(actions).toContain('inspection.assign');
    expect(actions).toContain('inspection.start');
    expect(actions).toContain('inspection.checklist_update');
    expect(actions).toContain('inspection.finding_added');
    expect(actions).toContain('inspection.measurement_added');
    expect(actions).toContain('inspection.approve');
    expect(actions).toContain('inspection.reopen');
  });

  it('lists, searches and pages like every other list in the system', async () => {
    const page = (await as(app, supervisor).get('/api/inspections?limit=5&offset=0').expect(200)).body;
    expect(page.rows.length).toBeLessThanOrEqual(5);
    expect(page.total).toBeGreaterThan(0);
    expect(page.limit).toBe(5);

    const x = (await as(app, supervisor).get(`/api/inspections/${inspectionId}`).expect(200)).body;
    const found = (
      await as(app, supervisor).get(`/api/inspections?search=${x.inspectionNumber}`).expect(200)
    ).body;
    expect(found.rows.map((r: { id: string }) => r.id)).toContain(inspectionId);

    const open = (await as(app, supervisor).get('/api/inspections?active=true').expect(200)).body;
    expect(open.rows.every((r: { status: string }) => !['approved', 'cancelled'].includes(r.status))).toBe(true);
  });

  it('archives and restores an inspection that never ran', async () => {
    const spare = await as(app, supervisor).post('/api/inspections').send({ jobId }).expect(201);
    await as(app, supervisor).delete(`/api/inspections/${spare.body.id}`).expect(204);

    const list = (await as(app, supervisor).get(`/api/inspections?jobId=${jobId}`).expect(200)).body;
    expect(list.rows.map((r: { id: string }) => r.id)).not.toContain(spare.body.id);

    const restored = await as(app, admin).post(`/api/inspections/${spare.body.id}/restore`).expect(200);
    expect(restored.body.id).toBe(spare.body.id);
    await as(app, supervisor).get(`/api/inspections/${spare.body.id}`).expect(200);
  });

  it('refuses to archive an inspection whose work has already been done', async () => {
    const res = await as(app, supervisor).delete(`/api/inspections/${inspectionId}`);
    expect(res.status).toBe(409);
  });
});

/**
 * Everything that existed before inspections did. These would all have passed in Phase 3 —
 * that is the point of running them again.
 */
describe('inspections leave the rest of the system alone', () => {
  let app: INestApplication;
  let supervisor: Session;
  let admin: Session;

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    admin = await login(app, ACCOUNTS.admin);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('still serves the job checklist the job card has always used', async () => {
    const jobs = (await as(app, supervisor).get('/api/jobs?limit=1').expect(200)).body;
    const jobId = jobs.rows[0].id;
    const items = (await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200)).body;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it('still verifies an issued report by its public token', async () => {
    const reports = (await as(app, supervisor).get('/api/reports').expect(200)).body;
    const list: { verificationToken: string }[] = Array.isArray(reports) ? reports : reports.rows;
    if (!list.length) return;
    const res = await as(app, supervisor).get(`/api/public/verify/${list[0].verificationToken}`).expect(200);
    expect(res.body.valid).toBe(true);
  });

  it('still lists invoices, assets and the audit log', async () => {
    await as(app, admin).get('/api/finance/invoices').expect(200);
    await as(app, admin).get('/api/assets').expect(200);
    await as(app, admin).get('/api/admin/audit').expect(200);
  });

  it('still exports jobs to CSV', async () => {
    const res = await as(app, admin).get('/api/export/jobs').expect(200);
    expect(res.headers['content-type']).toMatch(/csv/);
  });
});

import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 13's acceptance run (apps/api/test/acceptance.spec.ts) found that a sample dispatched to
 * a laboratory in a *different* office — a documented feature, `app_sees_laboratory()`
 * (migrations/014_samples.sql) — could not actually be received or accepted there: `404 Sample
 * not found` on both transitions. Root cause: `samples.service.ts`'s `FROM` inner-joined
 * `branches`/`inspection_jobs`/`clients` to enrich the row with `branchCode`/`jobNumber`/
 * `clientName`, and none of those three tables' own RLS policies know about the lab exception
 * (`app_can_see_branch(branch_id)` only) — the join silently dropped the whole sample row for
 * the receiving laboratory's own staff, even though `samples_visible` itself would have shown it.
 *
 * The fix (samples.service.ts) is those three joins going from `JOIN` to `LEFT JOIN`: the sample
 * row survives regardless, and the enrichment columns fall back to null exactly when RLS would
 * have hidden them anyway — no new grant, no RLS policy touched, no additional disclosure beyond
 * what `lab_sample_brief()` (migrations/017_reports.sql) already permits a receiving office.
 *
 * This spec reproduces the exact scenario: a job in the Romania office, a sample sent to
 * TR-LAB (an existing Turkish office laboratory, existing staff — no new fixtures needed), and
 * proves both that the receiving laboratory can now do its job and that an office with no
 * relationship to either side still sees nothing at all.
 */
describe('cross-office laboratory: receive and accept a sample from another office', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisorRo: Session;
  let inspectorRo: Session;
  let labTr: Session;
  /** Truly unrelated to both sides: not Romania (the job), not TR (the laboratory). */
  let inspectorUa: Session;
  let clientId: string;
  let jobId: string;
  let inspectionId: string;
  let sampleId: string;
  let laboratoryId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisorRo = await login(app, ACCOUNTS.supervisorRo);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);
    labTr = await login(app, ACCOUNTS.labTr);
    // Ukraine: not the job's office (Romania) and not TR-LAB's own branch (TR) either — a
    // genuinely unrelated third office, to prove denial still holds. (A TR-branch account would
    // not do here: app_sees_laboratory grants the whole receiving branch visibility, not only
    // its lab staff, so any TR user would legitimately see this sample too.)
    inspectorUa = await login(app, 'inspector.ua@gsi.local');

    const labs = (await as(app, supervisorRo).get('/api/samples/laboratories').expect(200)).body;
    laboratoryId = labs.find((l: { code: string }) => l.code === 'TR-LAB').id;

    const client = await as(app, supervisorRo)
      .post('/api/clients')
      .send({ name: `Cross-office Trading ${Date.now()}`, country: 'RO' })
      .expect(201);
    clientId = client.body.id;

    const job = await as(app, supervisorRo)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Constanța' })
      .expect(201);
    jobId = job.body.id;

    const inspections = (await as(app, supervisorRo).get(`/api/inspections?jobId=${jobId}`).expect(200)).body;
    inspectionId = inspections.rows[0].id;
    await as(app, supervisorRo)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspectorRo.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, inspectorRo).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'start' }).expect(200);

    const sample = await as(app, inspectorRo)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat', quantity: 2, unit: 'kg' })
      .expect(201);
    sampleId = sample.body.id;
    expect(sample.body.branchId).not.toBe(labTr.user.branchId);

    await as(app, inspectorRo).post(`/api/samples/${sampleId}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisorRo).post(`/api/samples/${sampleId}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspectorRo)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'seal', sealNumber: `XO-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisorRo)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId })
      .expect(200);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('lets the receiving office read the sample card despite belonging to another office', async () => {
    const card = (await as(app, labTr).get(`/api/samples/${sampleId}`).expect(200)).body;
    expect(card.status).toBe('dispatched');
    // The enrichment columns (job number, client name, branch code) come from Romania's own
    // inspection_jobs/clients/branches rows, which TR-LAB's staff has no RLS grant to read
    // directly — the fix lets the sample row itself survive but does not manufacture a new
    // grant, so they come back null on the general card, exactly as strict least-privilege
    // requires. The dedicated brief endpoint below is the sanctioned, narrower disclosure.
    expect(card.clientName).toBeNull();
    expect(card.jobNumber).toBeNull();

    const brief = (await as(app, labTr).get(`/api/lab/samples/${sampleId}/brief`).expect(200)).body;
    expect(brief.clientName).toBeTruthy();
    expect(brief.jobNumber).toBeTruthy();
  });

  it('receives the sample at the laboratory in the other office', async () => {
    const received = await as(app, labTr)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'receive', sealState: 'intact', condition: 'good' })
      .expect(200);
    expect(received.body.status).toBe('received_by_lab');
  });

  it('accepts the sample at the laboratory boundary', async () => {
    const accepted = await as(app, labTr)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'accept', notes: 'Booked in for moisture' })
      .expect(200);
    expect(accepted.body.status).toBe('accepted_by_lab');
    expect(accepted.body.labDecisionBy).toBe(labTr.user.id);
  });

  it('shows the full chain of custody to the receiving laboratory', async () => {
    const custody = (await as(app, labTr).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    expect(custody.map((e: { eventType: string }) => e.eventType)).toEqual([
      'collected', 'registered', 'sealed', 'dispatched', 'lab_received', 'lab_accepted',
    ]);
  });

  it('never exposed the sending office\'s commercial records to the receiving laboratory', async () => {
    // No contract, invoice, tariff or address ever appears on the sample card — not even a null
    // placeholder, since the columns were never selected at all.
    const card = (await as(app, labTr).get(`/api/samples/${sampleId}`).expect(200)).body;
    expect(card).not.toHaveProperty('contractId');
    expect(card).not.toHaveProperty('clientAddress');
    expect(card).not.toHaveProperty('invoiceId');

    // The underlying commercial records themselves are still denied outright.
    await as(app, labTr).get(`/api/clients/${clientId}`).expect(404);
    await as(app, labTr).get(`/api/jobs/${jobId}`).expect(404);
  });

  it('still denies an office with no relationship to either side', async () => {
    await as(app, inspectorUa).get(`/api/samples/${sampleId}`).expect(404);
    const res = await as(app, inspectorUa)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'reject', rejectionReason: 'broken_seal', reason: 'not my sample' });
    expect(res.status).toBe(404);

    const list = (await as(app, inspectorUa).get('/api/samples').expect(200)).body;
    expect(list.rows.map((s: { id: string }) => s.id)).not.toContain(sampleId);
  });

  it('recorded the receiving office\'s own actions in the audit log', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${sampleId}`).expect(200)).body;
    const actions: string[] = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('sample.receive');
    expect(actions).toContain('sample.accept');
  });
});

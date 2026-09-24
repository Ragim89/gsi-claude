import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The PHASE 6 acceptance scenario: a sample the laboratory has accepted is given a panel of
 * analyses, one is run, entered, reviewed, approved, released — and then proves it cannot be
 * quietly edited, only amended, with the superseded revision still on the record.
 */
describe('laboratory lifecycle', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let analyst: Session;
  let analyst2: Session;
  let inspectorRo: Session;

  let clientId: string;
  let jobId: string;
  let sampleId: string;
  let laboratoryId: string;
  let commodityId: string;
  let moistureTestId: string;
  let moistureMethodId: string;
  let moistureRequestId: string;

  /** Takes a sample all the way to the laboratory bench, which is where this phase starts. */
  async function acceptedSample(commodity: string) {
    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince, Berth 5', commodityId: commodity })
      .expect(201);
    const inspectionId = (await as(app, supervisor).get(`/api/inspections?jobId=${job.body.id}`).expect(200))
      .body.rows[0].id;
    await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, inspector).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'start' }).expect(200);

    const sample = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodityId: commodity, quantity: 2.5, unit: 'kg' })
      .expect(201);
    const id = sample.body.id;
    await as(app, inspector).post(`/api/samples/${id}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${id}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspector)
      .post(`/api/samples/${id}/transitions`)
      .send({ action: 'seal', sealNumber: `LAB-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${id}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId })
      .expect(200);
    await as(app, labManager)
      .post(`/api/samples/${id}/transitions`)
      .send({ action: 'receive', sealState: 'intact', condition: 'good' })
      .expect(200);
    await as(app, labManager).post(`/api/samples/${id}/transitions`).send({ action: 'accept' }).expect(200);
    return { sampleId: id, jobId: job.body.id, inspectionId };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);
    analyst2 = await login(app, ACCOUNTS.analyst2Tr);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Laboratory Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const labs = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body;
    laboratoryId = labs.find((l: { code: string }) => l.code === 'TR-LAB').id;

    const commodities = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body;
    commodityId = commodities.find((c: { code: string }) => c.code === 'wheat_milling').id;

    const made = await acceptedSample(commodityId);
    sampleId = made.sampleId;
    jobId = made.jobId;

    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    moistureTestId = tests.find((t: { code: string }) => t.code === 'moisture').id;
    const methods = (await as(app, labManager).get(`/api/lab/methods?labTestId=${moistureTestId}`).expect(200)).body;
    moistureMethodId = methods[0].id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---- Catalogue -------------------------------------------------------------------------

  it('has a catalogue built from the commodity reference data, not invented', async () => {
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    expect(tests.length).toBeGreaterThanOrEqual(30);
    const codes = tests.map((t: { code: string }) => t.code);
    // These came from `commodities.lab_methods`, which predates the laboratory module entirely.
    for (const code of ['moisture', 'protein', 'gluten', 'aflatoxin', 'gmo']) expect(codes).toContain(code);
    expect(tests.find((t: { code: string }) => t.code === 'gmo').resultType).toBe('pass_fail');
  });

  it('adds a test to the catalogue, and keeps that behind a management right', async () => {
    const code = `tst_${Date.now().toString().slice(-6)}`;
    const res = await as(app, admin)
      .post('/api/lab/tests')
      .send({ code, name: { en: 'Verification test' }, category: 'chemical', resultType: 'numeric', defaultUnit: '%' })
      .expect(201);
    expect(res.body.code).toBe(code);
    expect(res.body.methodCount).toBe(0);

    const refused = await as(app, analyst)
      .post('/api/lab/tests')
      .send({ code: `${code}x`, name: { en: 'No' } });
    expect(refused.status).toBe(403);
  });

  it('declares a method, and freezes its version into anything already measured with it', async () => {
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${moistureTestId}`).expect(200)).body[0];
    expect(method.version).toBe(1);
    expect(method.standardReference).toBeTruthy();

    // Editing something substantive bumps the version — by database trigger, not by hope.
    const bumped = await as(app, labManager)
      .patch(`/api/lab/methods/${method.id}`)
      .send({ detectionLimit: 0.02 })
      .expect(200);
    expect(bumped.body.version).toBe(2);

    // …and editing something cosmetic does not.
    const same = await as(app, labManager)
      .patch(`/api/lab/methods/${method.id}`)
      .send({ description: 'Reworded for the manual' })
      .expect(200);
    expect(same.body.version).toBe(2);
  });

  it('resolves the most specific specification that applies', async () => {
    // The seed holds a commodity-level limit for milling wheat moisture.
    const commodityLevel = (await as(app, labManager)
      .get(`/api/lab/specifications?labTestId=${moistureTestId}&commodityId=${commodityId}`)
      .expect(200)).body;
    expect(commodityLevel.length).toBeGreaterThan(0);
    expect(commodityLevel[0].scope).toBe('commodity');
    expect(commodityLevel[0].maxValue).toBe(14.5);

    // A client of ours has agreed something tighter; that must win.
    await as(app, labManager)
      .post('/api/lab/specifications')
      .send({ labTestId: moistureTestId, clientId, commodityId, maxValue: 13.5, unit: '%' })
      .expect(201);

    const all = (await as(app, labManager)
      .get(`/api/lab/specifications?labTestId=${moistureTestId}&clientId=${clientId}`)
      .expect(200)).body;
    expect(all[0].scope).toBe('client');
    expect(all[0].maxValue).toBe(13.5);
  });

  it('refuses a specification that specifies nothing', async () => {
    const res = await as(app, labManager)
      .post('/api/lab/specifications')
      .send({ labTestId: moistureTestId, commodityId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/limit or requirement/i);
  });

  // ---- Requests --------------------------------------------------------------------------

  it('will not request analyses on a sample the laboratory has not accepted', async () => {
    const fresh = await as(app, inspector)
      .post('/api/samples')
      .send({ jobId, commodityId, quantity: 1, unit: 'kg' })
      .expect(201);
    const res = await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId: fresh.body.id, tests: [{ labTestId: moistureTestId }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/accepted/i);
  });

  it('requests the commodity standard panel in one go', async () => {
    const res = await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, usePanel: true, priority: 'high', dueAt: '2026-12-31T12:00:00.000Z' })
      .expect(201);

    // Milling wheat carries several analyses in the reference data; only the ones the
    // laboratory has declared a method for can actually be asked for.
    expect(res.body.created.length).toBeGreaterThanOrEqual(3);
    expect(res.body.created.every((r: { status: string }) => r.status === 'requested')).toBe(true);
    expect(res.body.created.every((r: { priority: string }) => r.priority === 'high')).toBe(true);

    const moisture = res.body.created.find((r: { testCode: string }) => r.testCode === 'moisture');
    expect(moisture).toBeTruthy();
    moistureRequestId = moisture.id;
    // The client-specific limit resolved at request time, not the commodity one.
    expect(moisture.specificationId).toBeTruthy();
  });

  it('gives each analysis its own request, all pointing at one sample', async () => {
    const list = (await as(app, labManager).get(`/api/lab/requests?sampleId=${sampleId}`).expect(200)).body;
    expect(list.total).toBeGreaterThanOrEqual(3);
    expect(new Set(list.rows.map((r: { testCode: string }) => r.testCode)).size).toBe(list.rows.length);
    expect(list.rows.every((r: { sampleId: string }) => r.sampleId === sampleId)).toBe(true);
  });

  it('refuses the same analysis twice on one sample', async () => {
    const res = await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: moistureTestId, testMethodId: moistureMethodId }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already requested/i);

    // Unless it is told to skip what is there, which is what asking for a panel again means.
    const skipped = await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, usePanel: true })
      .expect(201);
    expect(skipped.body.created).toHaveLength(0);
    expect(skipped.body.skipped).toBeGreaterThan(0);
  });

  it('shows the panel a commodity carries, and what is already asked for', async () => {
    const panel = (await as(app, labManager)
      .get(`/api/lab/panels/${commodityId}?sampleId=${sampleId}`)
      .expect(200)).body;
    expect(panel.tests.length).toBeGreaterThan(0);
    expect(panel.tests.some((t: { alreadyRequested: boolean }) => t.alreadyRequested)).toBe(true);
  });

  // ---- Assignment ------------------------------------------------------------------------

  it('assigns an analyst, and refuses somebody who cannot enter results', async () => {
    const notAnAnalyst = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/assignment`)
      .send({ analystId: inspector.user.id });
    expect(notAnAnalyst.status).toBe(400);
    expect(notAnAnalyst.body.message).toMatch(/not allowed to enter/i);

    const res = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    expect(res.body.status).toBe('assigned');
    expect(res.body.assignedAnalystId).toBe(analyst.user.id);
    expect(res.body.assignedAt).toBeTruthy();
  });

  it('does not let an analyst assign work to themselves', async () => {
    const res = await as(app, analyst)
      .post(`/api/lab/requests/${moistureRequestId}/assignment`)
      .send({ analystId: analyst.user.id });
    expect(res.status).toBe(403);
  });

  // ---- The bench -------------------------------------------------------------------------

  it('will not let another analyst start work assigned to somebody else', async () => {
    const res = await as(app, analyst2)
      .post(`/api/lab/requests/${moistureRequestId}/transitions`)
      .send({ action: 'start' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/somebody else/i);
  });

  it('starts the analysis', async () => {
    const res = await as(app, analyst)
      .post(`/api/lab/requests/${moistureRequestId}/transitions`)
      .send({ action: 'start' })
      .expect(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.startedAt).toBeTruthy();
  });

  it('saves a numeric result without losing a digit of it', async () => {
    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40', unit: '%', comments: 'Duplicate determination, mean reported' })
      .expect(200);

    expect(res.body.status).toBe('result_entered');
    expect(res.body.result.numericValue).toBe(12.4);
    expect(res.body.result.unit).toBe('%');
    // Judged against the client limit of 13.5 %, which was frozen into the result.
    expect(res.body.result.evaluation).toBe('within_spec');
    expect(res.body.result.specificationSnapshot.maxValue).toBe(13.5);
    expect(res.body.result.specificationSnapshot.scope).toBe('client');
    // And the method as it was at that moment, version and all.
    expect(res.body.result.methodSnapshot.code).toBeTruthy();
    expect(res.body.result.methodSnapshot.version).toBeGreaterThanOrEqual(1);
  });

  it('keeps the exact decimal in the database, not a floating-point approximation', async () => {
    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.345678' })
      .expect(200);
    expect(res.body.result.numericValue).toBe(12.345678);

    await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40' })
      .expect(200);
  });

  it('refuses a number that is not one', async () => {
    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: 'about twelve' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a number/i);
  });

  it('refuses a save built on a stale copy of the result', async () => {
    const current = (await as(app, analyst).get(`/api/lab/requests/${moistureRequestId}`).expect(200)).body;
    const v = current.result.version;
    await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.41', version: v })
      .expect(200);
    const stale = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.42', version: v });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/somebody else/i);

    await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40' })
      .expect(200);
  });

  it('links an instrument and records that its calibration was overdue', async () => {
    const instruments = (await as(app, analyst).get(`/api/lab/instruments?laboratoryId=${laboratoryId}`).expect(200)).body;
    const overdue = instruments.find((i: { calibrationOverdue: boolean }) => i.calibrationOverdue);
    expect(overdue).toBeTruthy();

    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40', instrumentId: overdue.id })
      .expect(200);
    // Warned about and written down — never a silent block on doing the work.
    expect(res.body.result.instrumentId).toBe(overdue.id);
    expect(res.body.result.instrumentOverdue).toBe(true);

    const good = instruments.find((i: { code: string }) => i.code === 'NIR-01');
    const back = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40', instrumentId: good.id })
      .expect(200);
    expect(back.body.result.instrumentOverdue).toBe(false);
  });

  // ---- Review, approval, release ----------------------------------------------------------

  it('submits the result, after which the analyst can no longer change it', async () => {
    const res = await as(app, analyst)
      .post(`/api/lab/requests/${moistureRequestId}/result/submit`)
      .expect(200);
    expect(res.body.status).toBe('under_review');
    expect(res.body.result.submittedAt).toBeTruthy();

    const edit = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '11.00' });
    expect(edit.status).toBe(409);
    expect(edit.body.message).toMatch(/returned first/i);
  });

  it('will not approve a result nobody has reviewed', async () => {
    const res = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/approve`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not been technically reviewed/i);
  });

  it('will not let the analyst review their own work', async () => {
    const res = await as(app, analyst).post(`/api/lab/requests/${moistureRequestId}/result/review`).send({});
    expect(res.status).toBe(403);
  });

  it('returns the result to the bench with a reason, then takes it again', async () => {
    const noReason = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/return`)
      .send({});
    expect(noReason.status).toBe(400);

    const returned = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/return`)
      .send({ reason: 'Repeat the determination, the duplicate spread is too wide' })
      .expect(200);
    expect(returned.body.status).toBe('in_progress');
    expect(returned.body.result.reviewComment).toMatch(/duplicate spread/i);

    await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.40' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${moistureRequestId}/result/submit`).expect(200);
  });

  it('is reviewed by somebody other than the analyst', async () => {
    const res = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/review`)
      .send({ comment: 'Duplicates agree, instrument in calibration' })
      .expect(200);
    expect(res.body.status).toBe('under_review');
    expect(res.body.result.reviewedBy).toBe(labManager.user.id);
    expect(res.body.result.reviewedAt).toBeTruthy();
  });

  it('will not let the analyst approve their own result', async () => {
    // The analyst does not hold the approval right at all, which is the first line of defence.
    const res = await as(app, analyst).post(`/api/lab/requests/${moistureRequestId}/result/approve`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission/i);
  });

  it('approves the result', async () => {
    const res = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/approve`)
      .expect(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.result.approvedBy).toBe(labManager.user.id);
    expect(res.body.result.approvedAt).toBeTruthy();
  });

  it('keeps an approved result out of reach of an edit', async () => {
    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '9.99' });
    expect(res.status).toBe(409);
  });

  it('does not let a report see the result until it is released', async () => {
    const before = (await as(app, supervisor).get(`/api/lab/released?jobId=${jobId}`).expect(200)).body;
    expect(before.find((r: { testCode: string }) => r.testCode === 'moisture')).toBeUndefined();

    const res = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/release`)
      .expect(200);
    expect(res.body.status).toBe('released');
    expect(res.body.result.releasedAt).toBeTruthy();

    const after = (await as(app, supervisor).get(`/api/lab/released?jobId=${jobId}`).expect(200)).body;
    const released = after.find((r: { testCode: string }) => r.testCode === 'moisture');
    expect(released).toBeTruthy();
    expect(released.numericValue).toBe(12.4);
    expect(released.methodVersion).toBeGreaterThanOrEqual(1);
    expect(released.evaluation).toBe('within_spec');
  });

  // ---- Amendment -------------------------------------------------------------------------

  it('amends a released result by superseding it, never by editing it', async () => {
    const before = (await as(app, labManager).get(`/api/lab/requests/${moistureRequestId}/revisions`).expect(200)).body;
    expect(before).toHaveLength(1);
    const original = before[0];

    const noReason = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/amendments`)
      .send({});
    expect(noReason.status).toBe(400);

    const amended = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/amendments`)
      .send({ reason: 'Transcription error found against the worksheet' })
      .expect(201);
    expect(amended.body.status).toBe('in_progress');
    expect(amended.body.result.revision).toBe(2);
    expect(amended.body.result.supersedesResultId).toBe(original.id);

    const revisions = (await as(app, labManager).get(`/api/lab/requests/${moistureRequestId}/revisions`).expect(200)).body;
    expect(revisions).toHaveLength(2);
    const kept = revisions.find((r: { id: string }) => r.id === original.id);
    // The superseded revision keeps its value, its signatures and its release stamp.
    expect(kept.numericValue).toBe(12.4);
    expect(kept.approvedBy).toBe(labManager.user.id);
    expect(kept.releasedAt).toBeTruthy();
    expect(kept.isCurrent).toBe(false);
  });

  it('carries the corrected revision through the same review and approval', async () => {
    await as(app, analyst)
      .patch(`/api/lab/requests/${moistureRequestId}/result`)
      .send({ numericValue: '12.80' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${moistureRequestId}/result/submit`).expect(200);
    await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/review`)
      .send({ comment: 'Checked against the worksheet' })
      .expect(200);
    await as(app, labManager).post(`/api/lab/requests/${moistureRequestId}/result/approve`).expect(200);
    const released = await as(app, labManager)
      .post(`/api/lab/requests/${moistureRequestId}/result/release`)
      .expect(200);
    expect(released.body.result.revision).toBe(2);

    const forReport = (await as(app, supervisor).get(`/api/lab/released?jobId=${jobId}`).expect(200)).body;
    const moisture = forReport.find((r: { testCode: string }) => r.testCode === 'moisture');
    // A report asking today gets the corrected revision; one issued before still quotes the old.
    expect(moisture.revision).toBe(2);
    expect(moisture.numericValue).toBe(12.8);
  });

  // ---- Out of specification ----------------------------------------------------------------

  it('marks a result outside its limits without touching the value', async () => {
    // Milling wheat carries an upper limit of 2 % foreign matter in the reference data. It is
    // not part of the standard panel, so it is asked for by name — which is how a client's
    // extra request reaches the bench in real life.
    const fmTest = (await as(app, labManager).get('/api/lab/tests').expect(200))
      .body.find((t: { code: string }) => t.code === 'foreign_matter');
    expect(fmTest).toBeTruthy();
    const fmMethod = (await as(app, labManager).get(`/api/lab/methods?labTestId=${fmTest.id}`).expect(200)).body[0];
    expect(fmMethod).toBeTruthy();

    const created = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: fmTest.id, testMethodId: fmMethod.id }] })
      .expect(201)).body.created[0];
    // The commodity limit was resolved when the analysis was asked for, not when it was measured.
    expect(created.specificationId).toBeTruthy();

    await as(app, labManager)
      .post(`/api/lab/requests/${created.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${created.id}/transitions`).send({ action: 'start' }).expect(200);

    const res = await as(app, analyst)
      .patch(`/api/lab/requests/${created.id}/result`)
      .send({ numericValue: '4.75' })
      .expect(200);

    expect(res.body.result.specificationSnapshot.maxValue).toBe(2);
    expect(res.body.result.evaluation).toBe('out_of_spec');
    // The value stays exactly as the analyst entered it. Out of specification is a fact about
    // a result, never a reason to change one.
    expect(res.body.result.numericValue).toBe(4.75);
  });

  it('separates work waiting to be checked from work waiting to be signed', async () => {
    // Both piles are `under_review`; only the technical review tells them apart, and the
    // laboratory dashboard counts them as two different things.
    const toCheck = (await as(app, labManager)
      .get('/api/lab/requests?status=under_review&reviewed=false')
      .expect(200)).body;
    expect(toCheck.rows.every((r: { result: { reviewedBy: string | null } }) => r.result.reviewedBy === null))
      .toBe(true);

    const toSign = (await as(app, labManager)
      .get('/api/lab/requests?status=under_review&reviewed=true')
      .expect(200)).body;
    expect(toSign.rows.every((r: { result: { reviewedBy: string | null } }) => r.result.reviewedBy !== null))
      .toBe(true);

    const both = (await as(app, labManager).get('/api/lab/requests?status=under_review').expect(200)).body;
    expect(toCheck.total + toSign.total).toBe(both.total);

    const dashboard = (await as(app, labManager).get('/api/lab/dashboard').expect(200)).body;
    expect(dashboard.awaitingReview).toBe(toCheck.total);
    expect(dashboard.awaitingApproval).toBe(toSign.total);
  });

  it('finds the out-of-specification work from the queue', async () => {
    const oos = (await as(app, labManager).get('/api/lab/requests?outOfSpec=true').expect(200)).body;
    expect(oos.rows.every((r: { result: { evaluation: string } }) => r.result.evaluation === 'out_of_spec')).toBe(true);
  });

  // ---- Queue, scope, integration -----------------------------------------------------------

  it('answers the questions a work queue is asked', async () => {
    const mine = (await as(app, analyst).get('/api/lab/requests?mine=true').expect(200)).body;
    expect(mine.rows.every((r: { assignedAnalystId: string }) => r.assignedAnalystId === analyst.user.id)).toBe(true);

    const unassigned = (await as(app, labManager).get('/api/lab/requests?unassigned=true').expect(200)).body;
    expect(unassigned.rows.every((r: { assignedAnalystId: string | null }) => r.assignedAnalystId === null)).toBe(true);

    const page = (await as(app, labManager).get('/api/lab/requests?limit=2&offset=0').expect(200)).body;
    expect(page.rows.length).toBeLessThanOrEqual(2);
    expect(page.limit).toBe(2);
    expect(page.total).toBeGreaterThan(2);

    const byStatus = (await as(app, labManager).get('/api/lab/requests?status=released').expect(200)).body;
    expect(byStatus.rows.every((r: { status: string }) => r.status === 'released')).toBe(true);

    const sample = (await as(app, labManager).get(`/api/lab/requests?sampleId=${sampleId}`).expect(200)).body;
    const found = (await as(app, labManager)
      .get(`/api/lab/requests?search=${sample.rows[0].sampleNumber}`)
      .expect(200)).body;
    expect(found.rows.length).toBeGreaterThan(0);

    const byLab = (await as(app, labManager).get(`/api/lab/requests?laboratoryId=${laboratoryId}`).expect(200)).body;
    expect(byLab.total).toBeGreaterThan(0);
  });

  it('counts the dashboard from the same rows the queue shows', async () => {
    const d = (await as(app, labManager).get('/api/lab/dashboard').expect(200)).body;
    for (const key of ['samplesAwaitingTests', 'unassigned', 'inProgress', 'awaitingReview',
      'awaitingApproval', 'awaitingRelease', 'overdue', 'outOfSpec']) {
      expect(typeof d[key]).toBe('number');
    }
    const unassigned = (await as(app, labManager).get('/api/lab/requests?unassigned=true&limit=200').expect(200)).body;
    expect(d.unassigned).toBe(unassigned.total);
  });

  it('hides laboratory work from an office that has nothing to do with it', async () => {
    const list = (await as(app, inspectorRo).get('/api/lab/requests').expect(200)).body;
    expect(list.rows.map((r: { id: string }) => r.id)).not.toContain(moistureRequestId);
    await as(app, inspectorRo).get(`/api/lab/requests/${moistureRequestId}`).expect(404);
  });

  it('keeps the whole story in the history, readable line by line', async () => {
    const history = (await as(app, labManager).get(`/api/lab/requests/${moistureRequestId}/history`).expect(200)).body;
    const path = history.map((h: { toStatus: string }) => h.toStatus);
    expect(path[0]).toBe('requested');
    expect(path).toContain('assigned');
    expect(path).toContain('in_progress');
    expect(path).toContain('result_entered');
    expect(path).toContain('under_review');
    expect(path).toContain('approved');
    expect(path).toContain('released');
    expect(history.every((h: { changedByName: string }) => h.changedByName)).toBe(true);
    expect(history.some((h: { reason: string | null }) => h.reason)).toBe(true);
  });

  it('recorded every step in the audit log as well', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${moistureRequestId}`).expect(200)).body;
    const actions: string[] = log.rows.map((r: { action: string }) => r.action);
    for (const wanted of ['lab.assign', 'lab.start', 'lab.enter', 'lab.submit', 'lab.review',
      'lab.approve', 'lab.release', 'lab.amend', 'lab.result.draft_saved', 'lab.result.amended']) {
      expect(actions).toContain(wanted);
    }
  });

  it('shows the laboratory work on the sample and on the job', async () => {
    const onSample = (await as(app, supervisor).get(`/api/lab/requests?sampleId=${sampleId}`).expect(200)).body;
    expect(onSample.total).toBeGreaterThan(0);

    const onJob = (await as(app, supervisor).get(`/api/lab/requests?jobId=${jobId}`).expect(200)).body;
    expect(onJob.total).toBe(onSample.total);
    expect(onJob.rows.every((r: { jobId: string }) => r.jobId === jobId)).toBe(true);
  });

  it('tells a user only what they may do right now', async () => {
    const asAnalyst = (await as(app, analyst).get(`/api/lab/requests/${moistureRequestId}`).expect(200)).body;
    expect(asAnalyst.actions).not.toContain('approve');
    expect(asAnalyst.actions).not.toContain('release');

    const asManager = (await as(app, labManager).get(`/api/lab/requests/${moistureRequestId}`).expect(200)).body;
    expect(asManager.actions).toContain('amend');
  });
});

/** Everything that existed before the laboratory did. */
describe('the laboratory leaves the rest of the system alone', () => {
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

  it('still lists jobs, inspections and samples', async () => {
    expect((await as(app, supervisor).get('/api/jobs?limit=1').expect(200)).body.total).toBeGreaterThan(0);
    expect((await as(app, supervisor).get('/api/inspections?limit=1').expect(200)).body.total).toBeGreaterThan(0);
    expect((await as(app, supervisor).get('/api/samples?limit=1').expect(200)).body.total).toBeGreaterThan(0);
  });

  it('still serves checklists, custody and reports', async () => {
    const job = (await as(app, supervisor).get('/api/jobs?limit=1').expect(200)).body.rows[0];
    expect((await as(app, supervisor).get(`/api/jobs/${job.id}/checklist`).expect(200)).body.length).toBeGreaterThan(0);

    const sample = (await as(app, supervisor).get('/api/samples?limit=1').expect(200)).body.rows[0];
    await as(app, supervisor).get(`/api/samples/${sample.id}/custody`).expect(200);

    const reports = (await as(app, supervisor).get('/api/reports').expect(200)).body;
    const list = Array.isArray(reports) ? reports : reports.rows;
    if (list.length) {
      const res = await as(app, supervisor).get(`/api/public/verify/${list[0].verificationToken}`).expect(200);
      expect(res.body.valid).toBe(true);
    }
  });

  it('still exports every section, now with the laboratory ones', async () => {
    const sections = (await as(app, admin).get('/api/export/sections').expect(200)).body.sections;
    for (const s of ['jobs', 'clients', 'reports', 'invoices', 'expenses', 'assets', 'depreciation',
      'ledger', 'branches', 'commodities', 'ports', 'samples']) {
      expect(sections).toContain(s);
    }
    expect(sections).toContain('lab_requests');
    expect(sections).toContain('lab_results');
  });
});

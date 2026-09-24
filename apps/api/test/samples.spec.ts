import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/** A real 1×1 PNG: small enough to inline, real enough for sharp to make a preview from. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * The PHASE 5 acceptance scenario: a sample is taken during an inspection, registered, sealed,
 * handed over, dispatched, received at a laboratory and accepted — with the chain of custody
 * proving every step, and proving that nobody can quietly rewrite one afterwards.
 */
describe('sample lifecycle and chain of custody', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let inspectorRo: Session;
  let clientId: string;
  let jobId: string;
  let inspectionId: string;
  let sampleId: string;
  let counterSampleId: string;
  let laboratoryId: string;
  let firstCustodyEventId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);
    labManager = await login(app, ACCOUNTS.labTr);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Sampling Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({
        clientId,
        type: 'sampling',
        location: 'Port of Derince, Berth 5',
        vesselOrObject: 'MV Custody',
        commodity: 'Milling wheat',
      })
      .expect(201);
    jobId = job.body.id;

    const inspections = await as(app, supervisor).get(`/api/inspections?jobId=${jobId}`).expect(200);
    inspectionId = inspections.body.rows[0].id;

    await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, inspector).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'start' }).expect(200);

    const labs = await as(app, supervisor).get('/api/samples/laboratories').expect(200);
    laboratoryId = labs.body.find((l: { code: string }) => l.code === 'TR-LAB').id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('offers the laboratories a sample can be sent to', async () => {
    const labs = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body;
    expect(labs.length).toBeGreaterThan(0);
    expect(labs[0].code).toMatch(/-LAB$/);
  });

  it('records a sample taken during the inspection', async () => {
    const res = await as(app, inspector)
      .post('/api/samples')
      .send({
        inspectionId,
        sampleType: 'representative',
        samplingMethod: 'incremental',
        commodity: 'Milling wheat',
        quantity: 2.5,
        unit: 'kg',
        containerType: 'Sealed polythene bag',
        batchLotNumber: 'LOT-2026-114',
        containerReference: 'HOLD-3',
        location: 'Hold 3, Port of Derince',
      })
      .expect(201);

    sampleId = res.body.id;
    expect(res.body.sampleNumber).toMatch(/^TR-SMP-\d{4}-\d{5}$/);
    expect(res.body.status).toBe('draft');
    // The sample knows its job through the inspection; nobody had to type it twice.
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.inspectionId).toBe(inspectionId);
    expect(res.body.clientId).toBe(clientId);
    expect(res.body.sampledBy).toBe(inspector.user.id);
  });

  it('gives every sample a unique number, even when several are taken at once', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, () =>
        as(app, inspector)
          .post('/api/samples')
          .send({ inspectionId, sampleType: 'increment', commodity: 'Milling wheat', quantity: 1, unit: 'kg' }),
      ),
    );
    const numbers = created.map((r) => r.body.sampleNumber);
    expect(created.every((r) => r.status === 201)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.every((n: string) => /^TR-SMP-\d{4}-\d{5}$/.test(n))).toBe(true);
  });

  it('takes several samples on one inspection, including a counter sample of the same lot', async () => {
    const counter = await as(app, inspector)
      .post('/api/samples')
      .send({
        inspectionId,
        sampleType: 'counter_sample',
        commodity: 'Milling wheat',
        quantity: 2.5,
        unit: 'kg',
        batchLotNumber: 'LOT-2026-114',
        sampleGroup: 'LOT-2026-114',
      })
      .expect(201);
    counterSampleId = counter.body.id;

    const onInspection = (await as(app, inspector).get(`/api/samples?inspectionId=${inspectionId}`).expect(200)).body;
    expect(onInspection.total).toBeGreaterThanOrEqual(10);
    expect(onInspection.rows.map((s: { id: string }) => s.id)).toContain(counterSampleId);
  });

  it('refuses a parent sample that belongs to a different job', async () => {
    const otherJob = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Elsewhere' })
      .expect(201);
    const res = await as(app, supervisor)
      .post('/api/samples')
      .send({ jobId: otherJob.body.id, parentSampleId: sampleId, commodity: 'Wheat' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different job/i);
  });

  it('hides a sample from an inspector in another office', async () => {
    const list = (await as(app, inspectorRo).get('/api/samples').expect(200)).body;
    expect(list.rows.map((s: { id: string }) => s.id)).not.toContain(sampleId);
    await as(app, inspectorRo).get(`/api/samples/${sampleId}`).expect(404);
  });

  it('collects the sample, opening the chain of custody', async () => {
    const res = await as(app, inspector)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'collect', location: 'Hold 3, Port of Derince', condition: 'good' })
      .expect(200);
    expect(res.body.status).toBe('collected');

    const custody = (await as(app, inspector).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    expect(custody).toHaveLength(1);
    expect(custody[0].eventType).toBe('collected');
    expect(custody[0].toUserId).toBe(inspector.user.id);
    firstCustodyEventId = custody[0].id;
  });

  it('will not register a sample that has not said what it is', async () => {
    const bare = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat' })
      .expect(201);
    await as(app, inspector).post(`/api/samples/${bare.body.id}/transitions`).send({ action: 'collect' }).expect(200);

    const res = await as(app, supervisor)
      .post(`/api/samples/${bare.body.id}/transitions`)
      .send({ action: 'register' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/quantity/i);
  });

  it('registers the sample, and its identity is frozen from then on', async () => {
    const res = await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'register' })
      .expect(200);
    expect(res.body.status).toBe('registered');

    const rewrite = await as(app, supervisor)
      .patch(`/api/samples/${sampleId}`)
      .send({ commodity: 'Barley', quantity: 99 });
    expect(rewrite.status).toBe(409);
    expect(rewrite.body.message).toMatch(/registration settles/i);

    // The account around it is still open: notes are not identity.
    await as(app, supervisor)
      .patch(`/api/samples/${sampleId}`)
      .send({ conditionNotes: 'Bag dry, no visible damage' })
      .expect(200);
  });

  it('will not dispatch a sample that has not been sealed', async () => {
    const res = await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/sealed/i);
  });

  it('seals the sample and records the seal on the chain', async () => {
    const noNumber = await as(app, inspector).post(`/api/samples/${sampleId}/transitions`).send({ action: 'seal' });
    expect(noNumber.status).toBe(400);

    const res = await as(app, inspector)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'seal', sealNumber: 'GSI-0099321', sealType: 'Numbered plastic strip' })
      .expect(200);
    expect(res.body.status).toBe('sealed');
    expect(res.body.sealNumber).toBe('GSI-0099321');
    expect(res.body.sealState).toBe('intact');
    expect(res.body.sealedAt).toBeTruthy();
    expect(res.body.sealedBy).toBe(inspector.user.id);

    const custody = (await as(app, inspector).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    expect(custody.map((e: { eventType: string }) => e.eventType)).toEqual(['collected', 'registered', 'sealed']);
  });

  it('attaches a photograph of the seal', async () => {
    const res = await as(app, inspector)
      .post(`/api/samples/${sampleId}/attachments`)
      .field('category', 'seal')
      .field('caption', 'Seal GSI-0099321 applied')
      .attach('file', PNG_1PX, 'seal.png')
      .expect(201);
    expect(res.body.category).toBe('seal');
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const list = (await as(app, inspector).get(`/api/samples/${sampleId}/attachments`).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0].url).toBeTruthy();
  }, 30_000);

  it('records a handover without pretending the business decided anything', async () => {
    const before = (await as(app, supervisor).get(`/api/samples/${sampleId}`).expect(200)).body;

    const custody = await as(app, inspector)
      .post(`/api/samples/${sampleId}/custody`)
      .send({
        toUserId: supervisor.user.id,
        toLocation: 'Istanbul office, sample store',
        sealState: 'intact',
        condition: 'good',
        notes: 'Handed to operations at the gate',
      })
      .expect(201);
    expect(custody.body.map((e: { eventType: string }) => e.eventType)).toContain('handover');

    const after = (await as(app, supervisor).get(`/api/samples/${sampleId}`).expect(200)).body;
    expect(after.status).toBe(before.status);
    expect(after.currentCustodianId).toBe(supervisor.user.id);
    expect(after.currentLocation).toBe('Istanbul office, sample store');
  });

  it('dispatches the sample to a laboratory', async () => {
    const res = await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({
        action: 'dispatch',
        destinationLaboratoryId: laboratoryId,
        courier: 'Aras Kargo',
        trackingReference: 'AK-772311',
        packageCount: 1,
      })
      .expect(200);
    expect(res.body.status).toBe('dispatched');
    expect(res.body.destinationLaboratoryId).toBe(laboratoryId);
    expect(res.body.courier).toBe('Aras Kargo');
    expect(res.body.dispatchedAt).toBeTruthy();

    const custody = (await as(app, supervisor).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    const dispatched = custody.find((e: { eventType: string }) => e.eventType === 'dispatched');
    expect(dispatched.laboratoryId).toBe(laboratoryId);
    expect(dispatched.metadata.trackingReference).toBe('AK-772311');
  });

  it('closes the sample to editing once it has left our hands', async () => {
    const res = await as(app, supervisor).patch(`/api/samples/${sampleId}`).send({ instructions: 'Too late' });
    expect(res.status).toBe(409);
  });

  it('receives the sample at the laboratory, recording the seal condition', async () => {
    const res = await as(app, labManager)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({
        action: 'receive',
        sealState: 'intact',
        condition: 'good',
        notes: 'Seal matches the dispatch note',
      })
      .expect(200);
    expect(res.body.status).toBe('received_by_lab');
    expect(res.body.receivedSealCondition).toBe('intact');
    expect(res.body.receivedCondition).toBe('good');

    const custody = (await as(app, labManager).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    expect(custody.map((e: { eventType: string }) => e.eventType)).toContain('lab_received');
  });

  it('accepts the sample at the laboratory boundary', async () => {
    const res = await as(app, labManager)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'accept', notes: 'Booked in for moisture and protein' })
      .expect(200);
    expect(res.body.status).toBe('accepted_by_lab');
    expect(res.body.labDecisionAt).toBeTruthy();
    // Who decided is recorded without being asked for: the record must never come out blank.
    expect(res.body.labDecisionBy).toBe(labManager.user.id);
    expect(res.body.labDecisionByName).toBeTruthy();

    const custody = (await as(app, labManager).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    expect(custody.map((e: { eventType: string }) => e.eventType)).toEqual([
      'collected', 'registered', 'sealed', 'handover', 'dispatched', 'lab_received', 'lab_accepted',
    ]);
  });

  it('is finished: an accepted sample cannot be moved or edited any further', async () => {
    const res = await as(app, labManager)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'receive' });
    expect(res.status).toBe(409);
    await as(app, supervisor).patch(`/api/samples/${sampleId}`).send({ instructions: 'no' }).expect(409);
  });

  it('never lets a custody entry be edited or deleted, only corrected', async () => {
    // There is no PATCH and no DELETE for a custody entry at all.
    await as(app, labManager).patch(`/api/samples/${sampleId}/custody/${firstCustodyEventId}`).send({ notes: 'x' }).expect(404);
    await as(app, labManager).delete(`/api/samples/${sampleId}/custody/${firstCustodyEventId}`).expect(404);

    const before = (await as(app, labManager).get(`/api/samples/${sampleId}/custody`).expect(200)).body;
    const corrected = await as(app, supervisor)
      .post(`/api/samples/${sampleId}/custody/${firstCustodyEventId}/corrections`)
      .send({ notes: 'Collected from hold 4, not hold 3', toLocation: 'Hold 4, Port of Derince' })
      .expect(201);

    // The original survives, the correction points at it, and both are on the timeline.
    expect(corrected.body).toHaveLength(before.length + 1);
    const original = corrected.body.find((e: { id: string }) => e.id === firstCustodyEventId);
    expect(original.toLocation).toBe('Hold 3, Port of Derince');
    expect(original.correctedByEventId).toBeTruthy();
    const correction = corrected.body.find((e: { eventType: string }) => e.eventType === 'correction');
    expect(correction.correctsEventId).toBe(firstCustodyEventId);

    const twice = await as(app, supervisor)
      .post(`/api/samples/${sampleId}/custody/${firstCustodyEventId}/corrections`)
      .send({ notes: 'again' });
    expect(twice.status).toBe(409);
  });

  it('rejects a sample at the laboratory, with a reason it has to give', async () => {
    await as(app, supervisor).post(`/api/samples/${counterSampleId}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${counterSampleId}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'seal', sealNumber: 'GSI-0099322' })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId })
      .expect(200);
    await as(app, labManager)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'receive', sealState: 'broken', condition: 'damaged' })
      .expect(200);

    const noReason = await as(app, labManager)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'reject' });
    expect(noReason.status).toBe(400);

    const res = await as(app, labManager)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'reject', rejectionReason: 'broken_seal', reason: 'Seal missing on arrival' })
      .expect(200);
    expect(res.body.status).toBe('rejected_by_lab');
    expect(res.body.rejectionReason).toBe('broken_seal');
    // A broken seal on arrival is recorded as such, not quietly forgotten.
    expect(res.body.sealBrokenAt).toBeTruthy();
  });

  it('sends a rejected sample back to the office', async () => {
    const res = await as(app, supervisor)
      .post(`/api/samples/${counterSampleId}/transitions`)
      .send({ action: 'return', reason: 'Re-sealing and re-sending' })
      .expect(200);
    expect(res.body.status).toBe('registered');

    const custody = (await as(app, supervisor).get(`/api/samples/${counterSampleId}/custody`).expect(200)).body;
    expect(custody.map((e: { eventType: string }) => e.eventType)).toContain('returned');
  });

  it('refuses a save built on a stale copy of the record', async () => {
    const fresh = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat', quantity: 1, unit: 'kg' })
      .expect(201);
    const x = fresh.body;

    await as(app, inspector)
      .patch(`/api/samples/${x.id}`)
      .send({ conditionNotes: 'First edit', version: x.version })
      .expect(200);

    const stale = await as(app, inspector)
      .patch(`/api/samples/${x.id}`)
      .send({ conditionNotes: 'Second edit on a stale copy', version: x.version });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/another user/i);
  });

  it('kept the whole story in the status history', async () => {
    const history = (await as(app, supervisor).get(`/api/samples/${sampleId}/history`).expect(200)).body;
    expect(history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'draft', 'collected', 'registered', 'sealed', 'dispatched', 'received_by_lab', 'accepted_by_lab',
    ]);
    expect(history.every((h: { changedByName: string }) => h.changedByName)).toBe(true);
  });

  it('recorded every step in the audit log as well', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${sampleId}`).expect(200)).body;
    const actions: string[] = log.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('sample.create');
    expect(actions).toContain('sample.collect');
    expect(actions).toContain('sample.register');
    expect(actions).toContain('sample.seal');
    expect(actions).toContain('sample.handover');
    expect(actions).toContain('sample.dispatch');
    expect(actions).toContain('sample.receive');
    expect(actions).toContain('sample.accept');
    expect(actions).toContain('sample.attachment_added');
    expect(actions).toContain('sample.custody_corrected');
  });

  it('prints a label whose QR needs a session, not a public page', async () => {
    const res = await as(app, inspector).get(`/api/samples/${sampleId}/label`).expect(200);
    expect(res.body.sampleNumber).toMatch(/^TR-SMP-/);
    expect(res.body.sealNumber).toBe('GSI-0099321');
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // A deep link into the application, which is behind authentication and Row-Level Security.
    expect(res.body.url).toContain(`/samples/${sampleId}`);
    expect(res.body.url).not.toMatch(/verify|token/i);
  });

  it('searches by the things somebody at a counter actually has in hand', async () => {
    const bySeal = (await as(app, supervisor).get('/api/samples?search=GSI-0099321').expect(200)).body;
    expect(bySeal.rows.map((s: { id: string }) => s.id)).toContain(sampleId);

    const byLot = (await as(app, supervisor).get('/api/samples?search=LOT-2026-114').expect(200)).body;
    expect(byLot.total).toBeGreaterThanOrEqual(2);

    const sample = (await as(app, supervisor).get(`/api/samples/${sampleId}`).expect(200)).body;
    const byNumber = (await as(app, supervisor).get(`/api/samples?search=${sample.sampleNumber}`).expect(200)).body;
    expect(byNumber.rows).toHaveLength(1);
  });

  it('filters and pages like every other list in the system', async () => {
    const page = (await as(app, supervisor).get('/api/samples?limit=5&offset=0').expect(200)).body;
    expect(page.rows.length).toBeLessThanOrEqual(5);
    expect(page.limit).toBe(5);
    expect(page.total).toBeGreaterThan(5);

    const byStatus = (await as(app, supervisor).get('/api/samples?status=accepted_by_lab').expect(200)).body;
    expect(byStatus.rows.every((s: { status: string }) => s.status === 'accepted_by_lab')).toBe(true);

    const open = (await as(app, supervisor).get('/api/samples?active=true').expect(200)).body;
    expect(open.rows.every((s: { status: string }) => !['accepted_by_lab', 'cancelled'].includes(s.status))).toBe(true);

    const byLab = (await as(app, supervisor).get(`/api/samples?laboratoryId=${laboratoryId}`).expect(200)).body;
    expect(byLab.total).toBeGreaterThanOrEqual(1);

    const mine = (await as(app, inspector).get('/api/samples?mine=true').expect(200)).body;
    expect(mine.rows.every((s: { sampledByName: string | null }) => s.sampledByName !== null)).toBe(true);
  });

  it('archives and restores a sample that never went anywhere', async () => {
    const spare = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat', quantity: 1, unit: 'kg' })
      .expect(201);
    await as(app, supervisor).delete(`/api/samples/${spare.body.id}`).expect(204);

    const list = (await as(app, supervisor).get(`/api/samples?inspectionId=${inspectionId}`).expect(200)).body;
    expect(list.rows.map((s: { id: string }) => s.id)).not.toContain(spare.body.id);

    const restored = await as(app, admin).post(`/api/samples/${spare.body.id}/restore`).expect(200);
    expect(restored.body.id).toBe(spare.body.id);
    await as(app, supervisor).get(`/api/samples/${spare.body.id}`).expect(200);
  });

  it('refuses to archive a sample that is already on its way', async () => {
    const res = await as(app, supervisor).delete(`/api/samples/${sampleId}`);
    expect(res.status).toBe(409);
  });

  it('shows the samples on the job and on the inspection', async () => {
    const onJob = (await as(app, supervisor).get(`/api/samples?jobId=${jobId}`).expect(200)).body;
    expect(onJob.rows.map((s: { id: string }) => s.id)).toContain(sampleId);

    const onInspection = (await as(app, supervisor).get(`/api/samples?inspectionId=${inspectionId}`).expect(200)).body;
    expect(onInspection.rows.map((s: { id: string }) => s.id)).toContain(sampleId);
    expect(onInspection.rows.every((s: { jobId: string }) => s.jobId === jobId)).toBe(true);
  });

  it('does not require a sample before an inspection can be completed', async () => {
    // Not every inspection involves sampling, and a blanket rule would block the ones that do not.
    const other = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'cleanliness', location: 'Berth 1' })
      .expect(201);
    const list = (await as(app, supervisor).get(`/api/inspections?jobId=${other.body.id}`).expect(200)).body;
    const id = list.rows[0].id;

    await as(app, supervisor)
      .post(`/api/inspections/${id}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, inspector).post(`/api/inspections/${id}/transitions`).send({ action: 'start' }).expect(200);

    const checklist = (await as(app, inspector).get(`/api/inspections/${id}/checklist`).expect(200)).body;
    await as(app, inspector)
      .patch(`/api/inspections/${id}/checklist`)
      .send({ answers: checklist.items.map((i: { id: string }) => ({ itemId: i.id, result: 'ok' })) })
      .expect(200);

    const samples = (await as(app, supervisor).get(`/api/samples?inspectionId=${id}`).expect(200)).body;
    expect(samples.total).toBe(0);

    const res = await as(app, inspector).post(`/api/inspections/${id}/transitions`).send({ action: 'complete' });
    expect(res.status).toBe(200);
  });

  it('exports samples without disturbing the sections that were already there', async () => {
    const sections = (await as(app, admin).get('/api/export/sections').expect(200)).body.sections;
    expect(sections).toContain('samples');
    for (const existing of ['jobs', 'clients', 'reports', 'invoices', 'expenses', 'assets',
      'depreciation', 'ledger', 'branches', 'commodities', 'ports']) {
      expect(sections).toContain(existing);
    }

    const csv = await as(app, admin).get('/api/export/samples').expect(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    expect(String(csv.text)).toContain('Sample no.');
    expect(String(csv.text)).toContain('GSI-0099321');
  });

  it('keeps the laboratory decision behind its own permission', async () => {
    const fresh = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat', quantity: 1, unit: 'kg' })
      .expect(201);
    await as(app, inspector).post(`/api/samples/${fresh.body.id}/transitions`).send({ action: 'collect' }).expect(200);

    // An inspector may take and seal samples, but not decide what a laboratory accepts.
    const res = await as(app, inspector)
      .post(`/api/samples/${fresh.body.id}/transitions`)
      .send({ action: 'accept' });
    expect([403, 409]).toContain(res.status);
    if (res.status === 403) expect(res.body.message).toMatch(/permission/i);
  });

  it('tells a field worker only what they may do right now', async () => {
    const fresh = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodity: 'Wheat', quantity: 1, unit: 'kg' })
      .expect(201);
    const x = (await as(app, inspector).get(`/api/samples/${fresh.body.id}`).expect(200)).body;
    expect(x.actions).toContain('collect');
    expect(x.actions).not.toContain('accept');
    expect(x.actions).not.toContain('receive');
  });


});

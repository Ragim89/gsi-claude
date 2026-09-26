import { INestApplication } from '@nestjs/common';
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The guarantees a document has to keep after it has left the building, each one on its own.
 *
 * PHASE 7 proved the happy path end to end. This suite takes the four claims that would be
 * expensive to be wrong about — only released work is quotable, an issued document stops
 * changing, the number a certificate prints is the number that was measured, and a laboratory
 * abroad sees the work and not the commerce — and checks each of them separately, so a failure
 * says which promise broke.
 */

/** A sample accepted in the Istanbul laboratory, ready for analyses to be requested on it. */
async function acceptedSample(
  app: INestApplication,
  s: { supervisor: Session; inspector: Session; labManager: Session },
  clientId: string,
  commodityId: string,
  laboratoryId: string,
) {
  const job = await as(app, s.supervisor)
    .post('/api/jobs')
    .send({ clientId, type: 'sampling', location: 'Port of Derince, Berth 7', commodityId })
    .expect(201);
  const inspectionId = (await as(app, s.supervisor).get(`/api/inspections?jobId=${job.body.id}`).expect(200))
    .body.rows[0].id;
  await as(app, s.supervisor)
    .post(`/api/inspections/${inspectionId}/assignments`)
    .send({ userId: s.inspector.user.id, role: 'lead_inspector' })
    .expect(201);
  await as(app, s.inspector).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'start' }).expect(200);

  const sample = await as(app, s.inspector)
    .post('/api/samples')
    .send({ inspectionId, commodityId, quantity: 2, unit: 'kg' })
    .expect(201);
  const sampleId = sample.body.id;
  await as(app, s.inspector).post(`/api/samples/${sampleId}/transitions`).send({ action: 'collect' }).expect(200);
  await as(app, s.supervisor).post(`/api/samples/${sampleId}/transitions`).send({ action: 'register' }).expect(200);
  await as(app, s.inspector)
    .post(`/api/samples/${sampleId}/transitions`)
    .send({ action: 'seal', sealNumber: `INT-${Date.now().toString().slice(-8)}` })
    .expect(200);
  await as(app, s.supervisor)
    .post(`/api/samples/${sampleId}/transitions`)
    .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId })
    .expect(200);
  await as(app, s.labManager)
    .post(`/api/samples/${sampleId}/transitions`)
    .send({ action: 'receive', sealState: 'intact', condition: 'good' })
    .expect(200);
  await as(app, s.labManager).post(`/api/samples/${sampleId}/transitions`).send({ action: 'accept' }).expect(200);

  return { jobId: job.body.id as string, inspectionId: inspectionId as string, sampleId: sampleId as string };
}

// ================================================================================================
// Only released laboratory work reaches a document — one test per state it could be stopped in.
// ================================================================================================

describe('documents: a result is quotable only once it is released', () => {
  let app: INestApplication;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let analyst: Session;

  let jobId: string;

  /** Requests `code` on the sample and walks its result exactly as far as `upTo`. */
  async function analysisStoppedAt(sampleId: string, code: string, upTo: string) {
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const test = tests.find((t: { code: string }) => t.code === code);
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${test.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: test.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: '1.5', unit: '%' })
      .expect(200);
    if (upTo === 'entered') return request.id;

    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    if (upTo === 'submitted') return request.id;

    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    if (upTo === 'reviewed') return request.id;

    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);
    if (upTo === 'approved') return request.id;

    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);
    return request.id;
  }

  async function quotedCodes(): Promise<string[]> {
    const sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    return sources.results.map((r: { testCode: string }) => r.testCode);
  }

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);

    const clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Release gate ${Date.now()}`, country: 'TR' })
      .expect(201)).body.id;
    const commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;
    const laboratoryId = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'TR-LAB').id;

    const made = await acceptedSample(app, { supervisor, inspector, labManager }, clientId, commodityId, laboratoryId);
    jobId = made.jobId;

    await analysisStoppedAt(made.sampleId, 'moisture', 'entered');
    await analysisStoppedAt(made.sampleId, 'protein', 'submitted');
    await analysisStoppedAt(made.sampleId, 'gluten', 'reviewed');
    await analysisStoppedAt(made.sampleId, 'test_weight', 'approved');
    await analysisStoppedAt(made.sampleId, 'oil_content', 'released');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('leaves out a result the analyst has only entered', async () => {
    expect(await quotedCodes()).not.toContain('moisture');
  });

  it('leaves out a result that has been handed in but not looked at', async () => {
    expect(await quotedCodes()).not.toContain('protein');
  });

  it('leaves out a result that has been reviewed but not approved', async () => {
    expect(await quotedCodes()).not.toContain('gluten');
  });

  it('leaves out a result that is approved but not released', async () => {
    // The distinction the whole laboratory module rests on: "the number is right" is not the
    // same statement as "the number may be shown to the client".
    expect(await quotedCodes()).not.toContain('test_weight');
  });

  it('takes a released result, and says which method it was measured by', async () => {
    const sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    const quoted = sources.results.find((r: { testCode: string }) => r.testCode === 'oil_content');
    expect(quoted).toBeTruthy();
    expect(quoted.methodCode).toBeTruthy();
    expect(quoted.value).toBe('1.5');
  });

  it('quotes nothing else: exactly one of the five analyses is offered', async () => {
    const wanted = ['moisture', 'protein', 'gluten', 'test_weight', 'oil_content'];
    expect((await quotedCodes()).filter((c) => wanted.includes(c))).toEqual(['oil_content']);
  });
});

// ================================================================================================
// What a document says stops changing when it is issued.
// ================================================================================================

describe('documents: issued means finished', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let analyst: Session;

  let clientId: string;
  let jobId: string;
  let reportId: string;
  let issuedChecksum: string;
  let issuedBytes: Buffer;
  let templateId: string;
  let templateVersionAtIssue: number;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);

    clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Frozen Facts ${Date.now()}`, country: 'TR', address: 'Rıhtım Caddesi 1, Kocaeli' })
      .expect(201)).body.id;
    const commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;
    const laboratoryId = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'TR-LAB').id;

    const made = await acceptedSample(app, { supervisor, inspector, labManager }, clientId, commodityId, laboratoryId);
    jobId = made.jobId;

    // A released moisture result of 12.40 — the trailing zero is the point of it.
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const moisture = tests.find((t: { code: string }) => t.code === 'moisture');
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${moisture.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId: made.sampleId, tests: [{ labTestId: moisture.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: '12.40', unit: '%' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);

    // A certificate of analysis: written, reviewed by somebody else, approved and issued.
    const created = await as(app, supervisor)
      .post('/api/reports')
      .send({
        jobId,
        reportType: 'certificate_of_analysis',
        language: 'en',
        content: { executiveSummary: 'Moisture determined on the sealed sample as received.' },
      })
      .expect(201);
    reportId = created.body.id;
    templateId = created.body.currentVersion.templateId;
    templateVersionAtIssue = created.body.currentVersion.templateVersion;

    await as(app, supervisor).post(`/api/reports/${reportId}/submit`).expect(200);
    await as(app, admin).post(`/api/reports/${reportId}/review`).send({}).expect(200);
    await as(app, admin).post(`/api/reports/${reportId}/approve`).expect(200);
    const issued = await as(app, admin).post(`/api/reports/${reportId}/issue`).expect(200);
    issuedChecksum = issued.body.currentVersion.pdfSha256;

    const file = await as(app, admin).get(`/api/reports/${reportId}/file`).expect(200);
    issuedBytes = file.body as Buffer;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  // ---- The file ----------------------------------------------------------------------------

  it('stores the file it issued, and the file answers to the checksum it recorded', async () => {
    expect(issuedChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(issuedBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(issuedBytes).digest('hex')).toBe(issuedChecksum);
  });

  it('gives the same bytes on a second download, because it is not rendered again', async () => {
    const again = await as(app, admin).get(`/api/reports/${reportId}/file`).expect(200);
    expect(createHash('sha256').update(again.body as Buffer).digest('hex')).toBe(issuedChecksum);
  });

  it('publishes that checksum where the holder of the paper can check it', async () => {
    const token = (await as(app, admin).get(`/api/reports/${reportId}`).expect(200)).body.verificationToken;
    const verified = await as(app, admin).get(`/api/public/verify/${token}`).expect(200);
    expect(verified.body.checksum).toBe(issuedChecksum);
  });

  // ---- The facts ---------------------------------------------------------------------------

  it('keeps saying what it said after the client is renamed and the job is rewritten', async () => {
    const before = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body[0];
    const nameOnTheCertificate = before.dataSnapshot.client.name;
    const addressOnTheCertificate = before.dataSnapshot.client.address;
    const locationOnTheCertificate = before.dataSnapshot.job.location;

    await as(app, supervisor)
      .patch(`/api/clients/${clientId}`)
      .send({ name: `Renamed After Issue ${Date.now()}`, address: 'Somewhere else entirely' })
      .expect(200);
    await as(app, supervisor)
      .patch(`/api/jobs/${jobId}`)
      .send({ location: 'A different berth in a different port' })
      .expect(200);

    const after = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body[0];
    expect(after.dataSnapshot.client.name).toBe(nameOnTheCertificate);
    expect(after.dataSnapshot.client.address).toBe(addressOnTheCertificate);
    expect(after.dataSnapshot.job.location).toBe(locationOnTheCertificate);
    expect(after.dataSnapshot.client.name).not.toMatch(/Renamed After Issue/);

    // And the file did not move either.
    const file = await as(app, admin).get(`/api/reports/${reportId}/file`).expect(200);
    expect(createHash('sha256').update(file.body as Buffer).digest('hex')).toBe(issuedChecksum);
  });

  // ---- The form ----------------------------------------------------------------------------

  it('was printed on the form of the day, and stays on it after the form is changed', async () => {
    expect(templateVersionAtIssue).toBeGreaterThanOrEqual(1);

    const bumped = await as(app, admin)
      .patch(`/api/report-templates/${templateId}`)
      .send({
        definition: {
          sections: [{ section: 'header' }, { section: 'client' }, { section: 'samples' },
                     { section: 'lab_results' }, { section: 'signatures' }, { section: 'qr' }],
        },
      })
      .expect(200);
    expect(bumped.body.version).toBeGreaterThan(templateVersionAtIssue);

    // The issued revision still says which form printed it, and the file is untouched.
    const version = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body[0];
    expect(version.templateVersion).toBe(templateVersionAtIssue);
    const file = await as(app, admin).get(`/api/reports/${reportId}/file`).expect(200);
    expect(createHash('sha256').update(file.body as Buffer).digest('hex')).toBe(issuedChecksum);

    // A document started now takes the new form.
    const fresh = await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId, reportType: 'certificate_of_analysis', language: 'en' })
      .expect(201);
    expect(fresh.body.currentVersion.templateVersion).toBe(bumped.body.version);
  });

  // ---- No way back -------------------------------------------------------------------------

  it('refuses a paragraph filed under a name no document prints', async () => {
    // Stored-and-never-printed is the worst answer: the author sees a saved document and an
    // empty page. The known fields are the contract, and anything else is a mistake worth a 400.
    const typo = await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId, reportType: 'certificate_of_analysis', language: 'en', content: { summary: 'Wrong key' } });
    expect(typo.status).toBe(400);

    const tooLong = await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId, reportType: 'certificate_of_analysis', content: { executiveSummary: 'x'.repeat(20001) } });
    expect(tooLong.status).toBe(400);
  });

  it('refuses to be edited, and refuses to be filed away as if it had never been sent', async () => {
    await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { executiveSummary: 'A different conclusion' } })
      .expect(409);
    // Cancelling is the honest way to withdraw an issued document; archiving is not.
    await as(app, admin).delete(`/api/reports/${reportId}`).expect(409);
  });

  // ---- The revision ------------------------------------------------------------------------

  it('gives each revision its own file, its own checksum and its own code', async () => {
    await as(app, supervisor)
      .post(`/api/reports/${reportId}/revisions`)
      .send({ reason: 'Client asked for the sampling date to be spelled out' })
      .expect(201);
    await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { executiveSummary: 'Moisture determined on the sealed sample as received, 14 March.' } })
      .expect(200);
    await as(app, supervisor).post(`/api/reports/${reportId}/submit`).expect(200);
    // A revision is a document too: whoever opened it does not get to sign it off either.
    await as(app, supervisor).post(`/api/reports/${reportId}/review`).send({}).expect(409);
    await as(app, admin).post(`/api/reports/${reportId}/review`).send({}).expect(200);
    await as(app, admin).post(`/api/reports/${reportId}/approve`).expect(200);
    const issued = await as(app, admin).post(`/api/reports/${reportId}/issue`).expect(200);

    const versions = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body;
    const second = versions.find((v: { versionNumber: number }) => v.versionNumber === 2);
    const first = versions.find((v: { versionNumber: number }) => v.versionNumber === 1);

    expect(second.pdfSha256).not.toBe(first.pdfSha256);
    expect(second.qrToken).not.toBe(first.qrToken);
    expect(second.pdfStorageKey).not.toBe(first.pdfStorageKey);
    expect(issued.body.currentVersion.pdfSha256).toBe(second.pdfSha256);

    // The first revision is still the first revision: the same bytes it was sent as.
    const old = await as(app, admin).get(`/api/reports/${reportId}/file?version=1`).expect(200);
    expect(createHash('sha256').update(old.body as Buffer).digest('hex')).toBe(issuedChecksum);
    expect(first.pdfSha256).toBe(issuedChecksum);

    // And the precision the analyst typed is part of both snapshots, not recomputed for either.
    expect(first.dataSnapshot.results[0].value).toBe('12.40');
    expect(second.dataSnapshot.results[0].value).toBe('12.40');
  });
});

// ================================================================================================
// The number a certificate prints is the number that was measured.
// ================================================================================================

describe('documents: the printed number is the measured number', () => {
  let app: INestApplication;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let analyst: Session;

  let jobId: string;
  let sampleId: string;

  /** Releases `code` with exactly this typed value, and returns what a document would print. */
  async function printed(code: string, typed: string): Promise<string> {
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const test = tests.find((t: { code: string }) => t.code === code);
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${test.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: test.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: typed, unit: '%' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);

    const sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    return sources.results.find((r: { testCode: string }) => r.testCode === code).value;
  }

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);

    const clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Significant Figures ${Date.now()}`, country: 'TR' })
      .expect(201)).body.id;
    const commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;
    const laboratoryId = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'TR-LAB').id;

    const made = await acceptedSample(app, { supervisor, inspector, labManager }, clientId, commodityId, laboratoryId);
    jobId = made.jobId;
    sampleId = made.sampleId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('prints 12.40 as 12.40, because the trailing zero says how well it was measured', async () => {
    expect(await printed('moisture', '12.40')).toBe('12.40');
  });

  it('prints 12.4 as 12.4, because that is what was claimed', async () => {
    expect(await printed('protein', '12.4')).toBe('12.4');
  });

  it('prints 0.001 without turning it into 0.0009999999', async () => {
    expect(await printed('aflatoxin', '0.001')).toBe('0.001');
  });

  it('prints 12345.6789 with every digit it was given', async () => {
    expect(await printed('falling_number', '12345.6789')).toBe('12345.6789');
  });

  it('still keeps the number as a number, for anything that has to compare it', async () => {
    const released = (await as(app, labManager).get(`/api/lab/released?sampleId=${sampleId}`).expect(200)).body;
    const moisture = released.find((r: { testCode: string }) => r.testCode === 'moisture');
    expect(moisture.numericValue).toBe(12.4);
    expect(moisture.numericText).toBe('12.40');
    // Numeric enough to be judged against a limit, text enough to be printed.
    expect(['within_spec', 'out_of_spec', 'not_evaluated']).toContain(moisture.evaluation);
  });

  it('refuses a number it cannot keep, rather than rounding it quietly', async () => {
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const test = tests.find((t: { code: string }) => t.code === 'gluten');
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${test.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: test.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    const refused = await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: '1.23456789', unit: '%' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/decimal places/i);
  });
});

// ================================================================================================
// A laboratory abroad sees the work, not the commerce.
// ================================================================================================

describe('documents: the receiving laboratory sees the work and not the commerce', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let supervisorRo: Session;

  let clientId: string;
  let jobId: string;
  let sampleId: string;
  let invoiceId: string;
  let contractId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    supervisorRo = await login(app, ACCOUNTS.supervisorRo);

    clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({
        name: `Commercially Sensitive ${Date.now()}`,
        country: 'TR',
        address: 'Liman Mahallesi 44, Mersin',
        notes: 'Pays late; negotiated 12% off the tariff for 2026.',
      })
      .expect(201)).body.id;
    await as(app, supervisor)
      .post(`/api/clients/${clientId}/contacts`)
      .send({ fullName: 'Commercial Director', position: 'Commercial', email: 'deals@client.example' })
      .expect(201);
    contractId = (await as(app, supervisor)
      .post('/api/contracts')
      .send({
        clientId,
        contractNo: `XO-${Date.now().toString().slice(-8)}`,
        title: 'Frame agreement with negotiated tariff',
        status: 'active',
        currency: 'EUR',
        valueAmount: 480000,
        paymentTermsDays: 45,
      })
      .expect(201)).body.id;

    const commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;
    const roLab = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'RO-LAB');

    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Mersin, Berth 2', commodityId })
      .expect(201);
    jobId = job.body.id;
    const inspectionId = (await as(app, supervisor).get(`/api/inspections?jobId=${jobId}`).expect(200))
      .body.rows[0].id;
    await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    await as(app, inspector).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'start' }).expect(200);

    const sample = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodityId, quantity: 3, unit: 'kg' })
      .expect(201);
    sampleId = sample.body.id;
    await as(app, inspector).post(`/api/samples/${sampleId}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${sampleId}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspector)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'seal', sealNumber: `CM-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: roLab.id })
      .expect(200);

    invoiceId = (await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId,
        jobId,
        lines: [{ description: 'Sampling and analysis, negotiated tariff', quantity: 1, unitPrice: 4200 }],
        taxRate: 20,
      })
      .expect(201)).body.id;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  it('gives the laboratory the brief it needs to do the analysis', async () => {
    const brief = (await as(app, supervisorRo).get(`/api/lab/samples/${sampleId}/brief`).expect(200)).body;
    expect(brief.sampleNumber).toBeTruthy();
    expect(brief.sealNumber).toBeTruthy();
    expect(brief.commodity).toBeTruthy();
    expect(brief.quantity).toBeTruthy();
    expect(brief.jobNumber).toBeTruthy();
    // Whose material is on the bench: a chain of custody cannot be kept without it.
    expect(brief.clientName).toBeTruthy();
  });

  it('puts nothing commercial in the brief', async () => {
    const brief = (await as(app, supervisorRo).get(`/api/lab/samples/${sampleId}/brief`).expect(200)).body;
    for (const field of ['clientAddress', 'contractId', 'contractNo', 'valueAmount', 'tariff',
                         'paymentTermsDays', 'internalNotes', 'notes', 'invoiceNumber', 'unitPrice']) {
      expect(brief).not.toHaveProperty(field);
    }
    const printed = JSON.stringify(brief);
    expect(printed).not.toMatch(/negotiated/i);
    expect(printed).not.toMatch(/Liman Mahallesi/);
    expect(printed).not.toMatch(/4200|480000/);
  });

  it('does not open the client behind it — not the card, not the contacts', async () => {
    await as(app, supervisorRo).get(`/api/clients/${clientId}`).expect(404);
    // The contacts endpoint answers, and answers with nothing: the row-level policy on
    // `client_contacts` is what empties it, not a filter in the handler.
    const contacts = await as(app, supervisorRo).get(`/api/clients/${clientId}/contacts`).expect(200);
    expect(contacts.body).toEqual([]);
    const found = (await as(app, supervisorRo).get('/api/clients?search=Commercially Sensitive').expect(200)).body;
    expect((found.rows ?? found).map((c: { id: string }) => c.id)).not.toContain(clientId);
  });

  it('does not open the contract or its value', async () => {
    await as(app, supervisorRo).get(`/api/contracts/${contractId}`).expect(404);
    const list = (await as(app, supervisorRo).get(`/api/contracts?clientId=${clientId}`).expect(200)).body;
    expect((list.rows ?? list).map((c: { id: string }) => c.id)).not.toContain(contractId);
  });

  it('does not open the invoice, although it may read invoices in its own office', async () => {
    await as(app, supervisorRo).get(`/api/finance/invoices/${invoiceId}`).expect(404);
    const invoices = (await as(app, supervisorRo).get('/api/finance/invoices').expect(200)).body;
    expect((invoices.rows ?? invoices).map((i: { id: string }) => i.id)).not.toContain(invoiceId);
  });

  it('does not open the job, and opens the sample card with nothing commercial on it', async () => {
    await as(app, supervisorRo).get(`/api/jobs/${jobId}`).expect(404);

    // PHASE 13: the full sample card used to 404 for a receiving office too, because it is read
    // through a join to `inspection_jobs`/`clients` — the same tables the two assertions above
    // are denied outright — and neither table's RLS knows about the laboratory exception. That
    // silently broke `receive`/`accept` for the receiving office's own staff, not just the read.
    // The fix (samples.service.ts) lets the sample row itself survive (it was already visible by
    // policy, `app_sees_laboratory`) while the join columns fall back to null exactly where RLS
    // would have hidden them anyway — no commercial data crosses that was not crossing before.
    const card = (await as(app, supervisorRo).get(`/api/samples/${sampleId}`).expect(200)).body;
    expect(card.clientName).toBeNull();
    expect(card.jobNumber).toBeNull();
    expect(card.branchCode).toBeNull();
    expect(card).not.toHaveProperty('contractId');
    expect(card).not.toHaveProperty('invoiceId');
    expect(card).not.toHaveProperty('clientAddress');
    const printed = JSON.stringify(card);
    expect(printed).not.toMatch(/negotiated/i);
    expect(printed).not.toMatch(/Liman Mahallesi/);
    expect(printed).not.toMatch(/4200|480000/);
  });
});

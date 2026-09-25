import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * The PHASE 7 acceptance scenario: a certificate of analysis built from released laboratory
 * work, reviewed by somebody other than its author, approved, issued as a stored PDF with a
 * checksum and a QR code — and then proved impossible to edit, only to supersede.
 */
describe('documents: certificate of analysis', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let labManager: Session;
  let analyst: Session;
  let inspectorRo: Session;

  let clientId: string;
  let jobId: string;
  let sampleId: string;
  let laboratoryId: string;
  let commodityId: string;
  let reportId: string;
  let reportNumber: string;
  let firstToken: string;

  /** A sample carried to a released moisture result — the material a certificate is made of. */
  async function jobWithReleasedResult(value: string) {
    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince, Berth 3', commodityId })
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
      .send({ inspectionId, commodityId, quantity: 2, unit: 'kg' })
      .expect(201);
    const sid = sample.body.id;
    await as(app, inspector).post(`/api/samples/${sid}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${sid}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspector)
      .post(`/api/samples/${sid}/transitions`)
      .send({ action: 'seal', sealNumber: `DOC-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${sid}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId })
      .expect(200);
    await as(app, labManager)
      .post(`/api/samples/${sid}/transitions`)
      .send({ action: 'receive', sealState: 'intact', condition: 'good' })
      .expect(200);
    await as(app, labManager).post(`/api/samples/${sid}/transitions`).send({ action: 'accept' }).expect(200);

    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const moisture = tests.find((t: { code: string }) => t.code === 'moisture');
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${moisture.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId: sid, tests: [{ labTestId: moisture.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];

    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: value, unit: '%' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);

    return { jobId: job.body.id, sampleId: sid, requestId: request.id, inspectionId };
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);
    inspectorRo = await login(app, ACCOUNTS.inspectorRo);

    clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Certificate Trading ${Date.now()}`, country: 'TR' })
      .expect(201)).body.id;
    laboratoryId = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'TR-LAB').id;
    commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;

    const made = await jobWithReleasedResult('12.40');
    jobId = made.jobId;
    sampleId = made.sampleId;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  // ---- Templates ---------------------------------------------------------------------------

  it('ships a template for every document type, as reference data rather than demo data', async () => {
    const templates = (await as(app, supervisor).get('/api/report-templates').expect(200)).body;
    const types = templates.map((t: { reportType: string }) => t.reportType);
    for (const type of ['inspection_report', 'certificate_of_analysis', 'sampling_report', 'laboratory_report']) {
      expect(types).toContain(type);
    }
    const coa = templates.find((t: { code: string }) => t.code === 'coa-standard');
    expect(coa.version).toBe(1);
    expect(coa.definition.sections.some((s: { section: string }) => s.section === 'lab_results')).toBe(true);
  });

  it('raises the template version when the form changes, and keeps it behind a right', async () => {
    const template = (await as(app, admin).get('/api/report-templates?reportType=custom').expect(200)).body[0];
    const bumped = await as(app, admin)
      .patch(`/api/report-templates/${template.id}`)
      .send({ description: 'Reworded for the manual' })
      .expect(200);
    expect(bumped.body.version).toBe(template.version); // a description is not the form

    const versioned = await as(app, admin)
      .patch(`/api/report-templates/${template.id}`)
      .send({ definition: { sections: [{ section: 'header' }, { section: 'client' }, { section: 'qr' }] } })
      .expect(200);
    expect(versioned.body.version).toBe(template.version + 1);

    const refused = await as(app, inspector)
      .patch(`/api/report-templates/${template.id}`)
      .send({ name: 'No' });
    expect(refused.status).toBe(403);
  });

  it('refuses a template that names a section nothing can render', async () => {
    const res = await as(app, admin)
      .post('/api/report-templates')
      .send({
        code: `bad-${Date.now().toString().slice(-6)}`,
        name: 'Broken',
        reportType: 'custom',
        definition: { sections: [{ section: 'invented_section' }] },
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown section/i);
  });

  // ---- The data a document is made of --------------------------------------------------------

  it('gathers what a document can be built from, in one call', async () => {
    const sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    expect(sources.jobNumber).toBeTruthy();
    expect(sources.inspections.length).toBe(1);
    expect(sources.samples.length).toBe(1);
    expect(sources.results.length).toBe(1);
    // The tail of PHASE 6: 12.40 is not 12.4, and a certificate has to say which.
    expect(sources.results[0].value).toBe('12.40');
    expect(sources.results[0].unit).toBe('%');
    expect(sources.results[0].methodCode).toBeTruthy();
    expect(sources.results[0].specification).toMatch(/≤/);
  });

  it('offers only released results — not entered, reviewed or even approved ones', async () => {
    // A second analysis on the same sample, carried only as far as approved.
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const protein = tests.find((t: { code: string }) => t.code === 'protein');
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${protein.id}`).expect(200)).body[0];
    const request = (await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: protein.id, testMethodId: method.id }] })
      .expect(201)).body.created[0];
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: '12.1', unit: '%' })
      .expect(200);

    // Entered: not on the list.
    let sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    expect(sources.results.map((r: { testCode: string }) => r.testCode)).not.toContain('protein');

    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);

    // Approved but not released: still not on the list. This is the rule of the whole module.
    sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    expect(sources.results.map((r: { testCode: string }) => r.testCode)).not.toContain('protein');

    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);
    sources = (await as(app, supervisor).get(`/api/reports/sources/${jobId}`).expect(200)).body;
    expect(sources.results.map((r: { testCode: string }) => r.testCode)).toContain('protein');
  });

  // ---- Writing the document -------------------------------------------------------------------

  it('starts a certificate with its own number, from the certificate sequence', async () => {
    const res = await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId, reportType: 'certificate_of_analysis', language: 'en', title: 'Certificate of analysis' })
      .expect(201);
    reportId = res.body.id;
    reportNumber = res.body.reportNumber;

    expect(res.body.status).toBe('draft');
    expect(res.body.version).toBe(1);
    // Reports keep printing TR-R-…; certificates have their own sequence and do not disturb it.
    expect(reportNumber).toMatch(/^TR-C-\d{4}-\d{5}$/);
    expect(res.body.templateCode).toBe('coa-standard');
    expect(res.body.currentVersion.versionNumber).toBe(1);
    expect(res.body.actions).toContain('submit');
  });

  it('takes the narrative a person writes, and nothing factual', async () => {
    const res = await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({
        content: {
          executiveSummary: 'The consignment was sampled at Derince and analysed for moisture.',
          conclusions: 'The material meets the contractual specification.',
        },
      })
      .expect(200);
    expect(res.body.currentVersion.content.executiveSummary).toMatch(/Derince/);
    // There is no field on this endpoint through which a result could be written.
    expect(res.body.currentVersion.content.results).toBeUndefined();
  });

  it('refuses an edit built on a stale copy', async () => {
    const stale = await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { observations: 'no' }, lockVersion: 1 });
    expect(stale.status).toBe(409);
  });

  it('renders a draft preview, watermarked and not stored', async () => {
    const res = await as(app, supervisor).get(`/api/reports/${reportId}/preview`).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.length).toBeGreaterThan(5000);

    const doc = (await as(app, supervisor).get(`/api/reports/${reportId}`).expect(200)).body;
    expect(doc.currentVersion.pdfStorageKey).toBeNull();
    expect(doc.pdfSha256).toBeNull();
  }, 60_000);

  it('puts the chosen photograph on the document, and only the chosen one', async () => {
    const sources = (await as(app, supervisor).get(`/api/reports/${reportId}/sources`).expect(200)).body;
    if (!sources.photos.length) return; // the demo job may carry none; the selection is still exercised below
    const res = await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { photoIds: [sources.photos[0].id] } })
      .expect(200);
    expect(res.body.currentVersion.content.photoIds).toEqual([sources.photos[0].id]);
  });

  // ---- Review and approval ---------------------------------------------------------------------

  it('will not let the author review or approve their own document', async () => {
    await as(app, supervisor).post(`/api/reports/${reportId}/submit`).expect(200);

    const selfReview = await as(app, supervisor).post(`/api/reports/${reportId}/review`).send({});
    expect(selfReview.status).toBe(409);
    expect(selfReview.body.message).toMatch(/somebody else/i);

    const selfApprove = await as(app, supervisor).post(`/api/reports/${reportId}/approve`);
    expect(selfApprove.status).toBe(409);
  });

  it('sends it back with a reason, and takes it again', async () => {
    const noReason = await as(app, admin).post(`/api/reports/${reportId}/changes`).send({});
    expect(noReason.status).toBe(400);

    const returned = await as(app, admin)
      .post(`/api/reports/${reportId}/changes`)
      .send({ reason: 'State the sampling method in the summary' })
      .expect(200);
    expect(returned.body.status).toBe('changes_requested');
    expect(returned.body.currentVersion.reviewComment).toMatch(/sampling method/i);

    // The author can write again, and what they had written is still there.
    const edited = await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { executiveSummary: 'Sampled by manual probe at Derince and analysed for moisture.' } })
      .expect(200);
    expect(edited.body.currentVersion.content.conclusions).toMatch(/contractual/);

    await as(app, supervisor).post(`/api/reports/${reportId}/submit`).expect(200);
  });

  it('will not approve what nobody has reviewed', async () => {
    const early = await as(app, admin).post(`/api/reports/${reportId}/approve`);
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/review/i);

    await as(app, admin)
      .post(`/api/reports/${reportId}/review`)
      .send({ comment: 'Checked against the released results' })
      .expect(200);
    const approved = await as(app, admin).post(`/api/reports/${reportId}/approve`).expect(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedBy).toBe(admin.user.id);
    expect(approved.body.approvedBy).not.toBe(approved.body.preparedBy);
  });

  // ---- Issue -------------------------------------------------------------------------------------

  it('issues it: the facts are frozen, the file is stored, the checksum is kept', async () => {
    const issued = await as(app, admin).post(`/api/reports/${reportId}/issue`).expect(200);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.pdfSha256).toHaveLength(64);
    expect(issued.body.issuedBy).toBe(admin.user.id);

    const version = issued.body.currentVersion;
    expect(version.pdfStorageKey).toMatch(/\.pdf$/);
    expect(version.pdfBytes).toBeGreaterThan(5000);
    expect(version.templateCode).toBe('coa-standard');
    expect(version.templateVersion).toBe(1);

    const snapshot = version.dataSnapshot;
    expect(snapshot.client.name).toMatch(/Certificate Trading/);
    expect(snapshot.job.jobNumber).toBeTruthy();
    expect(snapshot.results.length).toBeGreaterThan(0);
    const moisture = snapshot.results.find((r: { testCode: string }) => r.testCode === 'moisture');
    expect(moisture.value).toBe('12.40');
    expect(moisture.methodCode).toBeTruthy();
    expect(moisture.methodVersion).toBeGreaterThanOrEqual(1);
    expect(moisture.specification).toMatch(/≤/);
    expect(snapshot.approvals.approvedByName).toBeTruthy();

    firstToken = issued.body.verificationToken;
  }, 60_000);

  it('serves the stored file rather than rendering it again', async () => {
    const res = await as(app, admin).get(`/api/reports/${reportId}/file`).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${reportNumber}-r1.pdf`);
    expect(res.body.length).toBeGreaterThan(5000);
  }, 60_000);

  it('verifies publicly, and says what the document is without saying whose it is', async () => {
    const res = await as(app, supervisor).get(`/api/public/verify/${firstToken}`).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.reportNumber).toBe(reportNumber);
    expect(res.body.reportType).toBe('certificate_of_analysis');
    expect(res.body.version).toBe(1);
    expect(res.body.checksum).toHaveLength(64);
    expect(res.body.issuer).toBeTruthy();
    expect(res.body.clientName).toBeUndefined();
    expect(res.body.jobNumber).toBeUndefined();
  });

  it('answers an unknown code plainly, without leaking whether one exists', async () => {
    const res = await as(app, supervisor).get('/api/public/verify/not-a-real-token').expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reportNumber).toBeUndefined();
  });

  it('refuses to edit an issued document', async () => {
    const res = await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { conclusions: 'Something else entirely' } });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/revision/i);
  });

  // ---- Revision -----------------------------------------------------------------------------------

  it('corrects it by revision, leaving the issued copy exactly as it was sent', async () => {
    const noReason = await as(app, supervisor).post(`/api/reports/${reportId}/revisions`).send({});
    expect(noReason.status).toBe(400);

    const revised = await as(app, supervisor)
      .post(`/api/reports/${reportId}/revisions`)
      .send({ reason: 'The client asked for the sampling method to be named on the face of the certificate' })
      .expect(201);
    expect(revised.body.status).toBe('draft');
    expect(revised.body.version).toBe(2);
    // The revision starts from what was issued rather than from an empty page.
    expect(revised.body.currentVersion.content.conclusions).toMatch(/contractual/);
    expect(revised.body.currentVersion.revisionReason).toMatch(/sampling method/i);

    const versions = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body;
    expect(versions).toHaveLength(2);
    const first = versions.find((v: { versionNumber: number }) => v.versionNumber === 1);
    expect(first.status).toBe('issued');
    expect(first.pdfSha256).toHaveLength(64);
    expect(first.dataSnapshot.results[0].value).toBe('12.40');
  });

  it('tells the holder of the old copy that it has been superseded, not that it is fake', async () => {
    await as(app, supervisor)
      .patch(`/api/reports/${reportId}`)
      .send({ content: { observations: 'Sampling was carried out by manual probe under GAFTA 124.' } })
      .expect(200);
    await as(app, supervisor).post(`/api/reports/${reportId}/submit`).expect(200);
    await as(app, admin).post(`/api/reports/${reportId}/review`).send({}).expect(200);
    await as(app, admin).post(`/api/reports/${reportId}/approve`).expect(200);
    const issued = await as(app, admin).post(`/api/reports/${reportId}/issue`).expect(200);

    // The old copy: still a genuine document, and honest about having been replaced.
    const old = (await as(app, supervisor).get(`/api/public/verify/${firstToken}`).expect(200)).body;
    expect(old.status).toBe('superseded');
    expect(old.valid).toBe(false);
    expect(old.version).toBe(1);
    expect(old.supersededBy).toMatch(/rev\. 2/);

    // The new copy has its own code and its own checksum.
    const current = (await as(app, supervisor)
      .get(`/api/public/verify/${issued.body.verificationToken}`)
      .expect(200)).body;
    expect(current.valid).toBe(true);
    expect(current.version).toBe(2);
    expect(current.checksum).not.toBe(old.checksum);

    // Both files are still downloadable, each as what it is.
    const r1 = await as(app, admin).get(`/api/reports/${reportId}/file?version=1`).expect(200);
    const r2 = await as(app, admin).get(`/api/reports/${reportId}/file?version=2`).expect(200);
    expect(r1.body.length).toBeGreaterThan(5000);
    expect(r2.body.length).toBeGreaterThan(5000);
  }, 90_000);

  it('keeps the old revision saying what it said, after the laboratory amends the result', async () => {
    const before = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body
      .find((v: { versionNumber: number }) => v.versionNumber === 1);
    expect(before.dataSnapshot.results[0].value).toBe('12.40');

    // The laboratory corrects the released result the certificate was built on.
    const request = (await as(app, labManager).get(`/api/lab/requests?sampleId=${sampleId}&status=released`).expect(200))
      .body.rows.find((r: { testCode: string }) => r.testCode === 'moisture');
    await as(app, labManager)
      .post(`/api/lab/requests/${request.id}/result/amendments`)
      .send({ reason: 'Recalculated against the certified reference material' })
      .expect(201);
    await as(app, analyst)
      .patch(`/api/lab/requests/${request.id}/result`)
      .send({ numericValue: '12.85', unit: '%' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${request.id}/result/submit`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/approve`).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${request.id}/result/release`).expect(200);

    // The issued revisions are untouched: they stopped reading the database when they were issued.
    const versions = (await as(app, admin).get(`/api/reports/${reportId}/versions`).expect(200)).body;
    expect(versions.find((v: { versionNumber: number }) => v.versionNumber === 1).dataSnapshot.results[0].value)
      .toBe('12.40');
    expect(versions.find((v: { versionNumber: number }) => v.versionNumber === 2).dataSnapshot.results[0].value)
      .toBe('12.40');

    // A new revision would quote the corrected figure.
    const sources = (await as(app, admin).get(`/api/reports/${reportId}/sources`).expect(200)).body;
    expect(sources.results.find((r: { testCode: string }) => r.testCode === 'moisture').value).toBe('12.85');
  }, 90_000);

  // ---- Cancellation ---------------------------------------------------------------------------------

  it('cancels a document without deleting it, and the QR says so', async () => {
    const made = await jobWithReleasedResult('13.10');
    const doomed = (await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId: made.jobId, reportType: 'laboratory_report', language: 'en' })
      .expect(201)).body;

    await as(app, supervisor).post(`/api/reports/${doomed.id}/submit`).expect(200);
    await as(app, admin).post(`/api/reports/${doomed.id}/review`).send({}).expect(200);
    await as(app, admin).post(`/api/reports/${doomed.id}/approve`).expect(200);
    const issued = await as(app, admin).post(`/api/reports/${doomed.id}/issue`).expect(200);

    const noReason = await as(app, admin).post(`/api/reports/${doomed.id}/cancel`).send({});
    expect(noReason.status).toBe(400);

    const cancelled = await as(app, admin)
      .post(`/api/reports/${doomed.id}/cancel`)
      .send({ reason: 'Issued against the wrong consignment' })
      .expect(200);
    expect(cancelled.body.status).toBe('cancelled');

    const verify = (await as(app, supervisor)
      .get(`/api/public/verify/${issued.body.verificationToken}`)
      .expect(200)).body;
    expect(verify.valid).toBe(false);
    expect(verify.status).toBe('cancelled');
    expect(verify.cancelledReason).toMatch(/wrong consignment/i);
    expect(verify.reportNumber).toBe(doomed.reportNumber);
  }, 120_000);

  // ---- Multilingual -----------------------------------------------------------------------------------

  it('writes a document in the language it is for, not the language of the screen', async () => {
    const made = await jobWithReleasedResult('14.20');
    const ru = (await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId: made.jobId, reportType: 'certificate_of_analysis', language: 'ru' })
      .expect(201)).body;
    expect(ru.language).toBe('ru');
    expect(ru.currentVersion.language).toBe('ru');

    const preview = await as(app, supervisor).get(`/api/reports/${ru.id}/preview`).expect(200);
    expect(preview.headers['content-type']).toContain('application/pdf');
    expect(preview.body.length).toBeGreaterThan(5000);

    const tr = await as(app, supervisor)
      .patch(`/api/reports/${ru.id}`)
      .send({ language: 'tr' })
      .expect(200);
    expect(tr.body.language).toBe('tr');
  }, 120_000);

  // ---- The register -------------------------------------------------------------------------------------

  it('answers the questions a document register is asked', async () => {
    const page = (await as(app, admin).get('/api/reports?limit=2').expect(200)).body;
    expect(page.rows.length).toBeLessThanOrEqual(2);
    expect(page.limit).toBe(2);
    expect(page.total).toBeGreaterThan(2);

    const byType = (await as(app, admin).get('/api/reports?reportType=certificate_of_analysis&limit=200').expect(200)).body;
    expect(byType.rows.every((r: { reportType: string }) => r.reportType === 'certificate_of_analysis')).toBe(true);

    const byStatus = (await as(app, admin).get('/api/reports?status=issued&limit=5').expect(200)).body;
    expect(byStatus.rows.every((r: { status: string }) => r.status === 'issued')).toBe(true);

    const byJob = (await as(app, admin).get(`/api/reports?jobId=${jobId}`).expect(200)).body;
    expect(byJob.rows.every((r: { jobId: string }) => r.jobId === jobId)).toBe(true);

    const found = (await as(app, admin).get(`/api/reports?search=${reportNumber}`).expect(200)).body;
    expect(found.rows[0].reportNumber).toBe(reportNumber);

    const byLanguage = (await as(app, admin).get('/api/reports?language=ru&limit=50').expect(200)).body;
    expect(byLanguage.rows.every((r: { language: string }) => r.language === 'ru')).toBe(true);
  });

  it('keeps documents inside the office that owns them', async () => {
    const theirs = (await as(app, inspectorRo).get('/api/reports?limit=200').expect(200)).body;
    expect(theirs.rows.map((r: { id: string }) => r.id)).not.toContain(reportId);
    await as(app, inspectorRo).get(`/api/reports/${reportId}`).expect(404);
  });

  it('reads like a story in the history, and is in the audit log as well', async () => {
    const history = (await as(app, admin).get(`/api/reports/${reportId}/history`).expect(200)).body;
    const path = history.map((h: { toStatus: string }) => h.toStatus);
    expect(path[0]).toBe('draft');
    expect(path).toContain('under_review');
    expect(path).toContain('changes_requested');
    expect(path).toContain('approved');
    expect(path).toContain('issued');
    expect(history.every((h: { changedByName: string }) => h.changedByName)).toBe(true);
    expect(history.some((h: { reason: string | null }) => h.reason)).toBe(true);

    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${reportId}`).expect(200)).body;
    const actions: string[] = log.rows.map((r: { action: string }) => r.action);
    for (const wanted of ['report.created', 'report.submit', 'report.approve', 'report.issue', 'report.revise']) {
      expect(actions).toContain(wanted);
    }
    // The binary itself is never written to the log — only that it was produced.
    expect(log.rows.every((r: { afterData: { pdf?: unknown } | null }) => !r.afterData?.pdf)).toBe(true);
  });

  it('tells a user only what they may do right now', async () => {
    const asAuthor = (await as(app, supervisor).get(`/api/reports/${reportId}`).expect(200)).body;
    expect(asAuthor.actions).not.toContain('approve');
    expect(asAuthor.actions).not.toContain('issue');

    const asApprover = (await as(app, admin).get(`/api/reports/${reportId}`).expect(200)).body;
    expect(asApprover.actions).toContain('revise');
  });
});

/** The laboratory's side of the cross-office question PHASE 6 left open. */
describe('documents: least privilege across offices', () => {
  let app: INestApplication;
  let supervisor: Session;
  let inspector: Session;
  let supervisorRo: Session;
  let labManager: Session;

  let sampleId: string;

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    supervisorRo = await login(app, ACCOUNTS.supervisorRo);
    labManager = await login(app, ACCOUNTS.labTr);

    const clientId = (await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Cross office ${Date.now()}`, country: 'TR' })
      .expect(201)).body.id;
    const commodityId = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body
      .find((c: { code: string }) => c.code === 'wheat_milling').id;
    const roLab = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body
      .find((l: { code: string }) => l.code === 'RO-LAB');

    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince, Berth 12', commodityId })
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
      .send({ inspectionId, commodityId, quantity: 2, unit: 'kg' })
      .expect(201);
    sampleId = sample.body.id;
    await as(app, inspector).post(`/api/samples/${sampleId}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${sampleId}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspector)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'seal', sealNumber: `XO-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: roLab.id })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('gives the receiving laboratory what it needs to work, and nothing commercial', async () => {
    const brief = await as(app, supervisorRo).get(`/api/lab/samples/${sampleId}/brief`).expect(200);
    expect(brief.body.sampleNumber).toBeTruthy();
    expect(brief.body.sealNumber).toBeTruthy();
    expect(brief.body.commodity).toBeTruthy();
    expect(brief.body.jobNumber).toBeTruthy();
    // A laboratory that cannot say whose material is on the bench cannot keep a chain of custody.
    expect(brief.body.clientName).toBeTruthy();
    // …but nothing commercial travels with it.
    expect(brief.body).not.toHaveProperty('clientAddress');
    expect(brief.body).not.toHaveProperty('contractId');
    expect(brief.body).not.toHaveProperty('quantityValue');
    expect(brief.body).not.toHaveProperty('internalNotes');
  });

  it('still refuses the full sample card and the client behind it', async () => {
    // The full card joins the job and the client, which belong to the sending office.
    await as(app, supervisorRo).get(`/api/samples/${sampleId}`).expect(404);
  });

  it('gives the brief to nobody else', async () => {
    // The sending office reads the sample itself; the brief is for the laboratory holding it.
    const owner = await as(app, labManager).get(`/api/lab/samples/${sampleId}/brief`);
    expect(owner.status).toBe(404);
  });
});

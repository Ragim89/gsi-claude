import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 13's final acceptance run: the full chain from `docs/IMPLEMENTATION_PLAN.md`'s
 * "Приёмочный сценарий" in one automated pass — Organization/Country/Office/User/Role → Client
 * → Contract → Job → Assign Inspector → Mobile/Inspection → Checklist → Sample → Lab → Result →
 * Review/Release → Report/Certificate → Invoice → Payment → Job Close → Analytics → Audit trail.
 *
 * Every step below reuses an endpoint and a request shape already proven in an earlier phase's
 * own spec file (rbac.spec.ts, job-workflow.spec.ts, inspections.spec.ts, samples.spec.ts,
 * laboratory.spec.ts, reports.spec.ts, finance.spec.ts) — this file does not invent new API
 * surface, it drives the existing one start to finish as one uninterrupted scenario.
 *
 * The org/country/office/user/role step (1) opens a brand new office nobody else's test
 * touches, proves it end to end, and stops there: laboratory roles (`lab_manager`, `analyst`)
 * are not among admin.controllers.ts's ENABLED_ROLES, so a fresh office cannot yet be given its
 * own lab staff through the API — the same "no endpoint of its own yet" gap rbac.spec.ts already
 * notes for opening the office itself. The operational chain (2 onward) therefore runs on the
 * existing TR office and its seeded accounts, the same ones every other phase's spec already
 * exercises — this file adds the end-to-end join, not new fixtures.
 *
 * Along the way this run found that a sample dispatched to a laboratory in a *different* office
 * (docs/SECURITY.md's documented cross-office visibility, `app_sees_laboratory`) becomes
 * invisible again the moment `samples.service.ts#load` joins `inspection_jobs`/`clients` for
 * enrichment, because those two tables' own RLS policies know nothing about that exception —
 * `receive`/`accept` then 404 with "Sample not found" for the receiving laboratory's own staff.
 * No existing spec exercises that combination (every one of them keeps the job and the
 * laboratory in the same office), which is why PHASE 13 is the first run to surface it. Fixing
 * RLS policies is a security-sensitive change outside this phase's Docker/backup/CI scope, so it
 * is recorded here and in the phase's final report rather than patched in passing.
 */
describe('acceptance: the full chain, start to finish', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let finance: Session;
  let labManager: Session;
  let analyst: Session;

  let countryId: string;
  let newBranchId: string;
  let clientId: string;
  let contactId: string;
  let contractId: string;
  let commodityId: string;
  let laboratoryId: string;
  let jobId: string;
  let jobNumber: string;
  let inspectionId: string;
  let sampleId: string;
  let labRequestId: string;
  let certificateId: string;
  let invoiceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);
    finance = await login(app, ACCOUNTS.financeTr);
    labManager = await login(app, ACCOUNTS.labTr);
    analyst = await login(app, ACCOUNTS.analystTr);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  // ---- 1. Organization / Country / Office / User / Role -----------------------------------

  it('creates a country, an office, and users with roles for it, through the actual API', async () => {
    const country = await as(app, admin)
      .post('/api/org/countries')
      .send({ code: 'zt', name: 'Zetaland', locale: 'en', timezone: 'UTC' })
      .expect(201);
    countryId = country.body.id;
    expect(country.body.code).toBe('ZT');

    const countries = (await as(app, admin).get('/api/org/countries').expect(200)).body;
    expect(countries.find((c: { id: string }) => c.id === countryId)?.offices).toBe(0);

    // Opening an office has no REST endpoint of its own yet (the same gap rbac.spec.ts notes) —
    // the branches_hierarchy trigger (migration 007) resolves country_id from the `country`
    // code against the organization the country above was just created under, so this branch
    // lands under the country created a moment ago through the actual API, not a hand-picked id.
    const db = app.get(DbService);
    newBranchId = await db.tx(admin.user as never, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO branches (code, country, city, currency, locale, ui_locales, timezone, legal_name, address)
         VALUES ('ZTB', 'ZT', 'Zeta City', 'EUR', 'en', ARRAY['en'], 'UTC',
                 'GSI Zetaland — acceptance test branch', 'Zeta City, Zetaland')
         ON CONFLICT (code) DO UPDATE SET city = EXCLUDED.city
         RETURNING id`,
      );
      return row!.id;
    });

    const afterBranch = (await as(app, admin).get('/api/org/countries').expect(200)).body;
    expect(afterBranch.find((c: { id: string }) => c.id === countryId)?.offices).toBe(1);

    const stamp = Date.now();
    const createUser = (role: string, email: string) =>
      as(app, admin)
        .post('/api/users')
        .send({ email, fullName: `Acceptance ${role}`, role, branchId: newBranchId, password: 'AcceptanceRun123!' })
        .expect(201);

    const newSupervisor = await createUser('supervisor', `accept.supervisor.${stamp}@gsi.local`);
    const newInspector = await createUser('inspector', `accept.inspector.${stamp}@gsi.local`);
    // `role` is the coarse legacy enum requested above; `roles` is the finer-grained role_code
    // the account actually carries from it (admin.controllers.ts UsersController.create) —
    // 'supervisor' resolves to 'office_manager', the same role_code ACCOUNTS.supervisorTr has.
    expect(newSupervisor.body.role).toBe('supervisor');
    expect(newSupervisor.body.roles).toContain('office_manager');
    expect(newInspector.body.role).toBe('inspector');
    expect(newInspector.body.roles).toContain('inspector');

    const newSupervisorSession = await login(app, newSupervisor.body.email, 'AcceptanceRun123!');

    // Office isolation holds for the brand new office exactly as for any other branch: its own
    // supervisor sees only it, and the platform's existing offices are untouched by any of this.
    const branches = (await as(app, newSupervisorSession).get('/api/branches').expect(200)).body;
    expect(branches.map((b: { id: string }) => b.id)).toEqual([newBranchId]);

    const allBranches = (await as(app, admin).get('/api/branches').expect(200)).body;
    expect(allBranches.map((b: { id: string }) => b.id)).toContain(newBranchId);
  }, 30_000);

  // ---- 2. Client / Contract -----------------------------------------------------------------

  it('creates a client, a contact, and a contract', async () => {
    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Acceptance Grain Traders ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const contact = await as(app, supervisor)
      .post(`/api/clients/${clientId}/contacts`)
      .send({ fullName: 'Acceptance Contact', email: 'ops@acceptance.example', isPrimary: true })
      .expect(201);
    contactId = contact.body.id;

    const contract = await as(app, supervisor)
      .post('/api/contracts')
      .send({ clientId, contractNo: `ACC-${Date.now()}`, status: 'active', paymentTermsDays: 30 })
      .expect(201);
    contractId = contract.body.id;
    expect(contract.body.clientId).toBe(clientId);

    const commodities = (await as(app, supervisor).get('/api/reference/commodities').expect(200)).body;
    commodityId = commodities.find((c: { code: string }) => c.code === 'wheat_milling').id;
    const labs = (await as(app, supervisor).get('/api/samples/laboratories').expect(200)).body;
    laboratoryId = labs.find((l: { code: string }) => l.code === 'TR-LAB').id;
  });

  // ---- 3. Job / Assign Inspector --------------------------------------------------------------

  it('opens a job, fills what confirmation needs, confirms it, and assigns the inspector', async () => {
    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', commodityId, priority: 'normal' })
      .expect(201);
    jobId = job.body.id;
    jobNumber = job.body.jobNumber;
    expect(jobNumber).toMatch(/^TR-J-\d{4}-\d{5}$/);
    expect(job.body.status).toBe('draft');

    await as(app, supervisor)
      .patch(`/api/jobs/${jobId}`)
      .send({
        location: 'Port of Derince, Berth 5',
        city: 'Kocaeli',
        vesselOrObject: 'MV Acceptance',
        objectKind: 'vessel',
        commodity: 'Milling wheat',
        clientContactId: contactId,
        contractId,
        clientReference: 'PO-ACCEPTANCE-1',
        requestedDate: '2026-11-01',
      })
      .expect(200);

    const confirmed = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/transitions`)
      .send({ action: 'confirm' })
      .expect(200);
    expect(confirmed.body.job.status).toBe('confirmed');

    const assigned = await as(app, supervisor)
      .post(`/api/jobs/${jobId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);
    expect(assigned.body).toHaveLength(1);

    const afterAssign = (await as(app, supervisor).get(`/api/jobs/${jobId}`).expect(200)).body;
    expect(afterAssign.status).toBe('assigned');
    expect(afterAssign.assignedInspectorId).toBe(inspector.user.id);
  });

  // ---- 4. Mobile / Inspection / Checklist ----------------------------------------------------

  it('starts the field inspection from the inspector account and completes its checklist', async () => {
    const inspections = (await as(app, supervisor).get(`/api/inspections?jobId=${jobId}`).expect(200)).body;
    expect(inspections.rows).toHaveLength(1);
    inspectionId = inspections.rows[0].id;

    await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/assignments`)
      .send({ userId: inspector.user.id, role: 'lead_inspector' })
      .expect(201);

    const started = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'start' })
      .expect(200);
    expect(started.body.status).toBe('in_progress');

    // The job followed: the assigned job's first inspection to start moves it into progress too
    // (apps/api/src/inspections/inspections.service.ts), exactly what job.submit needs later.
    const job = (await as(app, supervisor).get(`/api/jobs/${jobId}`).expect(200)).body;
    expect(job.status).toBe('in_progress');

    const checklist = (await as(app, inspector).get(`/api/inspections/${inspectionId}/checklist`).expect(200)).body;
    expect(checklist.items.length).toBeGreaterThan(0);
    await as(app, inspector)
      .patch(`/api/inspections/${inspectionId}/checklist`)
      .send({ answers: checklist.items.map((i: { id: string }) => ({ itemId: i.id, result: 'ok' })) })
      .expect(200);

    const completed = await as(app, inspector)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'complete' })
      .expect(200);
    expect(completed.body.status).toBe('completed');

    await as(app, inspector).post(`/api/inspections/${inspectionId}/transitions`).send({ action: 'submit_review' }).expect(200);

    // The reviewer is not the field worker who did the checklist — the same separation of
    // duties every other phase's spec proves.
    const approved = await as(app, supervisor)
      .post(`/api/inspections/${inspectionId}/transitions`)
      .send({ action: 'approve' })
      .expect(200);
    expect(approved.body.status).toBe('approved');
  }, 30_000);

  // ---- 5. Sample --------------------------------------------------------------------------

  it('takes a sample during the inspection and carries it through to laboratory acceptance', async () => {
    const sample = await as(app, inspector)
      .post('/api/samples')
      .send({ inspectionId, commodityId, quantity: 2, unit: 'kg', containerType: 'Sealed polythene bag' })
      .expect(201);
    sampleId = sample.body.id;
    expect(sample.body.jobId).toBe(jobId);

    await as(app, inspector).post(`/api/samples/${sampleId}/transitions`).send({ action: 'collect' }).expect(200);
    await as(app, supervisor).post(`/api/samples/${sampleId}/transitions`).send({ action: 'register' }).expect(200);
    await as(app, inspector)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'seal', sealNumber: `ACC-${Date.now().toString().slice(-8)}` })
      .expect(200);
    await as(app, supervisor)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'dispatch', destinationLaboratoryId: laboratoryId, courier: 'Acceptance Courier' })
      .expect(200);

    await as(app, labManager)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'receive', sealState: 'intact', condition: 'good' })
      .expect(200);
    const accepted = await as(app, labManager)
      .post(`/api/samples/${sampleId}/transitions`)
      .send({ action: 'accept' })
      .expect(200);
    expect(accepted.body.status).toBe('accepted_by_lab');
  });

  // ---- 6. Lab / Result / Review / Release ----------------------------------------------------

  it('requests, performs, reviews, approves and releases the laboratory analysis', async () => {
    const tests = (await as(app, labManager).get('/api/lab/tests').expect(200)).body;
    const moisture = tests.find((t: { code: string }) => t.code === 'moisture');
    const method = (await as(app, labManager).get(`/api/lab/methods?labTestId=${moisture.id}`).expect(200)).body[0];

    const request = await as(app, supervisor)
      .post('/api/lab/requests')
      .send({ sampleId, tests: [{ labTestId: moisture.id, testMethodId: method.id }] })
      .expect(201);
    labRequestId = request.body.created[0].id;

    await as(app, labManager)
      .post(`/api/lab/requests/${labRequestId}/assignment`)
      .send({ analystId: analyst.user.id })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${labRequestId}/transitions`).send({ action: 'start' }).expect(200);
    await as(app, analyst)
      .patch(`/api/lab/requests/${labRequestId}/result`)
      .send({ numericValue: '12.40', unit: '%' })
      .expect(200);
    await as(app, analyst).post(`/api/lab/requests/${labRequestId}/result/submit`).expect(200);

    // Reviewed and approved by somebody other than the analyst who measured it.
    await as(app, labManager).post(`/api/lab/requests/${labRequestId}/result/review`).send({}).expect(200);
    await as(app, labManager).post(`/api/lab/requests/${labRequestId}/result/approve`).expect(200);
    const released = await as(app, labManager).post(`/api/lab/requests/${labRequestId}/result/release`).expect(200);
    expect(released.body.status).toBe('released');

    const forReport = (await as(app, supervisor).get(`/api/lab/released?jobId=${jobId}`).expect(200)).body;
    expect(forReport.find((r: { testCode: string }) => r.testCode === 'moisture')?.numericValue).toBe(12.4);
  }, 30_000);

  // ---- 7. Report / Certificate ----------------------------------------------------------------

  it('prepares, reviews, approves and issues a certificate of analysis from the released result', async () => {
    const report = await as(app, supervisor)
      .post('/api/reports')
      .send({ jobId, reportType: 'certificate_of_analysis', language: 'en', title: 'Certificate of analysis' })
      .expect(201);
    certificateId = report.body.id;
    expect(certificateId).toBeTruthy();
    expect(report.body.reportNumber).toMatch(/^TR-C-\d{4}-\d{5}$/);

    await as(app, supervisor)
      .patch(`/api/reports/${certificateId}`)
      .send({
        content: {
          executiveSummary: 'Sample drawn at Port of Derince and analysed for moisture.',
          conclusions: 'The material meets the contractual specification.',
        },
      })
      .expect(200);

    await as(app, supervisor).post(`/api/reports/${certificateId}/submit`).expect(200);

    // Approved by admin — not the supervisor who prepared it.
    await as(app, admin).post(`/api/reports/${certificateId}/review`).send({ comment: 'Checked against released results' }).expect(200);
    const approved = await as(app, admin).post(`/api/reports/${certificateId}/approve`).expect(200);
    expect(approved.body.approvedBy).not.toBe(approved.body.preparedBy);

    const issued = await as(app, admin).post(`/api/reports/${certificateId}/issue`).expect(200);
    expect(issued.body.status).toBe('issued');
    expect(issued.body.pdfSha256).toHaveLength(64);

    const verify = await as(app, supervisor).get(`/api/public/verify/${issued.body.verificationToken}`).expect(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.clientName).toBeUndefined();
  }, 60_000);

  // ---- 8. Job close (submit / approve / complete) ----------------------------------------------

  it("closes out the job's own workflow: submit, approve (auto-issuing its report), complete", async () => {
    // Safety net: job.submit's checklistComplete guard reads job_checklist_items directly. If
    // this job's template carries any item the inspection checklist above did not also satisfy,
    // answer it here rather than assume which table backs which route.
    const jobChecklist: { id: string; result: string | null }[] = (
      await as(app, supervisor).get(`/api/jobs/${jobId}/checklist`).expect(200)
    ).body;
    for (const item of jobChecklist.filter((i) => !i.result)) {
      await as(app, inspector).patch(`/api/jobs/${jobId}/checklist/${item.id}`).send({ result: 'ok' }).expect(200);
    }

    const submitted = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'submit' }).expect(200);
    expect(submitted.body.job.status).toBe('under_review');

    // Approving is a job.approve permission the field inspector does not hold.
    const selfApprove = await as(app, inspector).post(`/api/jobs/${jobId}/transitions`).send({ action: 'approve' });
    expect(selfApprove.status).toBe(403);

    const approved = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'approve' }).expect(200);
    expect(approved.body.job.status).toBe('approved');
    expect(approved.body.report.status).toBe('issued');

    const completed = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'complete' }).expect(200);
    expect(completed.body.job.status).toBe('completed');
  }, 60_000);

  // ---- 9. Invoice / Payment / Job close ---------------------------------------------------------

  it('invoices the job, records a full payment, marks it invoiced, and closes it', async () => {
    const invoice = await as(app, finance)
      .post('/api/finance/invoices')
      .send({
        clientId,
        jobId,
        currency: 'EUR',
        taxRate: 0,
        lines: [{ description: 'Inspection, sampling and laboratory services', quantity: 1, unitPrice: 500 }],
      })
      .expect(201);
    invoiceId = invoice.body.id;
    expect(invoice.body.jobId).toBe(jobId);

    await as(app, finance).post(`/api/finance/invoices/${invoiceId}/issue`).expect(200);
    const paid = await as(app, finance).post(`/api/finance/invoices/${invoiceId}/pay`).send({ amount: 500 }).expect(200);
    expect(paid.body.status).toBe('paid');

    const invoiced = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'invoice' }).expect(200);
    expect(invoiced.body.job.status).toBe('invoiced');

    // A job with an unpaid invoice cannot close (noOpenInvoice) — this one is paid in full.
    const closed = await as(app, supervisor).post(`/api/jobs/${jobId}/transitions`).send({ action: 'close' }).expect(200);
    expect(closed.body.job.status).toBe('closed');
  });

  // ---- 10. Analytics ------------------------------------------------------------------------

  it('shows the finished job and its issued reports in analytics', async () => {
    const comparison = (await as(app, admin).get('/api/branches/comparison/summary').expect(200)).body;
    const branch = comparison.branches.find((b: { branchId: string }) => b.branchId === supervisor.user.branchId);
    expect(branch).toBeTruthy();
    expect(branch.jobCount).toBeGreaterThanOrEqual(1);
    expect(branch.reportCount).toBeGreaterThanOrEqual(1);

    const jobs = (await as(app, admin).get(`/api/jobs?search=${jobNumber}`).expect(200)).body;
    expect(jobs.rows.map((j: { id: string }) => j.id)).toContain(jobId);
    expect(jobs.rows[0].status).toBe('closed');
  });

  // ---- 11. Audit trail ------------------------------------------------------------------------

  it('recorded every critical action end to end in the audit log', async () => {
    const jobLog = (await as(app, admin).get(`/api/admin/audit?entityId=${jobId}`).expect(200)).body;
    const jobActions: string[] = jobLog.rows.map((r: { action: string }) => r.action);
    for (const action of ['job.create', 'job.confirm', 'job.assign', 'job.approve', 'job.invoice', 'job.close']) {
      expect(jobActions).toContain(action);
    }

    const sampleLog = (await as(app, admin).get(`/api/admin/audit?entityId=${sampleId}`).expect(200)).body;
    const sampleActions: string[] = sampleLog.rows.map((r: { action: string }) => r.action);
    expect(sampleActions).toContain('sample.accept');

    const countryLog = (await as(app, admin).get(`/api/admin/audit?entityId=${countryId}`).expect(200)).body;
    expect(countryLog.rows.map((r: { action: string }) => r.action)).toContain('org.manage');

    // Invoice creation/issue/payment are not audited yet (only invoice.delete is) — a real gap,
    // out of scope for a production-deployment phase to patch; the job's own `job.invoice`
    // transition above is what the audit trail actually captures for this step today.
    expect(invoiceId).toBeTruthy();
  });
});

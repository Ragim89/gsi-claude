import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 13's acceptance run found that `invoice.create`/`invoice.issue`/`invoice.pay` wrote
 * nothing to `audit_logs` — only `invoice.delete`/`invoice.archive` did. The financial operation
 * itself was always correct (the ledger, ar.trade/revenue/tax postings and payment allocations
 * are untouched here — this only adds `AuditService.record` calls around them), but a finance
 * audit trail that shows an invoice being removed and nothing about it being created, sent or
 * paid is not a trail. This spec is the lock on the three new entries.
 */
describe('finance: invoice actions are audited', () => {
  let app: INestApplication;
  let admin: Session;
  let financeTr: Session;
  let supervisorTr: Session;
  let clientId: string;
  let jobId: string;
  let invoiceId: string;
  let invoiceNumber: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    financeTr = await login(app, ACCOUNTS.financeTr);
    supervisorTr = await login(app, ACCOUNTS.supervisorTr);

    const client = await as(app, supervisorTr)
      .post('/api/clients')
      .send({ name: `Invoice Audit Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const job = await as(app, supervisorTr)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince' })
      .expect(201);
    jobId = job.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('records who created the invoice, for how much, against which job and client', async () => {
    const invoice = await as(app, financeTr)
      .post('/api/finance/invoices')
      .send({
        clientId,
        jobId,
        currency: 'EUR',
        taxRate: 20,
        lines: [{ description: 'Inspection services', quantity: 1, unitPrice: 300 }],
      })
      .expect(201);
    invoiceId = invoice.body.id;
    invoiceNumber = invoice.body.invoiceNumber;

    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${invoiceId}`).expect(200)).body;
    const entry = log.rows.find((r: { action: string }) => r.action === 'invoice.create');
    expect(entry).toBeTruthy();
    expect(entry.userEmail).toBe(ACCOUNTS.financeTr);
    expect(entry.entityLabel).toBe(invoiceNumber);
    expect(entry.afterData.status).toBe('draft');
    expect(entry.afterData.amountTotal).toBe(360);
    expect(entry.afterData.clientId).toBe(clientId);
    expect(entry.afterData.jobId).toBe(jobId);
  });

  it('records the issue: draft to issued, with the amount that hit the ledger', async () => {
    const issued = await as(app, financeTr).post(`/api/finance/invoices/${invoiceId}/issue`).expect(200);
    expect(issued.body.status).toBe('issued');

    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${invoiceId}`).expect(200)).body;
    const entry = log.rows.find((r: { action: string }) => r.action === 'invoice.issue');
    expect(entry).toBeTruthy();
    expect(entry.userEmail).toBe(ACCOUNTS.financeTr);
    expect(entry.beforeData.status).toBe('draft');
    expect(entry.afterData.status).toBe('issued');
    expect(entry.metadata.amountTotal).toBe(360);
  });

  it('records each payment: actor, amount applied, and the resulting balance', async () => {
    const paid = await as(app, financeTr)
      .post(`/api/finance/invoices/${invoiceId}/pay`)
      .send({ amount: 200 })
      .expect(200);
    expect(paid.body.status).toBe('partially_paid');
    expect(paid.body.amountPaid).toBe(200);

    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${invoiceId}`).expect(200)).body;
    const entry = log.rows.find((r: { action: string }) => r.action === 'invoice.pay');
    expect(entry).toBeTruthy();
    expect(entry.userEmail).toBe(ACCOUNTS.financeTr);
    expect(entry.beforeData.amountPaid).toBe(0);
    expect(entry.afterData.amountPaid).toBe(200);
    expect(entry.afterData.status).toBe('partially_paid');
    expect(entry.metadata.amountApplied).toBe(200);
  });

  it('a second, final payment gets its own entry, not a merge with the first', async () => {
    const paid = await as(app, financeTr)
      .post(`/api/finance/invoices/${invoiceId}/pay`)
      .send({ amount: 160 })
      .expect(200);
    expect(paid.body.status).toBe('paid');

    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${invoiceId}`).expect(200)).body;
    const payEntries = log.rows.filter((r: { action: string }) => r.action === 'invoice.pay');
    expect(payEntries).toHaveLength(2);
    const last = payEntries[0]; // most recent first
    expect(last.beforeData.amountPaid).toBe(200);
    expect(last.afterData.amountPaid).toBe(360);
    expect(last.afterData.status).toBe('paid');
  });

  it('never wrote line-item descriptions or the clients own record into the audit entry', async () => {
    const log = (await as(app, admin).get(`/api/admin/audit?entityId=${invoiceId}`).expect(200)).body;
    const createEntry = log.rows.find((r: { action: string }) => r.action === 'invoice.create');
    const serialized = JSON.stringify(createEntry.afterData);
    expect(serialized).not.toContain('Inspection services');
    expect(createEntry.afterData).not.toHaveProperty('lines');
  });
});

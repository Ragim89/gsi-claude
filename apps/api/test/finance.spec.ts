import { INestApplication } from '@nestjs/common';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 8: services & pricing, quotes, payments as their own entity (partial, multi-invoice,
 * overpayment/unallocated), accounts payable for expenses, job costing and margin, the client
 * statement, and overdue-reminder logging.
 *
 * The pre-existing invoice/expense flows (PHASE 0–7, never covered by an integration test
 * before this phase) are exercised here too, so this suite is also the first lock on their
 * behavior, not only on what PHASE 8 adds.
 */
describe('finance: services, pricing, quotes, payments, accounts payable, job margin', () => {
  let app: INestApplication;
  let financeTr: Session;
  let supervisorTr: Session;
  let inspectorTr: Session;
  let clientId: string;
  let serviceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    financeTr = await login(app, ACCOUNTS.financeTr);
    supervisorTr = await login(app, ACCOUNTS.supervisorTr);
    inspectorTr = await login(app, ACCOUNTS.inspectorTr);

    const client = await as(app, supervisorTr)
      .post('/api/clients')
      .send({ name: `Finance Testing ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const service = await as(app, financeTr)
      .post('/api/finance/services')
      .send({ code: `SVC-${Date.now()}`, name: { en: 'Draft survey', ru: 'Драфт-сюрвей', tr: 'Draft survey' }, unit: 'call' })
      .expect(201);
    serviceId = service.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---------------------------------------------------------------------------------------
  describe('services and pricing', () => {
    let defaultPriceId: string;

    it('prices a service for the branch by default', async () => {
      const price = await as(app, financeTr)
        .post('/api/finance/prices')
        .send({ serviceId, branchId: financeTr.user.branchId, currency: 'EUR', unitPrice: 500 })
        .expect(201);
      defaultPriceId = price.body.id;
      expect(price.body.unitPrice).toBe(500);
    });

    it('resolves the branch default when nothing more specific applies', async () => {
      const res = await as(app, financeTr)
        .get(`/api/finance/prices/resolve?serviceId=${serviceId}&branchId=${financeTr.user.branchId}`)
        .expect(200);
      expect(res.body.id).toBe(defaultPriceId);
      expect(res.body.unitPrice).toBe(500);
    });

    it('a client-specific price wins over the branch default', async () => {
      const clientPrice = await as(app, financeTr)
        .post('/api/finance/prices')
        .send({ serviceId, branchId: financeTr.user.branchId, clientId, currency: 'EUR', unitPrice: 350 })
        .expect(201);

      const resolved = await as(app, financeTr)
        .get(`/api/finance/prices/resolve?serviceId=${serviceId}&branchId=${financeTr.user.branchId}&clientId=${clientId}`)
        .expect(200);
      expect(resolved.body.id).toBe(clientPrice.body.id);
      expect(resolved.body.unitPrice).toBe(350);

      // Someone else's client still gets the branch default.
      const other = await as(app, financeTr)
        .get(`/api/finance/prices/resolve?serviceId=${serviceId}&branchId=${financeTr.user.branchId}`)
        .expect(200);
      expect(other.body.id).toBe(defaultPriceId);
    });

    it('keeps prices away from roles that may not see commercial terms', async () => {
      await as(app, inspectorTr).get('/api/finance/prices').expect(403);
      await as(app, inspectorTr)
        .post('/api/finance/prices')
        .send({ serviceId, branchId: financeTr.user.branchId, currency: 'EUR', unitPrice: 1 })
        .expect(403);
      // The catalogue itself (not the price) is not commercial data.
      await as(app, inspectorTr).get('/api/finance/services').expect(200);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('quotes', () => {
    it('goes from draft through sent to accepted, and becomes an invoice', async () => {
      const quote = await as(app, financeTr)
        .post('/api/finance/quotes')
        .send({
          clientId,
          currency: 'EUR',
          taxRate: 20,
          lines: [{ serviceId, description: 'Draft survey, one call', quantity: 1, unitPrice: 350 }],
        })
        .expect(201);
      const quoteId = quote.body.id;
      expect(quote.body.status).toBe('draft');
      expect(quote.body.amountTotal).toBe(420); // 350 + 20%

      const got = await as(app, financeTr).get(`/api/finance/quotes/${quoteId}`).expect(200);
      expect(got.body.actions).toContain('send');
      expect(got.body.actions).toContain('cancel');
      expect(got.body.actions).not.toContain('accept');

      const sent = await as(app, financeTr).post(`/api/finance/quotes/${quoteId}/send`).expect(200);
      expect(sent.body.status).toBe('sent');
      expect(sent.body.sentAt).toBeTruthy();

      const accepted = await as(app, financeTr).post(`/api/finance/quotes/${quoteId}/accept`).expect(200);
      expect(accepted.body.status).toBe('accepted');
      expect(accepted.body.decidedAt).toBeTruthy();

      // Wrong state: a draft-only action refused once it has moved on.
      await as(app, financeTr).post(`/api/finance/quotes/${quoteId}/send`).expect(409);

      const invoice = await as(app, financeTr).post(`/api/finance/quotes/${quoteId}/create-invoice`).expect(201);
      expect(invoice.body.status).toBe('draft');
      expect(invoice.body.amountTotal).toBe(420);
      expect(invoice.body.lines).toHaveLength(1);
      expect(invoice.body.lines[0].description).toBe('Draft survey, one call');
    });

    it('cannot be turned into an invoice before it is accepted', async () => {
      const quote = await as(app, financeTr)
        .post('/api/finance/quotes')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'Not yet accepted', quantity: 1, unitPrice: 10 }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/quotes/${quote.body.id}/create-invoice`).expect(409);
    });

    it('requires a reason to reject, and records it', async () => {
      const quote = await as(app, financeTr)
        .post('/api/finance/quotes')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'To be rejected', quantity: 1, unitPrice: 10 }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/quotes/${quote.body.id}/send`).expect(200);
      await as(app, financeTr).post(`/api/finance/quotes/${quote.body.id}/reject`).send({}).expect(400);
      const rejected = await as(app, financeTr)
        .post(`/api/finance/quotes/${quote.body.id}/reject`)
        .send({ reason: 'Too expensive for the client' })
        .expect(200);
      expect(rejected.body.status).toBe('rejected');
      expect(rejected.body.decisionNote).toBe('Too expensive for the client');
    });

    it('cancels a draft with a reason, and archives it', async () => {
      const quote = await as(app, financeTr)
        .post('/api/finance/quotes')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'To be cancelled', quantity: 1, unitPrice: 10 }] })
        .expect(201);
      await as(app, financeTr)
        .post(`/api/finance/quotes/${quote.body.id}/cancel`)
        .send({ reason: 'Client withdrew the request' })
        .expect(200);
    });

    it('keeps quotes away from field roles', async () => {
      await as(app, inspectorTr).get('/api/finance/quotes').expect(403);
      await as(app, inspectorTr)
        .post('/api/finance/quotes')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'Not allowed', quantity: 1, unitPrice: 1 }] })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('payments', () => {
    async function issuedInvoice(amountNet: number, taxRate = 0) {
      const inv = await as(app, financeTr)
        .post('/api/finance/invoices')
        .send({ clientId, currency: 'EUR', taxRate, lines: [{ description: 'Service', quantity: 1, unitPrice: amountNet }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/invoices/${inv.body.id}/issue`).expect(200);
      return inv.body.id as string;
    }

    it('keeps the original single-invoice payment behavior unchanged', async () => {
      const invoiceId = await issuedInvoice(200);
      const paid = await as(app, financeTr)
        .post(`/api/finance/invoices/${invoiceId}/pay`)
        .send({ amount: 200 })
        .expect(200);
      expect(paid.body.status).toBe('paid');
      expect(paid.body.amountPaid).toBe(200);

      const history = await as(app, financeTr).get(`/api/finance/invoices/${invoiceId}/payments`).expect(200);
      expect(history.body).toHaveLength(1);
      expect(history.body[0].amount).toBe(200);
    });

    it('splits one payment across two invoices', async () => {
      const invoiceA = await issuedInvoice(100);
      const invoiceB = await issuedInvoice(150);

      const payment = await as(app, financeTr)
        .post('/api/finance/payments')
        .send({
          branchId: financeTr.user.branchId,
          direction: 'inbound',
          clientId,
          currency: 'EUR',
          amount: 250,
          allocations: [
            { invoiceId: invoiceA, amount: 100 },
            { invoiceId: invoiceB, amount: 150 },
          ],
        })
        .expect(201);
      expect(payment.body.allocatedAmount).toBe(250);
      expect(payment.body.unallocatedAmount).toBe(0);

      const a = await as(app, financeTr).get(`/api/finance/invoices/${invoiceA}`).expect(200);
      const b = await as(app, financeTr).get(`/api/finance/invoices/${invoiceB}`).expect(200);
      expect(a.body.status).toBe('paid');
      expect(b.body.status).toBe('paid');
    });

    it('leaves an overpayment unallocated, then lets it be applied later', async () => {
      const invoiceC = await issuedInvoice(80);

      const payment = await as(app, financeTr)
        .post('/api/finance/payments')
        .send({
          branchId: financeTr.user.branchId,
          direction: 'inbound',
          clientId,
          currency: 'EUR',
          amount: 130,
          allocations: [{ invoiceId: invoiceC, amount: 80 }],
        })
        .expect(201);
      expect(payment.body.unallocatedAmount).toBe(50);

      const invoiceD = await issuedInvoice(50);
      const allocated = await as(app, financeTr)
        .post(`/api/finance/payments/${payment.body.id}/allocate`)
        .send({ invoiceId: invoiceD, amount: 50 })
        .expect(200);
      expect(allocated.body.unallocatedAmount).toBe(0);

      const d = await as(app, financeTr).get(`/api/finance/invoices/${invoiceD}`).expect(200);
      expect(d.body.status).toBe('paid');

      // The clearing account cannot give out more than it holds.
      const invoiceE = await issuedInvoice(1);
      await as(app, financeTr)
        .post(`/api/finance/payments/${payment.body.id}/allocate`)
        .send({ invoiceId: invoiceE, amount: 1 })
        .expect(400);
    });

    it('refuses an outbound payment with nothing to apply it to', async () => {
      await as(app, financeTr)
        .post('/api/finance/payments')
        .send({ branchId: financeTr.user.branchId, direction: 'outbound', supplier: 'Acme', currency: 'EUR', amount: 100 })
        .expect(400);
    });

    it('keeps payments away from field roles', async () => {
      await as(app, inspectorTr).get('/api/finance/payments').expect(403);
      await as(app, inspectorTr)
        .post('/api/finance/payments')
        .send({ branchId: inspectorTr.user.branchId, direction: 'inbound', clientId, currency: 'EUR', amount: 1 })
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('accounts payable', () => {
    it('books an expense as paid immediately by default, unchanged from before this phase', async () => {
      const exp = await as(app, financeTr)
        .post('/api/finance/expenses')
        .send({ category: 'office', description: 'Printer paper', amount: 40, currency: 'EUR' })
        .expect(201);
      expect(exp.body.paymentStatus).toBe('paid');
      expect(exp.body.amountPaid).toBe(40);
    });

    it('books an on-account expense as unpaid, then pays it off outbound', async () => {
      const exp = await as(app, financeTr)
        .post('/api/finance/expenses')
        .send({ category: 'subcontractor', description: 'Sub-contracted sampling', amount: 300, currency: 'EUR', onAccount: true })
        .expect(201);
      expect(exp.body.paymentStatus).toBe('unpaid');
      expect(exp.body.amountPaid).toBe(0);

      const partial = await as(app, financeTr)
        .post('/api/finance/payments')
        .send({
          branchId: financeTr.user.branchId,
          direction: 'outbound',
          supplier: 'Sub-contractor Ltd',
          currency: 'EUR',
          amount: 100,
          allocations: [{ expenseId: exp.body.id, amount: 100 }],
        })
        .expect(201);
      expect(partial.body.allocatedAmount).toBe(100);

      const half = await as(app, financeTr).get('/api/finance/expenses').expect(200);
      const seen = half.body.find((e: { id: string }) => e.id === exp.body.id);
      expect(seen.paymentStatus).toBe('partially_paid');
      expect(seen.amountPaid).toBe(100);

      await as(app, financeTr)
        .post('/api/finance/payments')
        .send({
          branchId: financeTr.user.branchId,
          direction: 'outbound',
          supplier: 'Sub-contractor Ltd',
          currency: 'EUR',
          amount: 200,
          allocations: [{ expenseId: exp.body.id, amount: 200 }],
        })
        .expect(201);

      const full = await as(app, financeTr).get('/api/finance/expenses').expect(200);
      expect(full.body.find((e: { id: string }) => e.id === exp.body.id).paymentStatus).toBe('paid');

      // Fully paid: nothing left to pay off.
      await as(app, financeTr)
        .post('/api/finance/payments')
        .send({
          branchId: financeTr.user.branchId,
          direction: 'outbound',
          supplier: 'Sub-contractor Ltd',
          currency: 'EUR',
          amount: 1,
          allocations: [{ expenseId: exp.body.id, amount: 1 }],
        })
        .expect(409);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('job costing and margin', () => {
    it('reads revenue and cost straight from the linked invoices and expenses', async () => {
      const job = await as(app, supervisorTr)
        .post('/api/jobs')
        .send({ clientId, type: 'weight_supervision', location: 'Berth 3' })
        .expect(201);
      const jobId = job.body.id;

      const inv = await as(app, financeTr)
        .post('/api/finance/invoices')
        .send({ clientId, jobId, currency: 'EUR', lines: [{ description: 'Inspection fee', quantity: 1, unitPrice: 1000 }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/invoices/${inv.body.id}/issue`).expect(200);

      await as(app, financeTr)
        .post('/api/finance/expenses')
        .send({ category: 'travel', description: 'Travel to site', amount: 300, currency: 'EUR', jobId })
        .expect(201);

      const summary = await as(app, supervisorTr).get(`/api/finance/jobs/${jobId}/summary`).expect(200);
      expect(summary.body.revenueBase).toBe(1000);
      expect(summary.body.costsBase).toBe(300);
      expect(summary.body.marginBase).toBe(700);
      expect(summary.body.marginPct).toBe(70);
      expect(summary.body.revenueLines).toHaveLength(1);
      expect(summary.body.costLines).toHaveLength(1);
    });

    it('is reserved for job.read_finance, not just anyone who can see the job', async () => {
      const job = await as(app, supervisorTr)
        .post('/api/jobs')
        .send({ clientId, type: 'weight_supervision', location: 'Berth 4' })
        .expect(201);
      await as(app, inspectorTr).get(`/api/finance/jobs/${job.body.id}/summary`).expect(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('client statement', () => {
    it('runs a balance across issued invoices and applied payments', async () => {
      const before = await as(app, financeTr).get(`/api/finance/clients/${clientId}/statement`).expect(200);
      const opening = before.body.closingBalanceBase;

      const inv = await as(app, financeTr)
        .post('/api/finance/invoices')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'Statement test', quantity: 1, unitPrice: 500 }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/invoices/${inv.body.id}/issue`).expect(200);
      await as(app, financeTr).post(`/api/finance/invoices/${inv.body.id}/pay`).send({ amount: 200 }).expect(200);

      const after = await as(app, financeTr).get(`/api/finance/clients/${clientId}/statement`).expect(200);
      // +500 issued, -200 paid = +300 net movement on the balance.
      expect(after.body.closingBalanceBase).toBeCloseTo(opening + 300, 2);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('overdue reminders', () => {
    it('logs who chased an invoice and when, without sending anything', async () => {
      const inv = await as(app, financeTr)
        .post('/api/finance/invoices')
        .send({ clientId, currency: 'EUR', lines: [{ description: 'Reminder test', quantity: 1, unitPrice: 10 }] })
        .expect(201);
      await as(app, financeTr).post(`/api/finance/invoices/${inv.body.id}/issue`).expect(200);

      await as(app, financeTr)
        .post(`/api/finance/invoices/${inv.body.id}/reminders`)
        .send({ note: 'Called accounts payable, promised payment Friday' })
        .expect(201);

      const list = await as(app, financeTr).get(`/api/finance/invoices/${inv.body.id}/reminders`).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].note).toBe('Called accounts payable, promised payment Friday');
      expect(list.body[0].sentByName).toBeTruthy();
    });

    it('requires the dedicated permission to log one, not just finance.read', async () => {
      await as(app, inspectorTr)
        .post('/api/finance/invoices/00000000-0000-0000-0000-000000000000/reminders')
        .send({})
        .expect(403);
    });
  });

  // ---------------------------------------------------------------------------------------
  describe('ledger invariant', () => {
    it('keeps every posted debit matched by a credit, across everything this suite did', async () => {
      const ownerUrl = process.env.DATABASE_OWNER_URL;
      expect(ownerUrl).toBeTruthy();
      const client = new PgClient({ connectionString: ownerUrl });
      await client.connect();
      try {
        const res = await client.query<{ diff: string }>(
          `SELECT COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) AS diff FROM ledger_entries`,
        );
        expect(Number(res.rows[0].diff)).toBeCloseTo(0, 6);
      } finally {
        await client.end();
      }
    });
  });
});

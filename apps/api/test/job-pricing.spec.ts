import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * Job/service pricing end to end: the mandatory unit price on "Create Service" (Finance →
 * Tariffs), live price resolution and per-line totals on a multi-service inspection request
 * (job_lines, migration 029), the `pricing.override` permission that lets an authorized user
 * set a manual price on a line (migration 033), currency safety (mixed currencies are never
 * summed), and the Job → Invoice total equality the "Calculate total cost" summary on the
 * request form promises.
 */
describe('jobs: service line pricing, override and invoice totals', () => {
  let app: INestApplication;
  let admin: Session; // every permission, incl. job.create + pricing.override + invoice.create
  let financeTr: Session; // pricing.manage + pricing.override, no job.create
  let supervisorTr: Session; // job.create + pricing.read, but not pricing.override
  let clientId: string;
  let serviceAId: string; // branch-default price: EUR 100
  let serviceBId: string; // branch-default price: EUR 40
  let unpricedServiceId: string; // its only price is deactivated right after creation

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    financeTr = await login(app, ACCOUNTS.financeTr);
    supervisorTr = await login(app, ACCOUNTS.supervisorTr);

    const client = await as(app, supervisorTr)
      .post('/api/clients')
      .send({ name: `Job Pricing Testing ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const a = await as(app, financeTr)
      .post('/api/finance/services')
      .send({
        code: `SVC-A-${Date.now()}`, name: { en: 'Sampling', ru: 'Отбор проб', tr: 'Numune alma' },
        unit: 'sample', currency: 'EUR', unitPrice: 100,
      })
      .expect(201);
    serviceAId = a.body.id;

    const b = await as(app, financeTr)
      .post('/api/finance/services')
      .send({
        code: `SVC-B-${Date.now()}`, name: { en: 'Lab test', ru: 'Лаб. тест', tr: 'Lab testi' },
        unit: 'test', currency: 'EUR', unitPrice: 40,
      })
      .expect(201);
    serviceBId = b.body.id;

    const u = await as(app, financeTr)
      .post('/api/finance/services')
      .send({
        code: `SVC-U-${Date.now()}`, name: { en: 'Unpriced', ru: 'Без цены', tr: 'Fiyatsız' },
        unit: 'call', currency: 'EUR', unitPrice: 1,
      })
      .expect(201);
    unpricedServiceId = u.body.id;
    // Simulate "no price configured at this office": deactivate the only price this service has.
    await as(app, financeTr).patch(`/api/finance/prices/${u.body.defaultPriceId}/deactivate`).expect(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('computes correct per-line amounts (qty × unit price) on a multi-service job', async () => {
    const job = await as(app, supervisorTr)
      .post('/api/jobs')
      .send({
        clientId, type: 'sampling', location: 'Port of Derince',
        lines: [
          { serviceId: serviceAId, quantity: 3 },
          { serviceId: serviceBId, quantity: 2 },
        ],
      })
      .expect(201);
    const lines: Array<{ serviceId: string; quantity: number; unitPrice: number; currency: string; amount: number }> =
      job.body.lines;
    expect(lines).toHaveLength(2);
    const a = lines.find((l) => l.serviceId === serviceAId)!;
    const b = lines.find((l) => l.serviceId === serviceBId)!;
    expect(a.unitPrice).toBe(100);
    expect(a.amount).toBe(300);
    expect(a.currency).toBe('EUR');
    expect(b.amount).toBe(80);
  });

  it('refuses a line with no configured price, and refuses a manual price from a caller without pricing.override', async () => {
    await as(app, supervisorTr)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince', lines: [{ serviceId: unpricedServiceId, quantity: 1 }] })
      .expect(400);

    // supervisorTr can read prices but does not hold pricing.override.
    await as(app, supervisorTr)
      .post('/api/jobs')
      .send({
        clientId, type: 'sampling', location: 'Port of Derince',
        lines: [{ serviceId: unpricedServiceId, quantity: 1, unitPrice: 75, currency: 'EUR' }],
      })
      .expect(403);
  });

  it('lets a pricing.override holder set a manual price where none is configured, and snapshots it on the line', async () => {
    const job = await as(app, admin)
      .post('/api/jobs')
      .send({
        clientId, type: 'sampling', location: 'Port of Derince',
        lines: [{ serviceId: unpricedServiceId, quantity: 2, unitPrice: 75, currency: 'EUR' }],
      })
      .expect(201);
    const line = job.body.lines[0];
    expect(line.unitPrice).toBe(75);
    expect(line.currency).toBe('EUR');
    expect(line.amount).toBe(150);
  });

  it('does not invoice a job whose lines are priced in different currencies (no FX summing)', async () => {
    const job = await as(app, admin)
      .post('/api/jobs')
      .send({
        clientId, type: 'sampling', location: 'Port of Derince',
        lines: [
          { serviceId: serviceAId, quantity: 1 },
          { serviceId: unpricedServiceId, quantity: 1, unitPrice: 50, currency: 'USD' },
        ],
      })
      .expect(201);

    await as(app, financeTr).post(`/api/finance/invoices/from-job/${job.body.id}`).expect(400);
  });

  it("a job's line total (server-resolved and overridden lines together) matches the invoice raised from it", async () => {
    const job = await as(app, admin)
      .post('/api/jobs')
      .send({
        clientId, type: 'sampling', location: 'Port of Derince',
        lines: [
          { serviceId: serviceAId, quantity: 2 }, // resolved: 100 × 2 = 200
          { serviceId: serviceBId, quantity: 5 }, // resolved: 40 × 5 = 200
          { serviceId: unpricedServiceId, quantity: 1, unitPrice: 60, currency: 'EUR' }, // override: 60
        ],
      })
      .expect(201);
    const jobTotal = job.body.lines.reduce((s: number, l: { amount: number }) => s + l.amount, 0);
    expect(jobTotal).toBe(460);

    const invoice = await as(app, financeTr).post(`/api/finance/invoices/from-job/${job.body.id}`).expect(201);
    expect(invoice.body.amountTotal).toBe(jobTotal);
    expect(invoice.body.amountNet).toBe(jobTotal);
    expect(invoice.body.taxAmount).toBe(0);
    expect(invoice.body.currency).toBe('EUR');
  });

  it('keeps the legacy single-type job path unaffected — no lines means no pricing involved', async () => {
    const job = await as(app, supervisorTr)
      .post('/api/jobs')
      .send({ clientId, type: 'sampling', location: 'Port of Derince' })
      .expect(201);
    expect(job.body.lines).toEqual([]);
  });
});

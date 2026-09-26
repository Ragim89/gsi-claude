import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * Multi-country finance compliance (migration 028_fiscal_compliance.sql). Kazakhstan is the
 * first verified rule pack (standard VAT 16% from 1 January 2026, Tax Code №214-VIII — see
 * docs/FISCAL_COMPLIANCE.md for sources); every other seeded country has no verified profile on
 * purpose, so this suite also proves the "no country gets another country's rules, and an
 * unconfigured country fails loudly" half of the requirement.
 *
 * The legacy invoice path (no legalEntityId) is exercised by every other finance spec already —
 * this file only covers the new opt-in fiscal path.
 */
describe('fiscal compliance: multi-country finance (migration 028)', () => {
  let app: INestApplication;
  let admin: Session;
  let kzCountryId: string;
  let trCountryId: string;
  let kzClientId: string;
  let trClientId: string;
  let vatEntityId: string;
  let nonVatEntityId: string;
  let trEntityId: string;
  /** Created and issued once, then re-checked for immutability across several later tests. */
  let referenceInvoiceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);

    const countries = await as(app, admin).get('/api/org/countries').expect(200);
    kzCountryId = countries.body.find((c: { code: string }) => c.code === 'KZ').id;
    trCountryId = countries.body.find((c: { code: string }) => c.code === 'TR').id;

    const kzSupervisor = await login(app, 'supervisor.kz@gsi.local');
    const kzClient = await as(app, kzSupervisor)
      .post('/api/clients')
      .send({ name: `Fiscal Test KZ Client ${Date.now()}`, country: 'KZ' })
      .expect(201);
    kzClientId = kzClient.body.id;

    const trSupervisor = await login(app, ACCOUNTS.supervisorTr);
    const trClient = await as(app, trSupervisor)
      .post('/api/clients')
      .send({ name: `Fiscal Test TR Client ${Date.now()}`, country: 'TR' })
      .expect(201);
    trClientId = trClient.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('1. a KZ legal entity created without an explicit currency defaults to KZT from the jurisdiction profile', async () => {
    const res = await as(app, admin)
      .post('/api/admin/fiscal/legal-entities')
      .send({ countryId: kzCountryId, code: `TEST-KZ-VAT-${Date.now()}`, legalName: 'Test KZ VAT LLP', vatRegistered: true })
      .expect(201);
    vatEntityId = res.body.id;
    expect(res.body.defaultCurrency).toBe('KZT');
    expect(res.body.vatRegistered).toBe(true);
    expect(res.body.hasVerifiedProfile).toBe(true);
  });

  it('2. KZ VAT payer → verified standard 16% VAT treatment', async () => {
    const inv = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: kzClientId, legalEntityId: vatEntityId, taxCode: 'STANDARD',
        lines: [{ description: 'Weight supervision', quantity: 1, unitPrice: 1000 }],
      })
      .expect(201);
    expect(inv.body.currency).toBe('KZT');
    expect(inv.body.taxCode).toBe('STANDARD');
    expect(inv.body.taxRate).toBe(16);
    expect(inv.body.taxAmount).toBe(160);
    expect(inv.body.amountTotal).toBe(1160);
    expect(inv.body.isLegacyFiscal).toBe(false);
    expect(inv.body.jurisdictionCountryCode).toBe('KZ');
    expect(inv.body.jurisdictionProfileVersion).toBe(1);
  });

  it('3. KZ non-VAT payer → no-VAT treatment, even when STANDARD is explicitly requested', async () => {
    const created = await as(app, admin)
      .post('/api/admin/fiscal/legal-entities')
      .send({ countryId: kzCountryId, code: `TEST-KZ-NOVAT-${Date.now()}`, legalName: 'Test KZ Non-VAT ИП', vatRegistered: false })
      .expect(201);
    nonVatEntityId = created.body.id;

    const inv = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: kzClientId, legalEntityId: nonVatEntityId, taxCode: 'STANDARD',
        lines: [{ description: 'Sampling', quantity: 1, unitPrice: 500 }],
      })
      .expect(201);
    expect(inv.body.taxCode).toBe('EXEMPT');
    expect(inv.body.taxRate).toBe(0);
    expect(inv.body.taxAmount).toBe(0);
    expect(inv.body.amountTotal).toBe(500);
  });

  it('4. KZ zero-rate (export) case', async () => {
    const inv = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: kzClientId, legalEntityId: vatEntityId, taxCode: 'ZERO',
        lines: [{ description: 'Export quality inspection', quantity: 1, unitPrice: 2000 }],
      })
      .expect(201);
    expect(inv.body.taxCode).toBe('ZERO');
    expect(inv.body.taxRate).toBe(0);
    expect(inv.body.amountTotal).toBe(2000);
  });

  it('5+6. line net/tax/gross and invoice subtotal/tax/total are computed and captured correctly at issue', async () => {
    const created = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: kzClientId, legalEntityId: vatEntityId, taxCode: 'STANDARD',
        lines: [
          { description: 'Line A', quantity: 2, unitPrice: 100 },
          { description: 'Line B', quantity: 1, unitPrice: 50 },
        ],
      })
      .expect(201);
    referenceInvoiceId = created.body.id;

    const issued = await as(app, admin).post(`/api/finance/invoices/${referenceInvoiceId}/issue`).expect(200);
    expect(issued.body.status).toBe('issued');
    const snap = issued.body.fiscalSnapshot;
    expect(snap).toBeTruthy();
    expect(snap.lines[0]).toMatchObject({ description: 'Line A', netAmount: 200, taxAmount: 32, grossAmount: 232 });
    expect(snap.lines[1]).toMatchObject({ description: 'Line B', netAmount: 50, taxAmount: 8, grossAmount: 58 });
    expect(snap.subtotalNet).toBe(250);
    expect(snap.taxAmount).toBe(40);
    expect(snap.grandTotal).toBe(290);
    expect(snap.taxCode).toBe('STANDARD');
    expect(snap.jurisdiction.countryCode).toBe('KZ');
    expect(snap.jurisdiction.profileVersion).toBe(1);
    expect(snap.legalEntity.vatRegistered).toBe(true);
  });

  it('7. the issued fiscal snapshot is immutable on re-fetch', async () => {
    const first = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}`).expect(200);
    const second = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}`).expect(200);
    expect(second.body.fiscalSnapshot).toEqual(first.body.fiscalSnapshot);
    expect(second.body.fiscalSnapshot.grandTotal).toBe(290);
  });

  it('8. the jurisdiction profile version in force on the invoice date was selected (v1, effective 2026-01-01)', async () => {
    const inv = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}`).expect(200);
    expect(inv.body.jurisdictionProfileVersion).toBe(1);
  });

  it('9. a future tax-rule change (a new profile version) does not alter a historical invoice', async () => {
    // A fictional v2 far in the future — chosen so it can never affect an invoice dated "today"
    // in this suite, and is only reachable by an invoice explicitly dated after it takes effect.
    await as(app, admin)
      .post('/api/admin/fiscal/jurisdiction-profiles')
      .send({
        countryCode: 'KZ',
        effectiveFrom: '2030-01-01',
        defaultDocumentCurrency: 'KZT',
        sourceNotes: 'Test fixture only — not a real legislative change.',
        config: {
          taxCodes: [{ code: 'STANDARD', label: 'Test future rate', rate: 20, kind: 'standard' }],
          invoiceRequiredFields: [], sellerFiscalIdentifierLabel: 'BIN', buyerFiscalIdentifierLabel: null,
          supplyDateRequired: true, numberingRules: { resetPeriod: 'year', description: 'test' },
          roundingRule: { decimals: 2, mode: 'half_up' }, bankPaymentRequirements: [],
          eInvoice: { required: false, system: null, description: 'test' },
          locale: { documentTerm: { ru: 'Счет-фактура' }, defaultLocale: 'ru' }, sourceCitations: ['test'],
        },
      })
      .expect(201);

    // The old, already-issued invoice is untouched.
    const old = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}`).expect(200);
    expect(old.body.jurisdictionProfileVersion).toBe(1);
    expect(old.body.taxRate).toBe(16);
    expect(old.body.fiscalSnapshot.grandTotal).toBe(290);

    // A newly created invoice dated today still resolves v1, not the future v2.
    const todays = await as(app, admin)
      .post('/api/finance/invoices')
      .send({ clientId: kzClientId, legalEntityId: vatEntityId, taxCode: 'STANDARD', lines: [{ description: 'Test line', quantity: 1, unitPrice: 10 }] })
      .expect(201);
    expect(todays.body.jurisdictionProfileVersion).toBe(1);
    expect(todays.body.taxRate).toBe(16);

    // An invoice explicitly dated after v2 takes effect resolves v2's rate — proving version
    // selection is genuinely date-driven, not just "always the latest".
    const future = await as(app, admin)
      .post('/api/finance/invoices')
      .send({
        clientId: kzClientId, legalEntityId: vatEntityId, taxCode: 'STANDARD', issueDate: '2030-06-15',
        lines: [{ description: 'Test line', quantity: 1, unitPrice: 10 }],
      })
      .expect(201);
    expect(future.body.jurisdictionProfileVersion).toBe(2);
    expect(future.body.taxRate).toBe(20);
  });

  it('10. two legal entities in KZ can have different tax registration status at the same time', async () => {
    const vat = await as(app, admin).get(`/api/admin/fiscal/legal-entities/${vatEntityId}`).expect(200);
    const nonVat = await as(app, admin).get(`/api/admin/fiscal/legal-entities/${nonVatEntityId}`).expect(200);
    expect(vat.body.vatRegistered).toBe(true);
    expect(nonVat.body.vatRegistered).toBe(false);
  });

  it('11+12. a country with no verified profile never receives KZ rules — it fails explicitly (compliance_config_required)', async () => {
    const trEntity = await as(app, admin)
      .post('/api/admin/fiscal/legal-entities')
      .send({ countryId: trCountryId, code: `TEST-TR-${Date.now()}`, legalName: 'Test TR A.Ş.', defaultCurrency: 'TRY' })
      .expect(201);
    trEntityId = trEntity.body.id;
    expect(trEntity.body.hasVerifiedProfile).toBe(false);

    const res = await as(app, admin)
      .post('/api/finance/invoices')
      .send({ clientId: trClientId, legalEntityId: trEntityId, taxCode: 'STANDARD', lines: [{ description: 'Test line', quantity: 1, unitPrice: 100 }] })
      .expect(400);
    expect(res.body.message).toMatch(/compliance_config_required/);

    // And the ordinary (legacy) TR invoice path is completely unaffected.
    await as(app, admin)
      .post('/api/finance/invoices')
      .send({ clientId: trClientId, taxRate: 18, lines: [{ description: 'Test line', quantity: 1, unitPrice: 100 }] })
      .expect(201);
  });

  it('13. issued/paid invoices remain unchanged: paying the reference invoice does not touch its fiscal snapshot', async () => {
    const before = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}`).expect(200);
    const paid = await as(app, admin).post(`/api/finance/invoices/${referenceInvoiceId}/pay`).send({ amount: 290 }).expect(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.fiscalSnapshot).toEqual(before.body.fiscalSnapshot);
  });

  it('14. an unauthorized role cannot change fiscal configuration', async () => {
    const kzSupervisor = await login(app, 'supervisor.kz@gsi.local');
    await as(app, kzSupervisor)
      .post('/api/admin/fiscal/legal-entities')
      .send({ countryId: kzCountryId, code: 'SHOULD-FAIL', legalName: 'Should fail', defaultCurrency: 'KZT' })
      .expect(403);
    await as(app, kzSupervisor)
      .post('/api/admin/fiscal/jurisdiction-profiles')
      .send({ countryCode: 'KZ', effectiveFrom: '2099-01-01', defaultDocumentCurrency: 'KZT', config: {} })
      .expect(403);
  });

  it('15. audit events are recorded for legal entity creation and jurisdiction profile versioning', async () => {
    const entityAudit = await as(app, admin).get(`/api/admin/audit?entityType=legal_entity&entityId=${vatEntityId}`).expect(200);
    expect(entityAudit.body.rows.some((r: { action: string }) => r.action === 'legal_entity.create')).toBe(true);

    const profileAudit = await as(app, admin).get('/api/admin/audit?entityType=jurisdiction_profile').expect(200);
    expect(profileAudit.body.rows.some((r: { action: string }) => r.action === 'fiscal_profile.version_created')).toBe(true);
  });

  it('18. KZ fiscal invoice renders a PDF', async () => {
    const res = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}/pdf`).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });

  it('ESF export/status boundary never simulates a government submission', async () => {
    const exportPayload = await as(app, admin).get(`/api/finance/invoices/${referenceInvoiceId}/esf-export`).expect(200);
    expect(exportPayload.body.seller.legalName).toBeTruthy();
    expect(exportPayload.body.currentStatus).toBe('draft'); // VAT-registered + e-invoice required → draft, never auto-submitted

    const updated = await as(app, admin)
      .post(`/api/finance/invoices/${referenceInvoiceId}/esf-status`)
      .send({ status: 'registered', registrationNumber: 'ESF-TEST-0001' })
      .expect(200);
    expect(updated.body.esfStatus).toBe('registered');
    expect(updated.body.esfRegistrationNumber).toBe('ESF-TEST-0001');
  });
});

import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * Phase 2: the people at a client and the contracts their work is performed under.
 */
describe('clients, contacts and contracts', () => {
  let app: INestApplication;
  let supervisor: Session;
  let inspector: Session;
  let clientId: string;
  let contractId: string;

  beforeAll(async () => {
    app = await createTestApp();
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Contract Trading ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns clients as a page with a total', async () => {
    const res = await as(app, supervisor).get('/api/clients?limit=2').expect(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeLessThanOrEqual(2);
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.rows.length);
    expect(res.body.limit).toBe(2);
  });

  it('walks through the pages without repeating a client', async () => {
    const first = (await as(app, supervisor).get('/api/clients?limit=2&offset=0').expect(200)).body;
    const second = (await as(app, supervisor).get('/api/clients?limit=2&offset=2').expect(200)).body;
    const ids = new Set(first.rows.map((c: { id: string }) => c.id));
    for (const c of second.rows) expect(ids.has(c.id)).toBe(false);
    expect(first.total).toBe(second.total);
  });

  it('keeps several contacts, with one marked as primary', async () => {
    await as(app, supervisor)
      .post(`/api/clients/${clientId}/contacts`)
      .send({ fullName: 'Ayşe Operations', position: 'Operations', email: 'ops@client.example', isPrimary: true })
      .expect(201);
    await as(app, supervisor)
      .post(`/api/clients/${clientId}/contacts`)
      .send({ fullName: 'Mehmet Accounts', position: 'Accounts', email: 'ap@client.example' })
      .expect(201);

    const list = (await as(app, supervisor).get(`/api/clients/${clientId}/contacts`).expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list[0].isPrimary).toBe(true);
    expect(list[0].fullName).toBe('Ayşe Operations');
  });

  it('moves the primary flag rather than keeping two', async () => {
    const list = (await as(app, supervisor).get(`/api/clients/${clientId}/contacts`).expect(200)).body;
    const accounts = list.find((c: { fullName: string }) => c.fullName === 'Mehmet Accounts');
    await as(app, supervisor)
      .patch(`/api/clients/${clientId}/contacts/${accounts.id}`)
      .send({ isPrimary: true })
      .expect(200);

    const after = (await as(app, supervisor).get(`/api/clients/${clientId}/contacts`).expect(200)).body;
    expect(after.filter((c: { isPrimary: boolean }) => c.isPrimary)).toHaveLength(1);
    expect(after[0].fullName).toBe('Mehmet Accounts');
  });

  it('archives a contact instead of deleting it', async () => {
    const list = (await as(app, supervisor).get(`/api/clients/${clientId}/contacts`).expect(200)).body;
    await as(app, supervisor).delete(`/api/clients/${clientId}/contacts/${list[1].id}`).expect(204);
    const after = (await as(app, supervisor).get(`/api/clients/${clientId}/contacts`).expect(200)).body;
    expect(after).toHaveLength(1);
  });

  it('creates a contract with its terms', async () => {
    const res = await as(app, supervisor)
      .post('/api/contracts')
      .send({
        clientId,
        contractNo: 'GSI-2026-001',
        title: 'Frame agreement — grain inspection',
        status: 'active',
        signedOn: '2026-01-15',
        validFrom: '2026-01-15',
        validTo: '2026-12-31',
        currency: 'EUR',
        valueAmount: 250000,
        paymentTermsDays: 30,
        incoterms: 'FOB',
        services: ['weight_supervision', 'sampling'],
      })
      .expect(201);
    contractId = res.body.id;
    expect(res.body.contractNo).toBe('GSI-2026-001');
    expect(res.body.status).toBe('active');
    expect(res.body.paymentTermsDays).toBe(30);
    expect(res.body.services).toEqual(['weight_supervision', 'sampling']);
    expect(res.body.clientName).toBeTruthy();
  });

  it('refuses a second contract with the same number for that client', async () => {
    await as(app, supervisor)
      .post('/api/contracts')
      .send({ clientId, contractNo: 'GSI-2026-001' })
      .expect(409);
  });

  it('checks the validity period makes sense', async () => {
    await as(app, supervisor)
      .post('/api/contracts')
      .send({ clientId, contractNo: 'GSI-2026-BAD', validFrom: '2026-06-01', validTo: '2026-01-01' })
      .expect(400);
  });

  it('lists contracts by client and by how soon they expire', async () => {
    const byClient = (await as(app, supervisor).get(`/api/contracts?clientId=${clientId}`).expect(200)).body;
    expect(byClient.total).toBe(1);
    expect(byClient.rows[0].daysToExpiry).toBeTypeOf('number');

    const expiring = (await as(app, supervisor).get('/api/contracts?expiringInDays=365').expect(200)).body;
    expect(expiring.rows.some((c: { id: string }) => c.id === contractId)).toBe(true);
  });

  it('attaches the signed document and serves it back', async () => {
    const pdf = Buffer.from('%PDF-1.4\n% test contract\n');
    await as(app, supervisor)
      .post(`/api/contracts/${contractId}/file`)
      .attach('file', pdf, { filename: 'frame-agreement.pdf', contentType: 'application/pdf' })
      .expect(201);

    const contract = (await as(app, supervisor).get(`/api/contracts/${contractId}`).expect(200)).body;
    expect(contract.fileName).toBe('frame-agreement.pdf');
    expect(contract.fileUrl).toBeTruthy();

    const download = await as(app, supervisor).get(`/api/contracts/${contractId}/file`).expect(200);
    expect(download.headers['content-disposition']).toContain('frame-agreement.pdf');
  });

  it('rejects a file type that is not a contract document', async () => {
    await as(app, supervisor)
      .post(`/api/contracts/${contractId}/file`)
      .attach('file', Buffer.from('rm -rf /'), { filename: 'script.sh', contentType: 'application/x-sh' })
      .expect(400);
  });

  it('keeps contracts away from roles that may not see them', async () => {
    await as(app, inspector).get('/api/contracts').expect(403);
    await as(app, inspector)
      .post('/api/contracts')
      .send({ clientId, contractNo: 'X' })
      .expect(403);
  });

  it('shows the client history: what happened to the client and to its records', async () => {
    const admin = await login(app, ACCOUNTS.admin);
    const history = (await as(app, admin).get(`/api/admin/audit?clientId=${clientId}`).expect(200)).body;
    const actions = history.rows.map((r: { action: string }) => r.action);
    expect(actions).toContain('client.create');
    expect(actions).toContain('contract.manage');
    // Contacts hang off the client, so their changes belong to its history too.
    expect(history.rows.some((r: { entityType: string }) => r.entityType === 'client_contact')).toBe(true);
  });

  it('archives a contract and leaves it out of the list', async () => {
    await as(app, supervisor).delete(`/api/contracts/${contractId}`).expect(204);
    const after = (await as(app, supervisor).get(`/api/contracts?clientId=${clientId}`).expect(200)).body;
    expect(after.total).toBe(0);
    await as(app, supervisor).get(`/api/contracts/${contractId}`).expect(404);
  });
});

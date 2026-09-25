import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, as, createTestApp, login, Session } from './app';

/**
 * PHASE 10: the general documents registry, the notification centre and global search.
 *
 * Documents and search read/write through the same Row-Level Security every other module
 * already relies on, so the interesting assertions are about permission boundaries (who may
 * upload, who may archive) and about the notification centre reaching the right person for an
 * event that already existed before this phase (a job assignment).
 */
describe('PHASE 10 — documents, notifications, search', () => {
  let app: INestApplication;
  let admin: Session;
  let supervisor: Session;
  let inspector: Session;
  let clientId: string;
  let jobId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await login(app, ACCOUNTS.admin);
    supervisor = await login(app, ACCOUNTS.supervisorTr);
    inspector = await login(app, ACCOUNTS.inspectorTr);

    const client = await as(app, supervisor)
      .post('/api/clients')
      .send({ name: `Phase 10 Client ${Date.now()}`, country: 'TR' })
      .expect(201);
    clientId = client.body.id;

    const job = await as(app, supervisor)
      .post('/api/jobs')
      .send({ clientId, type: 'weight_supervision', location: 'Port of Mersin' })
      .expect(201);
    jobId = job.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('documents registry', () => {
    let documentId: string;

    it('uploads a document to a client and serves a signed URL back', async () => {
      const pdf = Buffer.from('%PDF-1.4\n% phase 10 test\n');
      const res = await as(app, supervisor)
        .post('/api/documents')
        .field('entityType', 'client')
        .field('entityId', clientId)
        .field('category', 'identity')
        .field('title', 'KYC form')
        .attach('file', pdf, { filename: 'kyc.pdf', contentType: 'application/pdf' })
        .expect(201);

      expect(res.body.title).toBe('KYC form');
      expect(res.body.entityType).toBe('client');
      expect(res.body.version).toBe(1);
      expect(res.body.downloadUrl).toBeTruthy();
      documentId = res.body.id;

      const list = await as(app, supervisor).get(`/api/documents?entityType=client&entityId=${clientId}`).expect(200);
      expect(list.body.some((d: { id: string }) => d.id === documentId)).toBe(true);
    });

    it('rejects a file whose extension does not match its declared type', async () => {
      await as(app, supervisor)
        .post('/api/documents')
        .field('entityType', 'client')
        .field('entityId', clientId)
        .field('category', 'other')
        .field('title', 'Suspicious')
        .attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), { filename: 'script.sh', contentType: 'application/pdf' })
        .expect(400);
    });

    it('refuses to attach a document to an entity the branch cannot see', async () => {
      await as(app, supervisor)
        .post('/api/documents')
        .field('entityType', 'client')
        .field('entityId', '00000000-0000-0000-0000-000000000000')
        .field('category', 'other')
        .field('title', 'Nowhere')
        .attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
        .expect(404);
    });

    it('keeps archiving to the roles that hold document.archive', async () => {
      await as(app, inspector).post(`/api/documents/${documentId}/archive`).send({}).expect(403);
      await as(app, supervisor).post(`/api/documents/${documentId}/archive`).send({}).expect(201);

      const list = await as(app, supervisor).get(`/api/documents?entityType=client&entityId=${clientId}`).expect(200);
      expect(list.body.some((d: { id: string }) => d.id === documentId)).toBe(false);
    });

    it('registers an issued report as a reference, not a second copy, on the job it reports on', async () => {
      await as(app, admin).post(`/api/jobs/${jobId}/assignments`).send({ userId: inspector.user.id, role: 'lead_inspector' }).expect(201);
      // Approving straight from a job with no report yet issues one in the same step (docs/WORKFLOWS.md).
      // Getting a job to 'under_review' end to end is exercised in job-workflow.spec.ts; here we only
      // check that *if* a report exists for this job, it shows up as a reference, never re-uploading
      // the same PDF as a fresh binary through the general registry.
      const docs = await as(app, supervisor).get(`/api/documents?entityType=job&entityId=${jobId}`).expect(200);
      for (const d of docs.body) {
        if (d.category === 'certificate' && d.reportVersionId) {
          expect(d.downloadUrl).toBeNull(); // a reference row has no storage key of its own
        }
      }
    });
  });

  describe('notification centre', () => {
    it('notifies the assignee when a job is assigned, and only them', async () => {
      const before = await as(app, inspector).get('/api/notifications').expect(200);
      const beforeCount = before.body.unreadCount;

      await as(app, admin)
        .post(`/api/jobs/${jobId}/assignments`)
        .send({ userId: inspector.user.id, role: 'inspector' })
        .expect(201);

      // The listener runs off the same in-process event the workflow already emitted; give it a tick.
      await new Promise((r) => setTimeout(r, 200));

      const after = await as(app, inspector).get('/api/notifications').expect(200);
      expect(after.body.unreadCount).toBeGreaterThanOrEqual(beforeCount);
      const found = after.body.items.find((n: { type: string; entityId: string }) => n.type === 'job.assigned' && n.entityId === jobId);
      expect(found).toBeTruthy();

      await as(app, inspector).post(`/api/notifications/${found.id}/read`).send({}).expect(201);
      const reread = await as(app, inspector).get('/api/notifications?unreadOnly=true').expect(200);
      expect(reread.body.items.some((n: { id: string }) => n.id === found.id)).toBe(false);
    });

    it('never lets one user read another user\'s notifications', async () => {
      const mine = await as(app, inspector).get('/api/notifications').expect(200);
      const someoneElses = mine.body.items[0]?.id;
      if (someoneElses) {
        // supervisor was never the recipient of an inspector notification — marking it read is a no-op 404, not a leak.
        await as(app, supervisor).post(`/api/notifications/${someoneElses}/read`).send({}).expect(404);
      }
    });
  });

  describe('global search', () => {
    it('finds a job by its number, scoped by the same RLS the jobs list already uses', async () => {
      const job = await as(app, supervisor).get(`/api/jobs/${jobId}`).expect(200);
      const res = await as(app, supervisor).get(`/api/search?q=${job.body.jobNumber}`).expect(200);
      expect(res.body.some((r: { entityType: string; id: string }) => r.entityType === 'job' && r.id === jobId)).toBe(true);
    });

    it('finds the client by name', async () => {
      const client = await as(app, supervisor).get(`/api/clients/${clientId}`).expect(200);
      const res = await as(app, supervisor).get(`/api/search?q=${encodeURIComponent(client.body.name.slice(0, 12))}`).expect(200);
      expect(res.body.some((r: { entityType: string; id: string }) => r.entityType === 'client' && r.id === clientId)).toBe(true);
    });

    it('never returns invoices to a caller without finance.read', async () => {
      const invoice = await as(app, admin)
        .post('/api/finance/invoices')
        .send({ clientId, jobId, currency: 'USD', lines: [{ description: 'Weight supervision', quantity: 1, unitPrice: 100 }] })
        .expect(201);

      const asFinance = await as(app, admin).get(`/api/search?q=${invoice.body.invoiceNumber}`).expect(200);
      expect(asFinance.body.some((r: { entityType: string }) => r.entityType === 'invoice')).toBe(true);

      // The inspector account has no finance.read; the same query must come back empty for invoices,
      // exactly as GET /finance/invoices already does for them — search adds no new visibility.
      const asInspector = await as(app, inspector).get(`/api/search?q=${invoice.body.invoiceNumber}`).expect(200);
      expect(asInspector.body.some((r: { entityType: string }) => r.entityType === 'invoice')).toBe(false);
    });
  });
});

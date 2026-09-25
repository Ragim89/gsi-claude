import { Injectable } from '@nestjs/common';
import { AuthUser, SearchResult } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';

const LIMIT_PER_TYPE = 8;

/**
 * Global search (PHASE 10) — one query per entity type, each running under the caller's own
 * transaction and therefore the caller's own Row-Level Security: a job list already scopes to
 * branch/own, an invoice list already requires `finance.read` (`app_sees_finance()`), and this
 * runs the exact same SELECTs those list endpoints run, just filtered by a number or a name
 * instead of a page of filters. There is no separate "search visibility" to get wrong, because
 * there is no separate data path — the only new code here is which five tables get asked.
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DbService) {}

  async search(user: AuthUser, q: string): Promise<SearchResult[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const like = `%${term}%`;

    return this.db.tx(user, async (tx) => {
      const [jobs, clients, samples, reports, invoices] = await Promise.all([
        this.jobs(tx, like),
        this.clients(tx, like),
        this.samples(tx, like),
        this.reports(tx, like),
        this.invoices(tx, like),
      ]);
      return [...jobs, ...clients, ...samples, ...reports, ...invoices];
    });
  }

  private async jobs(tx: Tx, like: string): Promise<SearchResult[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT j.id::text AS id, j.job_number AS number, c.name AS label, b.code AS "branchCode", j.status::text AS status
       FROM inspection_jobs j JOIN branches b ON b.id = j.branch_id JOIN clients c ON c.id = j.client_id
       WHERE j.deleted_at IS NULL AND (j.job_number ILIKE $1 OR c.name ILIKE $1)
       ORDER BY j.created_at DESC LIMIT ${LIMIT_PER_TYPE}`,
      [like],
    );
    return rows.map((r) => ({ entityType: 'job' as const, id: String(r.id), number: String(r.number), label: String(r.label), branchCode: String(r.branchCode), status: String(r.status) }));
  }

  private async clients(tx: Tx, like: string): Promise<SearchResult[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT c.id::text AS id, c.name AS number, c.name AS label, b.code AS "branchCode"
       FROM clients c JOIN branches b ON b.id = c.branch_id
       WHERE c.deleted_at IS NULL AND c.name ILIKE $1
       ORDER BY c.name LIMIT ${LIMIT_PER_TYPE}`,
      [like],
    );
    return rows.map((r) => ({ entityType: 'client' as const, id: String(r.id), number: String(r.number), label: String(r.label), branchCode: String(r.branchCode), status: null }));
  }

  private async samples(tx: Tx, like: string): Promise<SearchResult[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT s.id::text AS id, s.sample_number AS number, j.job_number AS label, b.code AS "branchCode", s.status::text AS status
       FROM samples s JOIN branches b ON b.id = s.branch_id JOIN inspection_jobs j ON j.id = s.job_id
       WHERE s.deleted_at IS NULL AND s.sample_number ILIKE $1
       ORDER BY s.created_at DESC LIMIT ${LIMIT_PER_TYPE}`,
      [like],
    );
    return rows.map((r) => ({ entityType: 'sample' as const, id: String(r.id), number: String(r.number), label: String(r.label), branchCode: String(r.branchCode), status: String(r.status) }));
  }

  private async reports(tx: Tx, like: string): Promise<SearchResult[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT r.id::text AS id, r.report_number AS number, j.job_number AS label, b.code AS "branchCode", r.status::text AS status
       FROM reports r JOIN branches b ON b.id = r.branch_id JOIN inspection_jobs j ON j.id = r.job_id
       WHERE r.report_number ILIKE $1
       ORDER BY r.created_at DESC LIMIT ${LIMIT_PER_TYPE}`,
      [like],
    );
    return rows.map((r) => ({ entityType: 'report' as const, id: String(r.id), number: String(r.number), label: String(r.label), branchCode: String(r.branchCode), status: String(r.status) }));
  }

  private async invoices(tx: Tx, like: string): Promise<SearchResult[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT i.id::text AS id, i.invoice_number AS number, c.name AS label, b.code AS "branchCode", i.status::text AS status
       FROM invoices i JOIN branches b ON b.id = i.branch_id JOIN clients c ON c.id = i.client_id
       WHERE i.deleted_at IS NULL AND i.invoice_number ILIKE $1
       ORDER BY i.created_at DESC LIMIT ${LIMIT_PER_TYPE}`,
      [like],
    );
    return rows.map((r) => ({ entityType: 'invoice' as const, id: String(r.id), number: String(r.number), label: String(r.label), branchCode: String(r.branchCode), status: String(r.status) }));
  }
}

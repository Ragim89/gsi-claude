import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import type { Readable } from 'stream';
import {
  AuthUser,
  CERTIFICATE_TYPES,
  DocumentVerification,
  Page,
  ReportContent,
  ReportDataSnapshot,
  ReportDocument,
  ReportHistoryEntry,
  ReportStatus,
  ReportTemplateDefinition,
  ReportType,
  ReportVersion,
  REPORT_EDITABLE_STATUSES,
} from '@gsi/shared-types';
import { tokens } from '@gsi/ui-kit';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { PdfService } from './pdf.service';
import { ReportDataService } from './report-data.service';
import { ReportWorkflowService } from './report-workflow.service';
import { ReportTemplatesService } from './report-templates.service';
import { DocumentRegistryService } from './document-registry.service';
import { DEFAULT_SECTIONS, renderDocument } from './templates/document';
import { REPORT_COLUMNS, REPORT_FROM, VERSION_FROM, VERSION_WITH_NAMES } from './report-sql';

export interface CreateReportInput {
  jobId: string;
  reportType: ReportType;
  language?: string;
  title?: string | null;
  templateId?: string | null;
  inspectionId?: string | null;
  sampleId?: string | null;
  content?: ReportContent;
}

export interface ReportFilters {
  jobId?: string;
  clientId?: string;
  branchId?: string;
  reportType?: ReportType;
  status?: ReportStatus;
  language?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: 'reportNumber' | 'issuedAt' | 'status' | 'updatedAt' | 'createdAt';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORT_COLUMNS: Record<string, string> = {
  reportNumber: 'r.report_number',
  issuedAt: 'r.issued_at',
  status: 'r.status',
  updatedAt: 'r.created_at',
  createdAt: 'r.created_at',
};

/**
 * Reports and certificates as documents with a life: prepared, reviewed, approved, issued —
 * and corrected only by a revision that leaves the issued one exactly as it was sent.
 *
 * The rule the whole module turns on is that an issued document stops reading the database.
 * What it says was copied into `report_versions.data_snapshot` at the moment of issue, and the
 * PDF is rendered from that snapshot, stored once and served from storage thereafter. A client
 * renamed or a laboratory method revised next year cannot change a certificate signed today.
 */
@Injectable()
export class ReportDocumentsService {
  private readonly logger = new Logger(ReportDocumentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly pdf: PdfService,
    private readonly data: ReportDataService,
    private readonly workflow: ReportWorkflowService,
    private readonly templates: ReportTemplatesService,
    private readonly documents: DocumentRegistryService,
  ) {}

  // ---- Reading ------------------------------------------------------------------------------

  async list(user: AuthUser, f: ReportFilters): Promise<Page<ReportDocument>> {
    const limit = Math.min(f.limit ?? 50, 200);
    const offset = f.offset ?? 0;
    const sort = SORT_COLUMNS[f.sort ?? 'createdAt'] ?? SORT_COLUMNS.createdAt;
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

    const params = [
      f.jobId ?? null, f.clientId ?? null, f.branchId ?? null, f.reportType ?? null,
      f.status ?? null, f.search?.trim() || null, f.from ?? null, f.to ?? null, f.language ?? null,
    ];
    const where = `
      WHERE ($1::uuid IS NULL OR r.job_id = $1::uuid)
        AND ($2::uuid IS NULL OR r.client_id = $2::uuid)
        AND ($3::uuid IS NULL OR r.branch_id = $3::uuid)
        AND ($4::report_kind IS NULL OR r.report_type = $4::report_kind)
        AND ($5::report_status IS NULL OR r.status = $5::report_status)
        AND ($6::text IS NULL OR r.report_number ILIKE '%' || $6 || '%'
             OR j.job_number ILIKE '%' || $6 || '%' OR c.name ILIKE '%' || $6 || '%'
             OR r.title ILIKE '%' || $6 || '%'
             OR EXISTS (SELECT 1 FROM samples sx WHERE sx.job_id = r.job_id
                        AND sx.sample_number ILIKE '%' || $6 || '%'))
        AND ($7::date IS NULL OR r.created_at::date >= $7::date)
        AND ($8::date IS NULL OR r.created_at::date <= $8::date)
        AND ($9::text IS NULL OR r.locale = $9::text)`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<ReportDocument>(
          `SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM} ${where}
           ORDER BY ${sort} ${dir} NULLS LAST, r.created_at DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM reports r
             JOIN inspection_jobs j ON j.id = r.job_id
             LEFT JOIN clients c ON c.id = r.client_id
           ${where}`,
          params,
        ),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  get(user: AuthUser, id: string): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id);
      return { ...report, actions: this.workflow.available(user, report) };
    });
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<ReportDocument> {
    if (forUpdate) await tx.one('SELECT id FROM reports WHERE id = $1 FOR UPDATE', [id]);
    const row = await tx.one<ReportDocument>(
      `SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM} WHERE r.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  versions(user: AuthUser, id: string): Promise<ReportVersion[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, id);
      return tx.many<ReportVersion>(
        `SELECT ${VERSION_WITH_NAMES} FROM ${VERSION_FROM}
         WHERE v.report_id = $1 ORDER BY v.version_number DESC`,
        [id],
      );
    });
  }

  history(user: AuthUser, id: string): Promise<ReportHistoryEntry[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, id);
      return tx.many<ReportHistoryEntry>(
        `SELECT h.id::text AS id, h.report_id AS "reportId", h.version_number AS "versionNumber",
                h.from_status AS "fromStatus", h.to_status AS "toStatus", h.changed_by AS "changedBy",
                u.full_name AS "changedByName", h.reason, h.metadata, h.created_at AS "createdAt"
         FROM report_status_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.report_id = $1 ORDER BY h.created_at, h.id`,
        [id],
      );
    });
  }

  // ---- Writing ------------------------------------------------------------------------------

  /**
   * Starts a document. The number is taken now, from the same concurrency-safe counter every
   * other document in the system uses — certificates from their own sequence, reports from the
   * one that has been printing `TR-R-…` since the first release.
   */
  create(user: AuthUser, input: CreateReportInput): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const job = await tx.one<{ id: string; branch_id: string; client_id: string; job_number: string }>(
        `SELECT id, branch_id, client_id, job_number FROM inspection_jobs
         WHERE id = $1 AND deleted_at IS NULL`,
        [input.jobId],
      );
      if (!job) throw new NotFoundException('Job not found');

      const template = await this.templates.resolve(tx, input.templateId ?? null, input.reportType, job.branch_id);
      const language = input.language ?? user.locale ?? 'en';
      const kind = CERTIFICATE_TYPES.includes(input.reportType) ? 'C' : 'R';
      const { number } = (await tx.one<{ number: string }>(
        'SELECT next_doc_number($1, $2) AS number',
        [job.branch_id, kind],
      ))!;

      const row = await tx.one<{ id: string }>(
        `INSERT INTO reports (job_id, branch_id, client_id, inspection_id, sample_id, report_number,
                              report_type, title, status, version, template_id, report_template_id,
                              locale, prepared_by, prepared_at, qr_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7::report_kind, $8, 'draft'::report_status, 1,
                 $9, $10, $11, $12, now(), $13)
         RETURNING id`,
        [job.id, job.branch_id, job.client_id, input.inspectionId ?? null, input.sampleId ?? null,
         number, input.reportType, input.title?.trim() || null,
         template?.code ?? 'data-driven', template?.id ?? null, language, user.id,
         randomBytes(18).toString('base64url')],
      );

      await tx.exec(
        `INSERT INTO report_versions (report_id, branch_id, version_number, status, content, language,
                                      template_id, template_code, template_version, prepared_by)
         VALUES ($1, $2, 1, 'draft'::report_status, $3::jsonb, $4, $5, $6, $7, $8)`,
        [row!.id, job.branch_id, JSON.stringify(input.content ?? {}), language,
         template?.id ?? null, template?.code ?? null, template?.version ?? null, user.id],
      );

      await tx.exec(
        `INSERT INTO report_status_history (report_id, version_number, from_status, to_status, changed_by, reason)
         VALUES ($1, 1, NULL, 'draft'::report_status, $2, $3)`,
        [row!.id, user.id, `Started as ${input.reportType.replace(/_/g, ' ')}`],
      );

      await this.audit.record(tx, user, {
        action: 'report.created',
        entityType: 'report',
        entityId: row!.id,
        entityLabel: number,
        branchId: job.branch_id,
        after: { reportType: input.reportType, language, jobNumber: job.job_number },
      });

      const report = await this.load(tx, row!.id);
      return { ...report, actions: this.workflow.available(user, report) };
    });
  }

  /**
   * Edits the revision being written. Only the narrative and the choice of evidence: the facts
   * are the system's, and a free-text field that could overwrite a released laboratory result
   * would make the whole chain pointless.
   */
  update(
    user: AuthUser,
    id: string,
    patch: { title?: string | null; language?: string; templateId?: string | null; content?: ReportContent; lockVersion?: number },
  ): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id, true);
      if (!REPORT_EDITABLE_STATUSES.includes(report.status)) {
        throw new ConflictException(
          `A document that is ${report.status.replace(/_/g, ' ')} cannot be edited. ` +
            'Open a revision of it instead.',
        );
      }
      const version = report.currentVersion;
      if (!version) throw new ConflictException('This document has no revision to edit');
      if (patch.lockVersion !== undefined && patch.lockVersion !== version.lockVersion) {
        throw new ConflictException(
          'This document was changed by someone else while you were editing it. Reload it and try again.',
        );
      }

      /**
       * Only what was actually sent. A validated DTO carries every field it declares, absent
       * ones as `undefined`, so spreading it whole would quietly erase the paragraphs this
       * edit never mentioned.
       */
      const sent = Object.fromEntries(
        Object.entries(patch.content ?? {}).filter(([, v]) => v !== undefined),
      );
      const content = patch.content ? { ...version.content, ...sent } : version.content;
      const language = patch.language ?? version.language;
      const template = patch.templateId !== undefined
        ? await this.templates.resolve(tx, patch.templateId, report.reportType, report.branchId)
        : null;

      await tx.exec(
        `UPDATE report_versions
         SET content = $2::jsonb, language = $3, lock_version = lock_version + 1, updated_at = now(),
             template_id = COALESCE($4, template_id), template_code = COALESCE($5, template_code),
             template_version = COALESCE($6, template_version)
         WHERE id = $1`,
        [version.id, JSON.stringify(content), language,
         template?.id ?? null, template?.code ?? null, template?.version ?? null],
      );
      await tx.exec(
        `UPDATE reports SET title = COALESCE($2, title), locale = $3,
                            report_template_id = COALESCE($4, report_template_id)
         WHERE id = $1`,
        [id, patch.title?.trim() ?? null, language, template?.id ?? null],
      );

      await this.audit.record(tx, user, {
        action: 'report.updated',
        entityType: 'report',
        entityId: id,
        entityLabel: report.reportNumber,
        branchId: report.branchId,
        after: { fields: Object.keys(patch).filter((k) => k !== 'lockVersion') },
      });

      const updated = await this.load(tx, id);
      return { ...updated, actions: this.workflow.available(user, updated) };
    });
  }

  /**
   * Hands the draft in for review.
   *
   * Any earlier review signature is cleared: a document that came back for changes and has been
   * changed has to be looked at again, and leaving the old signature on it would let the
   * changes reach approval on the strength of a review of something else.
   */
  submit(user: AuthUser, id: string): Promise<ReportDocument> {
    return this.act(user, id, async (tx, report) => {
      await this.workflow.apply(tx, user, report, 'submit', {
        extraSet: 'submitted_at = now(), reviewed_by = NULL, reviewed_at = NULL',
      });
      await tx.exec(
        `UPDATE report_versions SET status = 'under_review'::report_status, submitted_by = $2,
                                    submitted_at = now(), reviewed_by = NULL, reviewed_at = NULL,
                                    updated_at = now()
         WHERE id = $1`,
        [report.currentVersion!.id, user.id],
      );
    });
  }

  /** The reviewer's signature. It does not move the status; approval is a separate decision. */
  review(user: AuthUser, id: string, comment?: string | null): Promise<ReportDocument> {
    return this.act(user, id, async (tx, report) => {
      const version = report.currentVersion;
      if (!version) throw new ConflictException('There is nothing to review');
      if (version.preparedBy === user.id && !(user.permissions?.includes('report.self_approve') ?? false)) {
        throw new ConflictException('You prepared this document; somebody else has to review it');
      }
      await this.workflow.apply(tx, user, report, 'review', { metadata: { comment: comment ?? null } });
      await tx.exec(
        `UPDATE report_versions SET reviewed_by = $2, reviewed_at = now(), review_comment = $3, updated_at = now()
         WHERE id = $1`,
        [version.id, user.id, comment?.trim() || null],
      );
      await tx.exec('UPDATE reports SET reviewed_by = $2, reviewed_at = now() WHERE id = $1', [id, user.id]);
    });
  }

  /** Back to the author, with the reason recorded where they will read it. */
  requestChanges(user: AuthUser, id: string, reason: string): Promise<ReportDocument> {
    return this.act(user, id, async (tx, report) => {
      await this.workflow.apply(tx, user, report, 'request_changes', { reason });
      await tx.exec(
        `UPDATE report_versions SET status = 'changes_requested'::report_status, review_comment = $2,
                                    reviewed_by = $3, reviewed_at = now(), updated_at = now()
         WHERE id = $1`,
        [report.currentVersion!.id, reason.trim(), user.id],
      );
    });
  }

  approve(user: AuthUser, id: string): Promise<ReportDocument> {
    return this.act(user, id, async (tx, report) => {
      await this.workflow.apply(tx, user, report, 'approve', {
        extraSet: 'approved_by = $1, approved_at = now()',
        extraParams: [user.id],
      });
      await tx.exec(
        `UPDATE report_versions SET status = 'approved'::report_status, approved_by = $2,
                                    approved_at = now(), updated_at = now()
         WHERE id = $1`,
        [report.currentVersion!.id, user.id],
      );
    });
  }

  /**
   * Issue: the moment the document becomes a document.
   *
   * The facts are frozen, the PDF is rendered from that frozen copy, hashed, stored once and
   * never rendered again — a download years from now returns the same bytes, which is the only
   * way "reproducible" means anything.
   */
  issue(user: AuthUser, id: string): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id, true);
      const version = report.currentVersion;
      if (!version) throw new ConflictException('This document has no revision to issue');

      const snapshot = await this.data.snapshot(tx, report.jobId, version.content, {
        preparedByName: version.preparedByName ?? null,
        reviewedByName: version.reviewedByName ?? null,
        approvedByName: version.approvedByName ?? null,
        issuedByName: user.fullName,
        approvedAt: version.approvedAt,
        issuedAt: new Date().toISOString(),
      });

      // The form as it stands at this moment, kept with the revision: "issued on form v1" has
      // to stay answerable after the form itself has moved on to v2.
      const template = version.templateId ? await this.templates.byId(tx, version.templateId) : null;
      const form = template?.definition ?? null;

      const token = randomBytes(18).toString('base64url');
      const { buffer, sha256 } = await this.render(tx, report, version, snapshot, token, false, form);
      const key = `reports/${snapshot.branch.code}/${report.clientId ?? 'unknown'}/` +
        `${report.reportNumber}-r${version.versionNumber}.pdf`;
      await this.storage.put(key, buffer, 'application/pdf', { sha256 });

      await this.workflow.apply(tx, user, report, 'issue', {
        extraSet: 'issued_by = $1, issued_at = now(), pdf_storage_key = $2, pdf_sha256 = $3',
        extraParams: [user.id, key, sha256],
        metadata: { version: version.versionNumber, checksum: sha256 },
      });
      await tx.exec(
        `UPDATE report_versions
         SET status = 'issued'::report_status, issued_by = $2, issued_at = now(),
             data_snapshot = $3::jsonb, pdf_storage_key = $4, pdf_sha256 = $5, pdf_bytes = $6,
             qr_token = $7, template_version = COALESCE($8, template_version),
             template_definition = $9::jsonb, updated_at = now()
         WHERE id = $1`,
        [version.id, user.id, JSON.stringify(snapshot), key, sha256, buffer.length, token,
         template?.version ?? null, form ? JSON.stringify(form) : null],
      );

      this.logger.log(`issued ${report.reportNumber} r${version.versionNumber} (${buffer.length} bytes)`);

      // Surfaces in the job's (and, once uploaded documents exist for it, the client's) document
      // list — a reference to this PDF, not a second copy of it (documents.reportVersionId).
      await this.documents.reference(tx, user, {
        entityType: 'job',
        entityId: report.jobId,
        branchId: report.branchId,
        title: `${report.reportNumber} — r${version.versionNumber}`,
        filename: `${report.reportNumber}-r${version.versionNumber}.pdf`,
        reportVersionId: version.id,
      });

      const issued = await this.load(tx, id);
      return { ...issued, actions: this.workflow.available(user, issued) };
    });
  }

  /**
   * A revision: a new draft that starts from what was issued, with the reason on the record.
   * The issued revision is untouched — it keeps its PDF, its checksum and its own QR token, so
   * the copy a client already holds still verifies as exactly what it is.
   */
  revise(user: AuthUser, id: string, reason: string): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id, true);
      const previous = report.currentVersion;
      if (!previous) throw new ConflictException('There is nothing to revise');

      await this.workflow.apply(tx, user, report, 'revise', {
        reason,
        extraSet: 'version = version + 1, prepared_by = $1, prepared_at = now(), submitted_at = NULL, ' +
          'reviewed_by = NULL, reviewed_at = NULL, approved_by = NULL, approved_at = NULL, ' +
          'issued_by = NULL, issued_at = NULL',
        extraParams: [user.id],
        metadata: { from: previous.versionNumber, to: previous.versionNumber + 1 },
      });

      await tx.exec(
        `INSERT INTO report_versions (report_id, branch_id, version_number, status, content, language,
                                      template_id, template_code, template_version, prepared_by, revision_reason)
         VALUES ($1, $2, $3, 'draft'::report_status, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
        [id, report.branchId, previous.versionNumber + 1, JSON.stringify(previous.content),
         previous.language, previous.templateId, previous.templateCode, previous.templateVersion,
         user.id, reason.trim()],
      );

      const revised = await this.load(tx, id);
      return { ...revised, actions: this.workflow.available(user, revised) };
    });
  }

  cancel(user: AuthUser, id: string, reason: string): Promise<ReportDocument> {
    return this.act(user, id, async (tx, report) => {
      await this.workflow.apply(tx, user, report, 'cancel', {
        reason,
        extraSet: 'cancel_reason = $1',
        extraParams: [reason.trim()],
      });
      await tx.exec(
        `UPDATE report_versions SET status = 'cancelled'::report_status, updated_at = now()
         WHERE report_id = $1 AND version_number = $2`,
        [id, report.version],
      );
    });
  }

  /**
   * The document a job approval produces, in the approval's own transaction.
   *
   * It is issued in one step on purpose, and that is not a hole in the workflow: approving the
   * job *is* the review, by the person who holds `job.approve`. It goes through the same
   * snapshot and the same renderer as every other document, so what it says is frozen the same
   * way — the only difference is that nobody is asked to sign twice for one decision.
   */
  async issueForJob(tx: Tx, user: AuthUser, jobId: string): Promise<ReportDocument> {
    const job = await tx.one<{ id: string; branch_id: string; client_id: string; job_number: string; locale: string }>(
      `SELECT j.id, j.branch_id, j.client_id, j.job_number, b.locale
       FROM inspection_jobs j JOIN branches b ON b.id = j.branch_id
       WHERE j.id = $1`,
      [jobId],
    );
    if (!job) throw new NotFoundException('Job not found');

    const template = await this.templates.resolve(tx, null, 'inspection_report', job.branch_id);
    const { number } = (await tx.one<{ number: string }>(
      `SELECT next_doc_number($1, 'R') AS number`,
      [job.branch_id],
    ))!;
    const token = randomBytes(18).toString('base64url');

    const reportRow = await tx.one<{ id: string }>(
      `INSERT INTO reports (job_id, branch_id, client_id, report_number, report_type, title, status,
                            version, template_id, report_template_id, locale,
                            prepared_by, prepared_at, submitted_at, reviewed_by, reviewed_at,
                            approved_by, approved_at, issued_by, issued_at, qr_code)
       VALUES ($1, $2, $3, $4, 'inspection_report'::report_kind, $5, 'issued'::report_status,
               1, $6, $7, $8, $9, now(), now(), $9, now(), $9, now(), $9, now(), $10)
       RETURNING id`,
      [job.id, job.branch_id, job.client_id, number, `${job.job_number} — inspection report`,
       template?.code ?? 'data-driven', template?.id ?? null, job.locale, user.id, token],
    );

    const report = await this.load(tx, reportRow!.id);
    const version = {
      id: '', reportId: report.id, versionNumber: 1, content: {}, language: job.locale,
      templateId: template?.id ?? null, templateCode: template?.code ?? null,
      templateVersion: template?.version ?? null, preparedByName: user.fullName,
      reviewedByName: user.fullName, approvedByName: user.fullName, approvedAt: new Date().toISOString(),
    } as unknown as ReportVersion;

    const snapshot = await this.data.snapshot(tx, jobId, {}, {
      preparedByName: user.fullName,
      reviewedByName: null,
      approvedByName: user.fullName,
      issuedByName: user.fullName,
      approvedAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
    });

    const { buffer, sha256 } = await this.render(tx, report, version, snapshot, token, false,
      template?.definition ?? null);
    const key = `reports/${snapshot.branch.code}/${job.client_id}/${number}-r1.pdf`;
    await this.storage.put(key, buffer, 'application/pdf', { sha256 });

    await tx.exec('UPDATE reports SET pdf_storage_key = $2, pdf_sha256 = $3 WHERE id = $1',
      [report.id, key, sha256]);
    const insertedVersion = await tx.one<{ id: string }>(
      `INSERT INTO report_versions (report_id, branch_id, version_number, status, content, data_snapshot,
                                    language, template_id, template_code, template_version,
                                    template_definition,
                                    pdf_storage_key, pdf_sha256, pdf_bytes, qr_token,
                                    prepared_by, submitted_by, submitted_at, reviewed_by, reviewed_at,
                                    approved_by, approved_at, issued_by, issued_at)
       VALUES ($1, $2, 1, 'issued'::report_status, '{}'::jsonb, $3::jsonb, $4, $5, $6, $7, $8::jsonb,
               $9, $10, $11, $12, $13, $13, now(), $13, now(), $13, now(), $13, now())
       RETURNING id::text`,
      [report.id, job.branch_id, JSON.stringify(snapshot), job.locale,
       template?.id ?? null, template?.code ?? null, template?.version ?? null,
       template?.definition ? JSON.stringify(template.definition) : null,
       key, sha256, buffer.length, token, user.id],
    );
    await tx.exec(
      `INSERT INTO report_status_history (report_id, version_number, from_status, to_status, changed_by, reason)
       VALUES ($1, 1, NULL, 'issued'::report_status, $2, $3)`,
      [report.id, user.id, 'Issued with the approval of the job it reports on'],
    );

    await this.documents.reference(tx, user, {
      entityType: 'job',
      entityId: jobId,
      branchId: job.branch_id,
      title: `${number} — r1`,
      filename: `${number}-r1.pdf`,
      reportVersionId: insertedVersion!.id,
    });

    this.logger.log(`issued ${number} for job ${job.job_number} (${buffer.length} bytes)`);
    return this.load(tx, report.id);
  }

  // ---- Rendering and delivery -------------------------------------------------------------

  /** The draft preview: rendered on demand, watermarked, never stored. */
  preview(user: AuthUser, id: string): Promise<Buffer> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id);
      const version = report.currentVersion;
      if (!version) throw new ConflictException('This document has no revision to preview');

      // An issued revision previews from what it actually says; a draft from today's facts.
      const snapshot = version.dataSnapshot ??
        (await this.data.snapshot(tx, report.jobId, version.content, {
          preparedByName: version.preparedByName ?? null,
          reviewedByName: version.reviewedByName ?? null,
          approvedByName: version.approvedByName ?? null,
          issuedByName: null,
          approvedAt: version.approvedAt,
          issuedAt: null,
        }));
      const { buffer } = await this.render(tx, report, version, snapshot, null, true);
      return buffer;
    });
  }

  /** The issued file, byte for byte as it was stored. */
  async download(user: AuthUser, id: string, versionNumber?: number): Promise<{ stream: Readable; filename: string }> {
    const row = await this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id);
      const v = await tx.one<{ key: string | null; n: number }>(
        `SELECT pdf_storage_key AS key, version_number AS n FROM report_versions
         WHERE report_id = $1 AND ($2::int IS NULL OR version_number = $2::int)
         ORDER BY version_number DESC LIMIT 1`,
        [id, versionNumber ?? null],
      );
      await this.audit.record(tx, user, {
        action: 'report.downloaded',
        entityType: 'report',
        entityId: id,
        entityLabel: report.reportNumber,
        branchId: report.branchId,
        after: { version: v?.n ?? null },
      });
      return { key: v?.key ?? null, number: report.reportNumber, n: v?.n ?? report.version };
    });
    if (!row.key) throw new NotFoundException('This document has no issued file yet');
    return { stream: await this.storage.getStream(row.key), filename: `${row.number}-r${row.n}.pdf` };
  }

  /**
   * The public check behind the QR code. Thin on purpose: whoever holds the document already
   * knows whose it is, and whoever merely found the code should not learn it here.
   */
  async verify(token: string): Promise<DocumentVerification> {
    const r = await this.db.tx(null, (tx) =>
      tx.one<{
        report_number: string; report_type: ReportType; status: ReportStatus; version: number;
        issued_at: string | null; issuer: string | null; branch_code: string | null;
        checksum: string | null; superseded_by_version: number | null; cancelled_reason: string | null;
        document_title: string | null; language: string | null; document_status: ReportStatus;
      }>('SELECT * FROM public_verify_document($1)', [token]),
    );
    if (!r) return { valid: false };
    return {
      valid: r.status === 'issued',
      reportNumber: r.report_number,
      reportType: r.report_type,
      documentTitle: r.document_title,
      status: r.status,
      version: r.version,
      issuedAt: r.issued_at,
      issuer: r.issuer,
      branchCode: r.branch_code,
      checksum: r.checksum,
      language: r.language,
      supersededBy: r.superseded_by_version ? `${r.report_number} rev. ${r.superseded_by_version}` : null,
      cancelledReason: r.cancelled_reason,
    };
  }

  // ---- Internals ---------------------------------------------------------------------------

  /** Every status move that carries nothing but itself, with the reload the caller expects. */
  private act(
    user: AuthUser,
    id: string,
    fn: (tx: Tx, report: ReportDocument) => Promise<void>,
  ): Promise<ReportDocument> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id, true);
      await fn(tx, report);
      const updated = await this.load(tx, id);
      return { ...updated, actions: this.workflow.available(user, updated) };
    });
  }

  private async render(
    tx: Tx,
    report: ReportDocument,
    version: ReportVersion,
    snapshot: ReportDataSnapshot,
    token: string | null,
    draft: boolean,
    /**
     * The form to print on. Issue passes the definition it captured, so the revision and the file
     * it stored came off the same layout; a draft preview passes nothing and sees today's form,
     * which is what a draft should show.
     */
    form?: ReportTemplateDefinition | null,
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const definition = form
      ?? (version.templateId ? (await this.templates.byId(tx, version.templateId))?.definition : null);

    // Images are fetched once and inlined; Chromium renders with no network access at all.
    const images = new Map<string, string>();
    await Promise.all(
      snapshot.photos.map(async (p) => {
        try {
          const buf = await this.storage.getBuffer(p.storageKey);
          images.set(p.id, `data:${p.mimeType};base64,${buf.toString('base64')}`);
        } catch (err) {
          this.logger.warn(`photo ${p.id} could not be read for ${report.reportNumber}: ${(err as Error).message}`);
        }
      }),
    );

    const verifyUrl = token ? `${config.publicWebUrl}/verify/${token}` : null;
    const { html, footer } = renderDocument({
      definition: definition ?? { sections: DEFAULT_SECTIONS[report.reportType] },
      snapshot,
      content: version.content ?? {},
      language: version.language,
      document: {
        reportNumber: report.reportNumber,
        reportType: report.reportType,
        title: report.title,
        version: version.versionNumber,
        issuedAt: draft ? null : new Date(),
        verifyUrl,
        qrDataUrl: verifyUrl
          ? await QRCode.toDataURL(verifyUrl, {
              margin: 1,
              width: 320,
              errorCorrectionLevel: 'M',
              color: { dark: tokens.color.primary, light: tokens.color.surface },
            })
          : null,
        draft,
      },
      images,
    });

    const buffer = await this.pdf.render(html, { footerHtml: footer });
    return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
  }

  /** Archive and restore, the same distinction as everywhere else: storage, not business state. */
  archive(user: AuthUser, id: string): Promise<void> {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id, true);
      if (report.status === 'issued') {
        throw new ConflictException('An issued document cannot be archived; cancel it if it should not stand');
      }
      await tx.exec('UPDATE reports SET deleted_at = now() WHERE id = $1', [id]);
      await this.audit.record(tx, user, {
        action: 'report.archived',
        entityType: 'report',
        entityId: id,
        entityLabel: report.reportNumber,
        branchId: report.branchId,
      });
    });
  }

  restore(user: AuthUser, id: string): Promise<void> {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ report_number: string; branch_id: string }>(
        'SELECT report_number, branch_id FROM reports WHERE id = $1',
        [id],
      );
      if (!row) throw new NotFoundException('Report not found');
      await tx.exec('UPDATE reports SET deleted_at = NULL WHERE id = $1', [id]);
      await this.audit.record(tx, user, {
        action: 'report.restored',
        entityType: 'report',
        entityId: id,
        entityLabel: row.report_number,
        branchId: row.branch_id,
      });
    }, { includeArchived: true });
  }

  /** What this document could be built from — the builder's data sources tab. */
  sources(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const report = await this.load(tx, id);
      return { reportId: report.id, jobId: report.jobId };
    }).then(({ jobId }) => this.data.sources(user, jobId));
  }

}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as QRCode from 'qrcode';
import type { Readable } from 'stream';
import { AuthUser, Branch, InspectionJob, Report, ReportVerification } from '@gsi/shared-types';
import { tokens } from '@gsi/ui-kit';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { config } from '../config';
import { JOB_COLUMNS, JOB_FROM } from '../operations/job-sql';
import { PdfService } from './pdf.service';
import { resolveTemplate, ReportTemplateData } from './templates';

const REPORT_COLUMNS = `
  r.id, r.branch_id AS "branchId", r.job_id AS "jobId", j.job_number AS "jobNumber", j.client_id AS "clientId",
  c.name AS "clientName", j.type AS "serviceType", r.report_number AS "reportNumber", r.version, r.status,
  r.template_id AS "templateId", r.approved_by AS "approvedBy", u.full_name AS "approvedByName",
  r.approved_at AS "approvedAt", r.qr_code AS "verificationToken", r.created_at AS "createdAt"`;

const REPORT_FROM = `
  reports r
  JOIN inspection_jobs j ON j.id = r.job_id
  JOIN clients c ON c.id = j.client_id
  LEFT JOIN users u ON u.id = r.approved_by`;

const BRANCH_COLUMNS = `
  id, code, country, city, currency, locale, ui_locales AS "uiLocales", timezone,
  legal_name AS "legalName", address, phone, email, accreditation, is_hq AS "isHq",
  letterhead_template_id AS "letterheadTemplateId"`;

/** Documents domain: report generation on branch letterhead (docs/04-media-reports.md). */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly pdf: PdfService,
  ) {}

  /**
   * Issues the official report for an approved job. Called inside the approval transaction
   * (JobsService.approve) so the job status, report row and stored PDF stay consistent.
   */
  async issueForJob(tx: Tx, user: AuthUser, jobId: string): Promise<Report> {
    const data = await this.collect(tx, jobId, false);
    const { version } = (await tx.one<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM reports WHERE job_id = $1',
      [jobId],
    ))!;
    const { number } = (await tx.one<{ number: string }>(`SELECT next_doc_number($1, 'R') AS number`, [data.branch.id]))!;
    const token = randomBytes(18).toString('base64url');
    const verifyUrl = `${config.publicWebUrl}/verify/${token}`;

    data.report = {
      number,
      version,
      issuedAt: new Date(),
      verifyUrl,
      qrDataUrl: await QRCode.toDataURL(verifyUrl, {
        margin: 1,
        width: 320,
        errorCorrectionLevel: 'M',
        color: { dark: tokens.color.primary, light: tokens.color.surface },
      }),
    };
    data.approvedByName = user.fullName;

    const template = resolveTemplate(data.branch.letterheadTemplateId);
    const pdf = await this.pdf.render(template.html(data), { footerHtml: template.footer(data) });
    const pdfSha = createHash('sha256').update(pdf).digest('hex');
    const key = `reports/${data.branch.code}/${data.job.clientId}/${number}-v${version}.pdf`;
    await this.storage.put(key, pdf, 'application/pdf', { sha256: pdfSha });

    const row = await tx.one<{ id: string }>(
      `INSERT INTO reports (job_id, report_number, version, status, template_id, locale, pdf_storage_key, pdf_sha256,
                            approved_by, approved_at, qr_code)
       VALUES ($1, $2, $3, 'issued', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [jobId, number, version, template.id, data.branch.locale, key, pdfSha, user.id, data.report.issuedAt, token],
    );
    this.logger.log(`issued ${number} v${version} for job ${data.job.jobNumber}`);
    return (await tx.one<Report>(`SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM} WHERE r.id = $1`, [row!.id]))!;
  }

  /** Unapproved preview with a DRAFT watermark; nothing is stored. */
  preview(user: AuthUser, jobId: string): Promise<Buffer> {
    return this.db.tx(user, async (tx) => {
      const data = await this.collect(tx, jobId, true);
      const template = resolveTemplate(data.branch.letterheadTemplateId);
      return this.pdf.render(template.html(data), { footerHtml: template.footer(data) });
    });
  }

  list(user: AuthUser, f: { clientId?: string; jobId?: string; branchId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Report>(
        `SELECT ${REPORT_COLUMNS} FROM ${REPORT_FROM}
         WHERE ($1::uuid IS NULL OR j.client_id = $1::uuid)
           AND ($2::uuid IS NULL OR r.job_id = $2::uuid)
           AND ($3::uuid IS NULL OR r.branch_id = $3::uuid)
         ORDER BY r.created_at DESC
         LIMIT 1000`,
        [f.clientId ?? null, f.jobId ?? null, f.branchId ?? null],
      ),
    );
  }

  async open(user: AuthUser, id: string): Promise<{ stream: Readable; filename: string }> {
    const r = await this.db.tx(user, (tx) =>
      tx.one<{ key: string | null; number: string; version: number }>(
        'SELECT pdf_storage_key AS key, report_number AS number, version FROM reports WHERE id = $1',
        [id],
      ),
    );
    if (!r || !r.key) throw new NotFoundException('Report not found');
    return { stream: await this.storage.getStream(r.key), filename: `${r.number}-v${r.version}.pdf` };
  }

  async verify(token: string): Promise<ReportVerification> {
    const r = await this.db.tx(null, (tx) =>
      tx.one<{
        report_number: string;
        status: Report['status'];
        issued_at: string;
        branch: string;
        job_number: string;
        service_type: InspectionJob['type'];
        client_name: string;
      }>('SELECT * FROM public_verify_report($1)', [token]),
    );
    if (!r) return { valid: false };
    return {
      valid: r.status === 'issued',
      reportNumber: r.report_number,
      status: r.status,
      issuedAt: r.issued_at,
      branch: r.branch,
      jobNumber: r.job_number,
      serviceType: r.service_type,
      clientName: r.client_name,
    };
  }

  /** Gathers everything the letterhead template needs; photos are inlined as data URIs. */
  private async collect(tx: Tx, jobId: string, draft: boolean): Promise<ReportTemplateData> {
    const job = await tx.one<InspectionJob>(`SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.id = $1`, [jobId]);
    if (!job) throw new NotFoundException('Job not found');
    const branch = (await tx.one<Branch>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = $1`, [job.branchId]))!;
    const client = (await tx.one<ReportTemplateData['client']>(
      `SELECT name, gafta_fosfa_ref AS "gaftaFosfaRef", address, country FROM clients WHERE id = $1`,
      [job.clientId],
    ))!;
    const items = await tx.many<Omit<ReportTemplateData['items'][number], 'photos'> & { id: string }>(
      `SELECT id, item_key AS "itemKey", label, input_kind AS "inputKind", result, value, notes
       FROM job_checklist_items WHERE job_id = $1 ORDER BY sort_order, item_key`,
      [jobId],
    );
    const media = await tx.many<{
      checklist_item_id: string | null;
      key: string;
      mime: string;
      taken_at: string | null;
      gps_lat: number | null;
      gps_lng: number | null;
    }>(
      `SELECT checklist_item_id, COALESCE(preview_key, storage_key) AS key,
              CASE WHEN preview_key IS NULL THEN mime_type ELSE 'image/jpeg' END AS mime,
              taken_at, gps_lat, gps_lng
       FROM media_attachments WHERE job_id = $1 AND type = 'photo' ORDER BY taken_at NULLS LAST, created_at`,
      [jobId],
    );

    // Downscaled previews (≤1600px JPEG) keep the PDF size reasonable; originals stay in storage.
    const photos = await Promise.all(
      media.map(async (m) => ({
        itemId: m.checklist_item_id,
        src: `data:${m.mime};base64,${(await this.storage.getBuffer(m.key)).toString('base64')}`,
        takenAt: m.taken_at,
        gpsLat: m.gps_lat,
        gpsLng: m.gps_lng,
      })),
    );

    return {
      branch,
      client,
      job,
      items: items.map(({ id, ...it }) => ({
        ...it,
        photos: photos.filter((p) => p.itemId === id).map(({ itemId: _, ...p }) => p),
      })),
      report: { number: draft ? `${job.jobNumber} (DRAFT)` : '', version: 0, issuedAt: new Date(), verifyUrl: null, qrDataUrl: null },
      approvedByName: null,
      draft,
    };
  }
}

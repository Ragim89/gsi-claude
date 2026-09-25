import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Readable } from 'stream';
import { AuthUser, Branch, InspectionJob } from '@gsi/shared-types';

import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';

import { JOB_COLUMNS, JOB_FROM } from '../operations/job-sql';
import { PdfService } from './pdf.service';
import { resolveTemplate, ReportTemplateData } from './templates';

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

  /** Unapproved preview with a DRAFT watermark; nothing is stored. */
  preview(user: AuthUser, jobId: string): Promise<Buffer> {
    return this.db.tx(user, async (tx) => {
      const data = await this.collect(tx, jobId, true);
      const template = resolveTemplate(data.branch.letterheadTemplateId);
      return this.pdf.render(template.html(data), { footerHtml: template.footer(data) });
    });
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

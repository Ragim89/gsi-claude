import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  LocalizedText,
  ReportContent,
  ReportDataSnapshot,
  ReportSnapshotPhoto,
  ReportSnapshotResult,
  ReportSources,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';

/**
 * Everything a document is made of, gathered in one pass.
 *
 * Nine queries for a whole certificate, whatever it covers: a document with twelve analyses and
 * twenty photographs costs the same round trips as one with none. The frontend never assembles
 * this — it would mean a browser deciding which laboratory results are allowed on a certificate,
 * and that decision belongs on this side of the wire.
 *
 * The result of `snapshot()` is what gets frozen into the issued revision. From then on the
 * document is printed from the snapshot and never from these tables again, so a client renamed
 * or a method revised next year cannot change what a certificate said this year.
 */
@Injectable()
export class ReportDataService {
  constructor(private readonly db: DbService) {}

  /** What a document of this type could be built from — the builder's shopping list. */
  sources(user: AuthUser, jobId: string): Promise<ReportSources> {
    return this.db.tx(user, async (tx) => {
      const job = await tx.one<{ id: string; job_number: string; client_name: string }>(
        `SELECT j.id, j.job_number, c.name AS client_name
         FROM inspection_jobs j JOIN clients c ON c.id = j.client_id
         WHERE j.id = $1 AND j.deleted_at IS NULL`,
        [jobId],
      );
      if (!job) throw new NotFoundException('Job not found');

      const [inspections, samples, results, photos] = await Promise.all([
        tx.many<ReportSources['inspections'][number]>(
          `SELECT id, inspection_number AS "inspectionNumber", type::text, status::text,
                  actual_start AS "actualStart"
           FROM inspections WHERE job_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [jobId],
        ),
        tx.many<ReportSources['samples'][number]>(
          `SELECT s.id, s.sample_number AS "sampleNumber",
                  COALESCE(cm.name->>'en', s.commodity) AS commodity, s.seal_number AS "sealNumber"
           FROM samples s LEFT JOIN commodities cm ON cm.id = s.commodity_id
           WHERE s.job_id = $1 AND s.deleted_at IS NULL ORDER BY s.created_at`,
          [jobId],
        ),
        this.releasedResults(tx, jobId),
        this.photos(tx, jobId),
      ]);

      return {
        jobId: job.id,
        jobNumber: job.job_number,
        clientName: job.client_name,
        inspections,
        samples,
        results,
        photos,
      };
    });
  }

  /**
   * The facts, as they are at this moment, filtered to what the document covers.
   *
   * Called once when a document is issued. It is also what a draft preview renders from, so
   * what a reviewer sees is put together exactly the way the final page will be.
   */
  async snapshot(
    tx: Tx,
    jobId: string,
    content: ReportContent,
    approvals: ReportDataSnapshot['approvals'],
  ): Promise<ReportDataSnapshot> {
    const job = await tx.one<{
      id: string; job_number: string; type: string; location: string | null; city: string | null;
      vessel_or_object: string | null; commodity: string | null; quantity: string | null;
      client_reference: string | null; requested_date: string | null; scheduled_at: string | null;
      branch_id: string; client_id: string; commodity_name: string | null;
      quantity_value: string | null; quantity_unit: string | null;
    }>(
      `SELECT j.id, j.job_number, j.type::text, j.location, j.city, j.vessel_or_object,
              j.commodity, j.quantity, j.client_reference, j.requested_date, j.scheduled_at,
              j.branch_id, j.client_id, cm.name->>'en' AS commodity_name,
              j.quantity_value::text AS quantity_value, j.quantity_unit
       FROM inspection_jobs j LEFT JOIN commodities cm ON cm.id = j.commodity_id
       WHERE j.id = $1 AND j.deleted_at IS NULL`,
      [jobId],
    );
    if (!job) throw new NotFoundException('Job not found');

    const [organization, branch, client, inspections, samples, results, photos] = await Promise.all([
      tx.one<ReportDataSnapshot['organization']>(
        `SELECT o.name, o.short_name AS "shortName", o.product_name AS "productName",
                o.logo_url AS "logoUrl"
         FROM branches b
         JOIN countries c ON c.id = b.country_id
         JOIN organizations o ON o.id = c.organization_id
         WHERE b.id = $1`,
        [job.branch_id],
      ),
      tx.one<ReportDataSnapshot['branch']>(
        `SELECT code, legal_name AS "legalName", address, phone, email, accreditation, country, timezone
         FROM branches WHERE id = $1`,
        [job.branch_id],
      ),
      tx.one<ReportDataSnapshot['client']>(
        `SELECT id, name, address, country, gafta_fosfa_ref AS "gaftaFosfaRef"
         FROM clients WHERE id = $1`,
        [job.client_id],
      ),
      this.inspectionDetail(tx, jobId, content.inspectionIds),
      this.sampleDetail(tx, jobId, content.sampleIds),
      this.releasedResults(tx, jobId, content.sampleIds, content.testRequestIds),
      this.photos(tx, jobId, content.photoIds),
    ]);

    return {
      takenAt: new Date().toISOString(),
      organization: organization!,
      branch: branch!,
      client: client!,
      job: {
        id: job.id,
        jobNumber: job.job_number,
        type: job.type,
        location: job.location,
        city: job.city,
        vesselOrObject: job.vessel_or_object,
        commodity: job.commodity_name ?? job.commodity,
        quantity: job.quantity_value
          ? `${job.quantity_value} ${job.quantity_unit ?? ''}`.trim()
          : job.quantity,
        clientReference: job.client_reference,
        requestedDate: job.requested_date,
        scheduledAt: job.scheduled_at,
      },
      inspections,
      samples,
      results,
      photos,
      approvals,
    };
  }

  // ---- Internals ---------------------------------------------------------------------------

  /**
   * Released revisions only, and nothing else — the one rule this whole module exists to keep.
   * A result that is entered, reviewed or even approved is not something a client may be shown,
   * and the filter lives here rather than in a screen that could forget it.
   */
  private releasedResults(
    tx: Tx,
    jobId: string,
    sampleIds?: string[],
    testRequestIds?: string[],
  ): Promise<ReportSnapshotResult[]> {
    return tx.many<ReportSnapshotResult>(
      `SELECT r.id AS "testRequestId", x.id AS "resultId", x.revision,
              s.sample_number AS "sampleNumber", t.code AS "testCode", t.name AS "testName",
              x.method_snapshot->>'code' AS "methodCode",
              x.method_snapshot->>'name' AS "methodName",
              (x.method_snapshot->>'version')::int AS "methodVersion",
              x.method_snapshot->>'standardReference' AS "standardReference",
              /* Exactly as the analyst typed it where that is known; the stored number otherwise. */
              COALESCE(
                x.numeric_text,
                CASE WHEN x.numeric_value IS NOT NULL THEN trim(trailing '.' from
                       rtrim(x.numeric_value::text, '0')) END,
                x.text_value, x.qualitative_value,
                CASE WHEN x.boolean_value IS TRUE THEN 'pass'
                     WHEN x.boolean_value IS FALSE THEN 'fail' END,
                '—') AS value,
              x.unit,
              CASE
                WHEN x.specification_snapshot->>'minValue' IS NOT NULL
                     AND x.specification_snapshot->>'maxValue' IS NOT NULL
                  THEN (x.specification_snapshot->>'minValue') || '–' || (x.specification_snapshot->>'maxValue')
                WHEN x.specification_snapshot->>'maxValue' IS NOT NULL
                  THEN '≤ ' || (x.specification_snapshot->>'maxValue')
                WHEN x.specification_snapshot->>'minValue' IS NOT NULL
                  THEN '≥ ' || (x.specification_snapshot->>'minValue')
                ELSE x.specification_snapshot->>'qualitativeRequirement'
              END AS specification,
              x.evaluation, an.full_name AS "analystName", ap.full_name AS "approvedByName",
              x.released_at AS "releasedAt"
       FROM test_results x
       JOIN test_requests r ON r.id = x.test_request_id
       JOIN samples s ON s.id = r.sample_id
       JOIN lab_tests t ON t.id = r.lab_test_id
       LEFT JOIN users an ON an.id = x.analyst_id
       LEFT JOIN users ap ON ap.id = x.approved_by
       WHERE s.job_id = $1
         AND r.status = 'released' AND x.is_current AND x.released_at IS NOT NULL
         AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
         AND ($3::uuid[] IS NULL OR r.id = ANY($3::uuid[]))
       ORDER BY s.sample_number, t.sort_order, t.code`,
      [jobId, sampleIds?.length ? sampleIds : null, testRequestIds?.length ? testRequestIds : null],
    );
  }

  private async inspectionDetail(
    tx: Tx,
    jobId: string,
    only?: string[],
  ): Promise<ReportDataSnapshot['inspections']> {
    const rows = await tx.many<{
      id: string; inspection_number: string; type: string; status: string;
      actual_start: string | null; actual_end: string | null;
      weather_conditions: string | null; site_conditions: string | null;
      general_observations: string | null; conclusion: string | null;
      inspectors: string[] | null;
    }>(
      `SELECT i.id, i.inspection_number, i.type::text, i.status::text, i.actual_start, i.actual_end,
              i.weather_conditions, i.site_conditions, i.general_observations, i.conclusion,
              ARRAY(SELECT DISTINCT u.full_name FROM inspection_assignments a
                    JOIN users u ON u.id = a.user_id
                    WHERE a.inspection_id = i.id AND a.removed_at IS NULL) AS inspectors
       FROM inspections i
       WHERE i.job_id = $1 AND i.deleted_at IS NULL
         AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
       ORDER BY i.created_at`,
      [jobId, only?.length ? only : null],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);

    // Three queries for every inspection on the document, not three per inspection.
    const [checklist, findings, measurements] = await Promise.all([
      tx.many<{
        inspection_id: string;
        label: LocalizedText;
        result: string | null;
        value: string | null;
        notes: string | null;
      }>(
        `SELECT inspection_id, label, result::text, value, notes FROM job_checklist_items
         WHERE inspection_id = ANY($1::uuid[]) ORDER BY sort_order, item_key`,
        [ids],
      ),
      tx.many<{ inspection_id: string; severity: string; title: string; description: string | null; recommendation: string | null }>(
        `SELECT inspection_id, severity::text, title, description, recommendation
         FROM inspection_findings
         WHERE inspection_id = ANY($1::uuid[]) AND is_internal = false
         ORDER BY created_at`,
        [ids],
      ),
      tx.many<{
        inspection_id: string;
        measurement_type: string;
        value: string;
        unit: string | null;
        location: string | null;
      }>(
        `SELECT inspection_id, measurement_type,
                /* Trailing zeros of numeric(18,6) are an artefact of the column, not a measurement. */
                COALESCE(
                  CASE WHEN value_numeric IS NOT NULL
                       THEN trim(trailing '.' from rtrim(value_numeric::text, '0')) END,
                  value_text, '—') AS value, unit, position AS location
         FROM inspection_measurements
         WHERE inspection_id = ANY($1::uuid[]) ORDER BY measured_at`,
        [ids],
      ),
    ]);

    return rows.map((r) => ({
      id: r.id,
      inspectionNumber: r.inspection_number,
      type: r.type,
      status: r.status,
      actualStart: r.actual_start,
      actualEnd: r.actual_end,
      weatherConditions: r.weather_conditions,
      siteConditions: r.site_conditions,
      generalObservations: r.general_observations,
      conclusion: r.conclusion,
      inspectors: r.inspectors ?? [],
      checklist: checklist
        .filter((c) => c.inspection_id === r.id)
        .map(({ inspection_id: _i, ...c }) => c),
      findings: findings
        .filter((f) => f.inspection_id === r.id)
        .map(({ inspection_id: _i, ...f }) => f),
      measurements: measurements
        .filter((m) => m.inspection_id === r.id)
        .map(({ inspection_id: _i, measurement_type, ...m }) => ({ type: measurement_type, ...m })),
    }));
  }

  private async sampleDetail(tx: Tx, jobId: string, only?: string[]): Promise<ReportDataSnapshot['samples']> {
    const rows = await tx.many<{
      id: string; sample_number: string; sample_type: string; sampling_method: string;
      commodity: string | null; quantity: string | null; unit: string | null;
      seal_number: string | null; sampled_at: string | null; sampled_by_name: string | null;
      location: string | null; laboratory_name: string | null;
    }>(
      `SELECT s.id, s.sample_number, s.sample_type::text, s.sampling_method::text,
              COALESCE(cm.name->>'en', s.commodity) AS commodity, s.quantity::text, s.unit,
              s.seal_number, s.sampled_at, u.full_name AS sampled_by_name, s.location,
              l.name AS laboratory_name
       FROM samples s
       LEFT JOIN commodities cm ON cm.id = s.commodity_id
       LEFT JOIN users u ON u.id = s.sampled_by
       LEFT JOIN laboratories l ON l.id = s.destination_laboratory_id
       WHERE s.job_id = $1 AND s.deleted_at IS NULL
         AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[]))
       ORDER BY s.sample_number`,
      [jobId, only?.length ? only : null],
    );
    if (!rows.length) return [];

    /**
     * The custody summary is the handover story, not the internal record: who received the
     * sample and when, without the notes colleagues wrote to each other about it.
     */
    const custody = await tx.many<{ sample_id: string; event: string; at: string; by: string | null }>(
      `SELECT e.sample_id, e.event_type::text AS event, e.occurred_at AS at,
              COALESCE(tu.full_name, l.name, e.to_location) AS by
       FROM sample_custody_events e
       LEFT JOIN users tu ON tu.id = e.to_user_id
       LEFT JOIN laboratories l ON l.id = e.laboratory_id
       WHERE e.sample_id = ANY($1::uuid[])
         /* A corrected entry stays in the chain, but the document prints the correction. */
         AND NOT EXISTS (SELECT 1 FROM sample_custody_events c WHERE c.corrects_event_id = e.id)
       ORDER BY e.occurred_at`,
      [rows.map((r) => r.id)],
    );

    return rows.map((r) => ({
      id: r.id,
      sampleNumber: r.sample_number,
      sampleType: r.sample_type,
      samplingMethod: r.sampling_method,
      commodity: r.commodity,
      quantity: r.quantity,
      unit: r.unit,
      sealNumber: r.seal_number,
      sampledAt: r.sampled_at,
      sampledByName: r.sampled_by_name,
      location: r.location,
      laboratoryName: r.laboratory_name,
      custodySummary: custody
        .filter((c) => c.sample_id === r.id)
        .map(({ sample_id: _s, ...c }) => c),
    }));
  }

  /** Photograph metadata only; the images themselves are fetched from storage at render time. */
  private photos(tx: Tx, jobId: string, only?: string[]): Promise<ReportSnapshotPhoto[]> {
    return tx.many<ReportSnapshotPhoto>(
      `SELECT m.id, m.caption, m.category::text, m.taken_at AS "takenAt",
              m.gps_lat AS "gpsLat", m.gps_lng AS "gpsLng",
              COALESCE(m.preview_key, m.storage_key) AS "storageKey",
              CASE WHEN m.preview_key IS NULL THEN m.mime_type ELSE 'image/jpeg' END AS "mimeType"
       FROM media_attachments m
       WHERE m.job_id = $1 AND m.type = 'photo'
         AND ($2::uuid[] IS NULL OR m.id = ANY($2::uuid[]))
       ORDER BY m.taken_at NULLS LAST, m.created_at`,
      [jobId, only?.length ? only : null],
    );
  }
}

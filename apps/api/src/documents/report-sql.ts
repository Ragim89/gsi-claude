/**
 * The column lists the documents module shares.
 *
 * The revision being written is fetched with a LATERAL rather than a second round trip per
 * row: a register of fifty documents costs two queries, not fifty-one.
 */

export const VERSION_COLUMNS = `
  v.id, v.report_id AS "reportId", v.version_number AS "versionNumber", v.status,
  v.content, v.data_snapshot AS "dataSnapshot", v.language,
  v.template_id AS "templateId", v.template_code AS "templateCode", v.template_version AS "templateVersion",
  v.pdf_storage_key AS "pdfStorageKey", v.pdf_sha256 AS "pdfSha256", v.pdf_bytes::float8 AS "pdfBytes",
  v.prepared_by AS "preparedBy", v.prepared_at AS "preparedAt",
  v.submitted_by AS "submittedBy", v.submitted_at AS "submittedAt",
  v.reviewed_by AS "reviewedBy", v.reviewed_at AS "reviewedAt", v.review_comment AS "reviewComment",
  v.approved_by AS "approvedBy", v.approved_at AS "approvedAt",
  v.issued_by AS "issuedBy", v.issued_at AS "issuedAt",
  v.revision_reason AS "revisionReason", v.qr_token AS "qrToken",
  v.is_legacy AS "isLegacy", v.lock_version AS "lockVersion",
  v.created_at AS "createdAt", v.updated_at AS "updatedAt"`;

export const VERSION_WITH_NAMES = `
  ${VERSION_COLUMNS},
  pu.full_name AS "preparedByName", rv.full_name AS "reviewedByName",
  ap.full_name AS "approvedByName", iu.full_name AS "issuedByName"`;

export const VERSION_FROM = `
  report_versions v
  LEFT JOIN users pu ON pu.id = v.prepared_by
  LEFT JOIN users rv ON rv.id = v.reviewed_by
  LEFT JOIN users ap ON ap.id = v.approved_by
  LEFT JOIN users iu ON iu.id = v.issued_by`;

export const REPORT_COLUMNS = `
  r.id, r.branch_id AS "branchId", b.code AS "branchCode",
  r.report_number AS "reportNumber", r.report_type AS "reportType", r.title, r.status, r.version,
  r.locale AS "language",
  r.job_id AS "jobId", j.job_number AS "jobNumber",
  r.client_id AS "clientId", c.name AS "clientName",
  r.inspection_id AS "inspectionId", i.inspection_number AS "inspectionNumber",
  r.sample_id AS "sampleId", s.sample_number AS "sampleNumber",
  r.report_template_id AS "templateId", tpl.code AS "templateCode", tpl.name AS "templateName",
  r.prepared_by AS "preparedBy", pu.full_name AS "preparedByName", r.prepared_at AS "preparedAt",
  r.submitted_at AS "submittedAt",
  r.reviewed_by AS "reviewedBy", ru.full_name AS "reviewedByName", r.reviewed_at AS "reviewedAt",
  r.approved_by AS "approvedBy", au.full_name AS "approvedByName", r.approved_at AS "approvedAt",
  r.issued_by AS "issuedBy", iu.full_name AS "issuedByName", r.issued_at AS "issuedAt",
  r.cancel_reason AS "cancelReason",
  /* The code printed on the copy people hold: the latest issued revision's own. */
  COALESCE(iss.qr_token, r.qr_code) AS "verificationToken", r.pdf_sha256 AS "pdfSha256",
  live.version AS "currentVersion",
  COALESCE(counts.versions, 0)::int AS "versionCount",
  r.created_at AS "createdAt", r.deleted_at AS "deletedAt"`;

export const REPORT_FROM = `
  reports r
  JOIN branches b ON b.id = r.branch_id
  JOIN inspection_jobs j ON j.id = r.job_id
  LEFT JOIN clients c ON c.id = r.client_id
  LEFT JOIN inspections i ON i.id = r.inspection_id
  LEFT JOIN samples s ON s.id = r.sample_id
  LEFT JOIN report_templates tpl ON tpl.id = r.report_template_id
  LEFT JOIN users pu ON pu.id = r.prepared_by
  LEFT JOIN users ru ON ru.id = r.reviewed_by
  LEFT JOIN users au ON au.id = r.approved_by
  LEFT JOIN users iu ON iu.id = r.issued_by
  LEFT JOIN LATERAL (
    SELECT to_jsonb(x) AS version FROM (
      SELECT ${VERSION_WITH_NAMES} FROM ${VERSION_FROM}
      WHERE v.report_id = r.id ORDER BY v.version_number DESC LIMIT 1
    ) x
  ) live ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS versions FROM report_versions vc WHERE vc.report_id = r.id
  ) counts ON true
  LEFT JOIN LATERAL (
    SELECT vi.qr_token FROM report_versions vi
    WHERE vi.report_id = r.id AND vi.qr_token IS NOT NULL
    ORDER BY vi.version_number DESC LIMIT 1
  ) iss ON true`;

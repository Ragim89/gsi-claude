/**
 * The column lists the laboratory services share.
 *
 * The live result is fetched with a LATERAL rather than a second round trip per row: a work
 * queue of fifty tests costs two queries, not a hundred and one.
 */

export const RESULT_COLUMNS = `
  x.id, x.test_request_id AS "testRequestId", x.revision, x.is_current AS "isCurrent",
  x.supersedes_result_id AS "supersedesResultId", x.result_type AS "resultType",
  x.numeric_value::float8 AS "numericValue", x.text_value AS "textValue",
  x.boolean_value AS "booleanValue", x.qualitative_value AS "qualitativeValue", x.unit,
  x.method_snapshot AS "methodSnapshot", x.specification_snapshot AS "specificationSnapshot",
  x.evaluation, x.instrument_id AS "instrumentId", x.instrument_overdue AS "instrumentOverdue",
  x.analyst_id AS "analystId", x.entered_at AS "enteredAt", x.submitted_at AS "submittedAt",
  x.reviewed_by AS "reviewedBy", x.reviewed_at AS "reviewedAt",
  x.approved_by AS "approvedBy", x.approved_at AS "approvedAt",
  x.released_by AS "releasedBy", x.released_at AS "releasedAt",
  x.comments, x.review_comment AS "reviewComment", x.amendment_reason AS "amendmentReason",
  x.version, x.created_at AS "createdAt", x.updated_at AS "updatedAt"`;

/** The same columns plus the names a screen shows instead of identifiers. */
export const RESULT_WITH_NAMES = `
  ${RESULT_COLUMNS},
  an.full_name AS "analystName", rv.full_name AS "reviewedByName",
  ap.full_name AS "approvedByName", rl.full_name AS "releasedByName",
  inst.name AS "instrumentName"`;

export const RESULT_FROM = `
  test_results x
  LEFT JOIN users an ON an.id = x.analyst_id
  LEFT JOIN users rv ON rv.id = x.reviewed_by
  LEFT JOIN users ap ON ap.id = x.approved_by
  LEFT JOIN users rl ON rl.id = x.released_by
  LEFT JOIN lab_instruments inst ON inst.id = x.instrument_id`;

export const REQUEST_COLUMNS = `
  r.id, r.branch_id AS "branchId", b.code AS "branchCode",
  r.sample_id AS "sampleId", s.sample_number AS "sampleNumber",
  s.job_id AS "jobId", j.job_number AS "jobNumber", s.inspection_id AS "inspectionId",
  s.client_id AS "clientId", c.name AS "clientName",
  s.commodity_id AS "commodityId", cm.name AS "commodityName", s.commodity,
  r.laboratory_id AS "laboratoryId", l.name AS "laboratoryName",
  r.lab_test_id AS "labTestId", t.code AS "testCode", t.name AS "testName", t.result_type AS "resultType",
  r.test_method_id AS "testMethodId", m.code AS "methodCode", m.name AS "methodName", m.version AS "methodVersion",
  r.specification_id AS "specificationId",
  r.status, r.status_before_hold AS "statusBeforeHold", r.priority,
  r.requested_by AS "requestedBy", rb.full_name AS "requestedByName", r.requested_at AS "requestedAt",
  r.assigned_analyst_id AS "assignedAnalystId", aa.full_name AS "assignedAnalystName",
  r.assigned_at AS "assignedAt", r.started_at AS "startedAt", r.due_at AS "dueAt",
  r.instructions, r.cancel_reason AS "cancelReason", r.version,
  /* Overdue is computed, never stored: due in the past while the answer is still owed. */
  (r.due_at IS NOT NULL AND r.due_at < now()
   AND r.status IN ('requested','assigned','in_progress','result_entered','under_review','on_hold')) AS "overdue",
  live.result,
  COALESCE(counts.revisions, 0)::int AS "revisionCount",
  COALESCE(counts.attachments, 0)::int AS "attachmentCount",
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"`;

export const REQUEST_FROM = `
  test_requests r
  JOIN branches b ON b.id = r.branch_id
  JOIN samples s ON s.id = r.sample_id
  JOIN inspection_jobs j ON j.id = s.job_id
  JOIN clients c ON c.id = s.client_id
  LEFT JOIN commodities cm ON cm.id = s.commodity_id
  JOIN laboratories l ON l.id = r.laboratory_id
  JOIN lab_tests t ON t.id = r.lab_test_id
  JOIN test_methods m ON m.id = r.test_method_id
  LEFT JOIN users rb ON rb.id = r.requested_by
  LEFT JOIN users aa ON aa.id = r.assigned_analyst_id
  LEFT JOIN LATERAL (
    SELECT to_jsonb(v) AS result FROM (
      SELECT ${RESULT_WITH_NAMES} FROM ${RESULT_FROM}
      WHERE x.test_request_id = r.id AND x.is_current
    ) v
  ) live ON true
  LEFT JOIN LATERAL (
    SELECT (SELECT count(*) FROM test_results tr WHERE tr.test_request_id = r.id) AS revisions,
           (SELECT count(*) FROM media_attachments ma
            JOIN test_results tr2 ON tr2.id = ma.test_result_id
            WHERE tr2.test_request_id = r.id) AS attachments
  ) counts ON true`;

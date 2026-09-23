// Shared SELECT fragments for inspection jobs (used by Operations and Documents modules).

export const JOB_COLUMNS = `
  j.id, j.branch_id AS "branchId", b.code AS "branchCode", j.job_number AS "jobNumber",
  j.client_id AS "clientId", c.name AS "clientName", j.type, j.status,
  j.assigned_inspector_id AS "assignedInspectorId", i.full_name AS "assignedInspectorName",
  j.location, j.vessel_or_object AS "vesselOrObject", j.commodity, j.quantity,
  j.commodity_id AS "commodityId", cm.name AS "commodityName", cm."group" AS "commodityGroup",
  j.port_id AS "portId", p.name AS "portName", p.country AS "portCountry",
  j.contract_no AS "contractNo", j.quantity_value::float8 AS "quantityValue", j.quantity_unit AS "quantityUnit",
  j.scheduled_at AS "scheduledAt", j.instructions, j.review_comment AS "reviewComment",
  j.submitted_at AS "submittedAt", j.approved_at AS "approvedAt", j.approved_by AS "approvedBy",
  j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

export const JOB_FROM = `
  inspection_jobs j
  JOIN branches b ON b.id = j.branch_id
  JOIN clients c ON c.id = j.client_id
  LEFT JOIN users i ON i.id = j.assigned_inspector_id
  LEFT JOIN commodities cm ON cm.id = j.commodity_id
  LEFT JOIN ports p ON p.id = j.port_id`;

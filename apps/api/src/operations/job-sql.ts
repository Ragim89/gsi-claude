// Shared SELECT fragments for inspection jobs (used by Operations and Documents modules).

export const JOB_COLUMNS = `
  j.id, j.branch_id AS "branchId", b.code AS "branchCode", b.country_id AS "countryId", j.job_number AS "jobNumber",
  j.client_id AS "clientId", c.name AS "clientName", j.type, j.status, j.priority,
  j.assigned_inspector_id AS "assignedInspectorId", i.full_name AS "assignedInspectorName",
  j.client_contact_id AS "clientContactId", cc.full_name AS "clientContactName",
  j.requesting_branch_id AS "requestingBranchId", rb.code AS "requestingBranchCode",
  j.location, j.city, j.vessel_or_object AS "vesselOrObject", j.object_kind AS "objectKind",
  j.container_no AS "containerNo", j.transport_ref AS "transportRef",
  j.commodity, j.quantity, j.client_reference AS "clientReference", j.internal_notes AS "internalNotes",
  j.commodity_id AS "commodityId", cm.name AS "commodityName", cm."group" AS "commodityGroup",
  j.port_id AS "portId", p.name AS "portName", p.country AS "portCountry",
  j.contract_no AS "contractNo", j.contract_id AS "contractId", ctr.contract_no AS "contractRef",
  j.quantity_value::float8 AS "quantityValue", j.quantity_unit AS "quantityUnit",
  to_char(j.requested_date, 'YYYY-MM-DD') AS "requestedDate",
  j.scheduled_at AS "scheduledAt", j.instructions, j.review_comment AS "reviewComment",
  j.status_before_hold AS "statusBeforeHold", j.version,
  j.submitted_at AS "submittedAt", j.approved_at AS "approvedAt", j.approved_by AS "approvedBy",
  j.deleted_at AS "archivedAt",
  /* Overdue is never stored: it is simply a date in the past on work that is still open. */
  (j.scheduled_at IS NOT NULL AND j.scheduled_at < now()
   AND j.status NOT IN ('approved', 'completed', 'invoiced', 'closed', 'cancelled')) AS "overdue",
  COALESCE((SELECT json_agg(json_build_object('id', a.id, 'userId', a.user_id, 'userName', u.full_name,
                                              'role', a.role) ORDER BY a.role, u.full_name)
            FROM job_assignments a JOIN users u ON u.id = a.user_id
            WHERE a.job_id = j.id AND a.removed_at IS NULL), '[]'::json) AS "assignees",
  j.created_by AS "createdBy", cb.full_name AS "createdByName",
  j.created_at AS "createdAt", j.updated_at AS "updatedAt"`;

export const JOB_FROM = `
  inspection_jobs j
  JOIN branches b ON b.id = j.branch_id
  JOIN clients c ON c.id = j.client_id
  LEFT JOIN users i ON i.id = j.assigned_inspector_id
  LEFT JOIN users cb ON cb.id = j.created_by
  LEFT JOIN client_contacts cc ON cc.id = j.client_contact_id
  LEFT JOIN branches rb ON rb.id = j.requesting_branch_id
  LEFT JOIN commodities cm ON cm.id = j.commodity_id
  LEFT JOIN ports p ON p.id = j.port_id
  LEFT JOIN contracts ctr ON ctr.id = j.contract_id`;

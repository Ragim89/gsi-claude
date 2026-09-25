-- ---------------------------------------------------------------------------------------
-- 024. PHASE 10 — Notification centre.
--
-- One row per (user, thing that happened). Unlike `finance_events` (LISTEN/NOTIFY, nothing
-- stored — see finance-events.service.ts), a notification has to survive until the recipient
-- reads it, possibly days later, so it is a table, not just a channel.
--
-- The awkward part is who is allowed to INSERT. A notification is written by whichever backend
-- process noticed the triggering event — the transaction of the user who *caused* it (assigned
-- the job, received the sample) — for a *different* user, the recipient. Row-Level Security
-- scoped to "your own rows" would have to let the actor write into a stranger's notifications,
-- which is exactly the hole a table like this cannot have. So there is no INSERT policy at all:
-- rows are written through `create_notification()`, a SECURITY DEFINER function narrow enough
-- to audit at a glance (it does exactly one INSERT), the same technique 008_rbac.sql already
-- uses for `app_can_see_branch()` to cross a boundary a plain policy cannot.
-- ---------------------------------------------------------------------------------------

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  type         text NOT NULL,
  title        text NOT NULL,
  body         text,
  entity_type  text,
  entity_id    uuid,
  entity_label text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);
-- Dedupe lookups ("has this inspection/invoice already been notified about") scan this shape.
CREATE INDEX notifications_entity_idx ON notifications (type, entity_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_own_read ON notifications FOR SELECT
  USING (user_id = app_user_id());

-- The only outside change a recipient makes to their own row: marking it read.
CREATE POLICY notifications_own_update ON notifications FOR UPDATE
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());

GRANT SELECT, UPDATE ON notifications TO gsi_app;

CREATE FUNCTION create_notification(
  p_user_id uuid, p_branch_id uuid, p_type text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid, p_entity_label text
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO notifications (user_id, branch_id, type, title, body, entity_type, entity_id, entity_label)
  VALUES (p_user_id, p_branch_id, p_type, p_title, p_body, p_entity_type, p_entity_id, p_entity_label)
  RETURNING id
$$;

REVOKE ALL ON FUNCTION create_notification(uuid, uuid, text, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_notification(uuid, uuid, text, text, text, text, uuid, text) TO gsi_app;

-- Two more reads that cross the same boundary as the write above: the process reacting to an
-- event has no "current user" whose scope would make `users`/`role_permissions` visible under
-- their own RLS, and dedupe has to see every notification ever written for an entity, not only
-- the caller's own. Same SECURITY DEFINER technique, same reason.

CREATE FUNCTION users_with_permission(p_branch_id uuid, p_permission text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT u.id FROM users u
  JOIN user_roles ur ON ur.user_id = u.id
  JOIN role_permissions rp ON rp.role_code = ur.role_code
  WHERE u.branch_id = p_branch_id AND u.is_active AND rp.permission_code = p_permission
$$;

CREATE FUNCTION notification_exists(p_type text, p_entity_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM notifications WHERE type = p_type AND entity_id = p_entity_id)
$$;

REVOKE ALL ON FUNCTION users_with_permission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION notification_exists(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION users_with_permission(uuid, text) TO gsi_app;
GRANT EXECUTE ON FUNCTION notification_exists(text, uuid) TO gsi_app;

-- ---------------------------------------------------------------------------------------
-- The two sweeps `notifications-cron.service.ts` runs hourly ("inspection due" has no action
-- to react to — it is a clock, not an event — and "invoice overdue" is a fact about today's
-- date, not something invoices.service.ts already announces). Same SECURITY DEFINER reason as
-- above: a cron tick has no signed-in user whose RLS scope would show it every branch's rows.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION inspections_due_soon(p_hours integer) RETURNS TABLE (
  inspection_id uuid, branch_id uuid, job_number text, scheduled_start timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.branch_id, j.job_number, i.scheduled_start
  FROM inspections i JOIN inspection_jobs j ON j.id = i.job_id
  WHERE i.status = 'scheduled' AND i.deleted_at IS NULL
    AND i.scheduled_start BETWEEN now() AND now() + make_interval(hours => p_hours)
$$;

CREATE FUNCTION inspection_assignees(p_inspection_id uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT user_id FROM inspection_assignments WHERE inspection_id = p_inspection_id AND removed_at IS NULL
$$;

CREATE FUNCTION invoices_newly_overdue() RETURNS TABLE (invoice_id uuid, branch_id uuid, invoice_number text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, branch_id, invoice_number FROM invoices
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'cancelled') AND due_date < current_date
$$;

REVOKE ALL ON FUNCTION inspections_due_soon(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION inspection_assignees(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION invoices_newly_overdue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inspections_due_soon(integer) TO gsi_app;
GRANT EXECUTE ON FUNCTION inspection_assignees(uuid) TO gsi_app;
GRANT EXECUTE ON FUNCTION invoices_newly_overdue() TO gsi_app;

INSERT INTO permissions (code, category, description) VALUES
  ('notification.read', 'notifications', 'View and mark read one''s own notifications')
ON CONFLICT DO NOTHING;

-- Everyone gets their own notifications; RLS above already confines each user to their own rows,
-- so this permission only gates the endpoint, not the data.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'notification.read' FROM roles
ON CONFLICT DO NOTHING;

INSERT INTO permissions (code, category, description) VALUES
  ('search.read', 'search', 'Use global search across jobs, clients, samples, reports and invoices')
ON CONFLICT DO NOTHING;

-- Search runs the same SELECTs the entity list pages already run, under the same RLS
-- (branch/own scope, finance.read for invoices) — this permission only gates the endpoint.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'search.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'finance_controller', 'sales', 'report_reviewer', 'lab_manager', 'lab_analyst',
               'inspector', 'sampler', 'viewer')
ON CONFLICT DO NOTHING;

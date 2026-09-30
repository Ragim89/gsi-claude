-- =====================================================================================
-- 030. Trace an invoice line back to the service/job line it was billed from.
--
-- Purely additive: three nullable columns on `invoice_lines`. Every existing invoice line,
-- and every future ad hoc/free-text line (no job, no service — finance bills things that
-- were never a job all the time), keeps working exactly as before with all three NULL.
-- Populated once at INSERT by InvoicesService.create()/createFromJob(), never UPDATEd
-- afterward — invoice lines already have no edit path once issued.
-- =====================================================================================

ALTER TABLE invoice_lines
  ADD COLUMN service_id     uuid REFERENCES services(id) ON DELETE SET NULL,
  ADD COLUMN job_line_id    uuid REFERENCES job_lines(id) ON DELETE SET NULL,
  ADD COLUMN price_snapshot jsonb;

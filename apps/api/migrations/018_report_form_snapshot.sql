/**
 * PHASE 7, closing two gaps the final verification found.
 *
 *   1. **The form is part of the document, not a pointer to a form.** A revision recorded
 *      *which* template version printed it (`template_version`), but the layout itself stayed
 *      in `report_templates`, where it can be edited. The stored PDF cannot change, so the
 *      document a client holds is safe either way — but "issued with form v1" was a claim the
 *      database could no longer substantiate once the form moved to v2. `template_definition`
 *      keeps the sections as they were printed, so the claim stays checkable.
 *
 *   2. **The presentation value must agree with the number.** `numeric_text` is what a
 *      certificate prints and `numeric_value` is what arithmetic uses; if they ever disagreed,
 *      the document would say something the data does not. The service writes both from the
 *      same validated token, which makes them equal by construction — this constraint makes
 *      them equal by rule, for anything that writes the column later.
 *
 * Both are additive. No existing row changes: `template_definition` starts NULL (including for
 * the 520 legacy revisions, which never recorded a form), and every `numeric_text` written so
 * far already parses to its own `numeric_value`.
 */

-- ---------- The form as printed -------------------------------------------------------------

ALTER TABLE report_versions
  ADD COLUMN IF NOT EXISTS template_definition jsonb;

COMMENT ON COLUMN report_versions.template_definition IS
  'The template definition as it was at issue. NULL for a draft and for legacy revisions.';

-- ---------- The printed number and the stored number are the same number --------------------

ALTER TABLE test_results
  DROP CONSTRAINT IF EXISTS test_results_numeric_text_matches_value;

ALTER TABLE test_results
  ADD CONSTRAINT test_results_numeric_text_matches_value
  CHECK (
    numeric_text IS NULL
    OR (numeric_value IS NOT NULL AND numeric_text::numeric = numeric_value)
  );

COMMENT ON CONSTRAINT test_results_numeric_text_matches_value ON test_results IS
  'A certificate prints numeric_text; arithmetic uses numeric_value. They may differ in trailing zeros and in nothing else.';

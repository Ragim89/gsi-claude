-- ---------------------------------------------------------------------------------------
-- 027. Organization-level branding (PHASE 13.5 — white-label core).
--
-- Everything a document or the web app prints about "who this system belongs to" was either
-- hardcoded (the wordmark, the alt text, "GSI'nin yazılı izni" in the Turkish disclaimer) or
-- read from `organizations.name` / `legal_name`, which migration 007 seeded once with GSI's own
-- values and which every other deployment would otherwise inherit unchanged. Neither lets a
-- second inspection company run this same core with its own name, colours and logo.
--
-- Additive only, per docs/AI_EXECUTION_RULES.md: new nullable columns, no rewrite of the row
-- migration 007 inserted. NULL means "no override" — the application falls back to the same
-- built-in defaults it used before this migration existed, so an existing deployment that never
-- sets these columns looks exactly as it did. The one exception is the pre-existing GSI row
-- itself: it is backfilled below with the values that were, until now, hardcoded in
-- packages/ui-kit and the PDF templates, so recording them here changes nothing visible.
-- ---------------------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN short_name     text,  -- e.g. 'GSI' — short form used where space is tight (labels, PWA short_name)
  ADD COLUMN product_name   text,  -- e.g. 'GSI ONE' — the product's own name, distinct from the company name
  ADD COLUMN primary_color  text CHECK (primary_color  IS NULL OR primary_color  ~ '^#[0-9A-Fa-f]{6}$'),
  ADD COLUMN secondary_color text CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Local file path or URL the PDF/web layers resolve; NULL keeps the bundled ui-kit asset.
  ADD COLUMN logo_url       text,
  ADD COLUMN logo_light_url text,
  ADD COLUMN support_email  text,
  ADD COLUMN support_phone  text;

COMMENT ON COLUMN organizations.short_name      IS 'Short display form, e.g. PWA short_name and print labels. NULL falls back to code.';
COMMENT ON COLUMN organizations.product_name    IS 'Name of the product itself (may differ from the company name). NULL falls back to name.';
COMMENT ON COLUMN organizations.primary_color   IS 'Brand primary colour (#rrggbb). NULL falls back to the built-in default palette.';
COMMENT ON COLUMN organizations.secondary_color IS 'Brand secondary/accent colour (#rrggbb). NULL falls back to the built-in default palette.';
COMMENT ON COLUMN organizations.logo_url        IS 'Logo for light/white surfaces. NULL falls back to the bundled ui-kit asset.';
COMMENT ON COLUMN organizations.logo_light_url  IS 'Logo (or white lockup) for dark surfaces. NULL falls back to the bundled ui-kit asset.';

-- Backfill only the row migration 007 created, with the values already hardcoded elsewhere in
-- the codebase today. logo_url / logo_light_url are left NULL: the bundled ui-kit asset already
-- is GSI's own logo, so "no override" already renders the correct file.
UPDATE organizations
SET short_name = 'GSI', product_name = 'GSI ONE', primary_color = '#105098', secondary_color = '#5888C0'
WHERE code = 'GSI' AND short_name IS NULL;

-- The login screen and the PWA shell need the brand before anyone has signed in, and
-- `organizations_read` (migration 007) requires app_role() IS NOT NULL. The same problem the
-- report-verification endpoint already solved (public_verify_report, public_verify_document):
-- a narrow, read-only, SECURITY DEFINER function exposing only what is safe with no session.
CREATE FUNCTION public_org_brand()
RETURNS TABLE (
  name text, short_name text, product_name text, primary_color text, secondary_color text,
  logo_url text, logo_light_url text, support_email text, support_phone text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.name, o.short_name, o.product_name, o.primary_color, o.secondary_color,
         o.logo_url, o.logo_light_url, o.support_email, o.support_phone
  FROM organizations o ORDER BY o.code LIMIT 1
$$;

REVOKE ALL ON FUNCTION public_org_brand() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_org_brand() TO gsi_app;

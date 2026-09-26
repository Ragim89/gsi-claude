#!/usr/bin/env node
/**
 * One-time production bootstrap: the first country, office, administrator — and, since
 * PHASE 13.5, the organization's own branding (docs/WHITE_LABEL.md).
 *
 * A fresh production database has exactly one row after migrations run: the `organizations`
 * row inserted by migration 007, with GSI's own name and (since migration 027) GSI's own
 * branding backfilled onto it. SEED_ON_START is deliberately off in production
 * (docker-compose.prod.yml, docs/DEPLOYMENT.md) — seed.ts's demo data (branches, demo users,
 * sample clients) is a development/staging convenience, never something a real deployment's
 * first login should depend on. But opening an office has no REST endpoint of its own yet
 * (see the comment in apps/api/test/rbac.spec.ts) and creating a user needs an authenticated
 * admin to call `POST /api/users` — a chicken-and-egg problem this script exists to break,
 * once, by hand.
 *
 * A deployment for a different inspection company overrides that row's branding here, either
 * from its own client profile (CLIENT_PROFILE=acme reads config/clients/acme/brand.json) or from
 * ORG_* env vars directly, which always win over the profile. Every ORG_* field is optional —
 * anything left unset keeps whatever the row already has (COALESCE, not overwrite-with-null).
 *
 * Everything it does after this script has run is available through the ordinary API:
 * `POST /api/org/countries` for further countries, `POST /api/users` plus
 * `PUT /api/admin/users/:id/roles` for further users, and (once one exists) the "Roles and
 * permissions" screen for anything else.
 *
 * Usage (see docs/DEPLOYMENT.md for the full docker command):
 *   DATABASE_OWNER_URL=postgres://... \
 *   COUNTRY_CODE=TR COUNTRY_NAME=Türkiye \
 *   BRANCH_CODE=TR BRANCH_CITY=Istanbul BRANCH_CURRENCY=TRY BRANCH_LOCALE=tr \
 *   BRANCH_TIMEZONE=Europe/Istanbul BRANCH_LEGAL_NAME="GSI Türkiye" \
 *   ADMIN_EMAIL=admin@example.com ADMIN_NAME="First Admin" ADMIN_PASSWORD='...' \
 *   CLIENT_PROFILE=gsi \
 *   node bootstrap-admin.mjs
 *
 * Safe to run more than once: every insert is idempotent (ON CONFLICT DO NOTHING / UPDATE),
 * so re-running with the same codes touches nothing that already exists.
 */
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** config/clients/<profile>/brand.json, or {} if there is no such profile / field. */
function loadProfileBrand() {
  const profile = process.env.CLIENT_PROFILE?.trim();
  if (!profile) return {};
  const path = join(root, 'config', 'clients', profile, 'brand.json');
  if (!existsSync(path)) return {};
  const { _comment: _c, ...brand } = JSON.parse(readFileSync(path, 'utf8'));
  return brand;
}

const profileBrand = loadProfileBrand();
const orgBrand = {
  shortName: process.env.ORG_SHORT_NAME ?? profileBrand.shortName ?? null,
  productName: process.env.ORG_PRODUCT_NAME ?? profileBrand.productName ?? null,
  primaryColor: process.env.ORG_PRIMARY_COLOR ?? profileBrand.primaryColor ?? null,
  secondaryColor: process.env.ORG_SECONDARY_COLOR ?? profileBrand.secondaryColor ?? null,
  logoUrl: process.env.ORG_LOGO_URL ?? profileBrand.logoUrl ?? null,
  logoLightUrl: process.env.ORG_LOGO_LIGHT_URL ?? profileBrand.logoLightUrl ?? null,
  supportEmail: process.env.ORG_SUPPORT_EMAIL ?? profileBrand.supportEmail ?? null,
  supportPhone: process.env.ORG_SUPPORT_PHONE ?? profileBrand.supportPhone ?? null,
};

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v.trim();
}

const env = {
  databaseOwnerUrl: required('DATABASE_OWNER_URL'),
  countryCode: required('COUNTRY_CODE').toUpperCase(),
  countryName: required('COUNTRY_NAME'),
  branchCode: required('BRANCH_CODE').toUpperCase(),
  branchCity: required('BRANCH_CITY'),
  branchCurrency: required('BRANCH_CURRENCY').toUpperCase(),
  branchLocale: process.env.BRANCH_LOCALE?.trim() || 'en',
  branchTimezone: process.env.BRANCH_TIMEZONE?.trim() || 'UTC',
  branchLegalName: required('BRANCH_LEGAL_NAME'),
  adminEmail: required('ADMIN_EMAIL').toLowerCase(),
  adminName: required('ADMIN_NAME'),
  adminPassword: required('ADMIN_PASSWORD'),
};

if (env.adminPassword.length < 8) {
  console.error('ADMIN_PASSWORD must be at least 8 characters (the same rule apps/api/src/admin/admin.controllers.ts enforces for every other user)');
  process.exit(1);
}

async function main() {
  const client = new pg.Client({ connectionString: env.databaseOwnerUrl });
  await client.connect();
  try {
    await client.query('BEGIN');

    const org = await client.query('SELECT id FROM organizations ORDER BY code LIMIT 1');
    if (!org.rows[0]) {
      throw new Error('No organization row found — did migrations run? (MIGRATE_ON_START, migration 007)');
    }
    const orgId = org.rows[0].id;

    await client.query(
      `UPDATE organizations SET
         short_name = COALESCE($2, short_name), product_name = COALESCE($3, product_name),
         primary_color = COALESCE($4, primary_color), secondary_color = COALESCE($5, secondary_color),
         logo_url = COALESCE($6, logo_url), logo_light_url = COALESCE($7, logo_light_url),
         support_email = COALESCE($8, support_email), support_phone = COALESCE($9, support_phone)
       WHERE id = $1`,
      [
        orgId, orgBrand.shortName, orgBrand.productName, orgBrand.primaryColor, orgBrand.secondaryColor,
        orgBrand.logoUrl, orgBrand.logoLightUrl, orgBrand.supportEmail, orgBrand.supportPhone,
      ],
    );
    if (Object.values(orgBrand).some((v) => v !== null)) {
      console.log(`organization branding updated (${Object.entries(orgBrand).filter(([, v]) => v !== null).map(([k]) => k).join(', ')})`);
    }

    const country = await client.query(
      `INSERT INTO countries (organization_id, code, name, locale, timezone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, env.countryCode, env.countryName, env.branchLocale, env.branchTimezone],
    );
    const countryId = country.rows[0].id;
    console.log(`country ${env.countryCode} — ${env.countryName} (${countryId})`);

    const branch = await client.query(
      `INSERT INTO branches (country_id, code, country, city, currency, locale, ui_locales, timezone, legal_name)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$6]::text[], $7, $8)
       ON CONFLICT (code) DO UPDATE SET city = EXCLUDED.city
       RETURNING id`,
      [
        countryId,
        env.branchCode,
        env.countryCode,
        env.branchCity,
        env.branchCurrency,
        env.branchLocale,
        env.branchTimezone,
        env.branchLegalName,
      ],
    );
    const branchId = branch.rows[0].id;
    console.log(`branch ${env.branchCode} — ${env.branchCity} (${branchId})`);

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [env.adminEmail]);
    let userId = existing.rows[0]?.id;
    if (userId) {
      console.log(`user ${env.adminEmail} already exists (${userId}) — leaving password and role untouched`);
    } else {
      const hash = await bcrypt.hash(env.adminPassword, 10);
      const user = await client.query(
        `INSERT INTO users (branch_id, email, password_hash, full_name, role, locale)
         VALUES ($1, $2, $3, $4, 'admin', $5) RETURNING id`,
        [branchId, env.adminEmail, hash, env.adminName, env.branchLocale],
      );
      userId = user.rows[0].id;
      console.log(`admin user ${env.adminEmail} (${userId})`);

      await client.query(
        `INSERT INTO user_roles (user_id, role_code, granted_by)
         SELECT $1, r.code, $1 FROM roles r
         WHERE r.legacy_role = 'admin'::user_role
           AND r.sort_order = (SELECT min(r2.sort_order) FROM roles r2 WHERE r2.legacy_role = 'admin'::user_role)
         ON CONFLICT DO NOTHING`,
        [userId],
      );
    }

    await client.query('COMMIT');
    console.log('\nBootstrap complete. Sign in and change the password from the profile screen; from');
    console.log('here everything else — more countries, offices, users, roles — goes through the API.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Applies a client profile (config/clients/<profile>/) to the web app before dev/build, so the
 * PWA name/icons/theme colour come from configuration rather than being hardcoded in the core
 * (PHASE 13.5, docs/WHITE_LABEL.md). Runs automatically as apps/web's `predev`/`prebuild`.
 *
 * CLIENT_PROFILE selects the profile directory; it defaults to 'gsi' so an unmodified checkout
 * builds byte-for-byte the same manifest.webmanifest and index.html title it always has.
 *
 * Two files are generated:
 *   - apps/web/public/manifest.webmanifest, from the profile's manifest.json plus the fields
 *     every profile shares (start_url, scope, display, lang, dir — these are not brand, they
 *     describe how the app itself runs and changing them per client would not be "white-label").
 *   - apps/web/.env (gitignored — apps/web/.gitignore already ignores .env), from the profile's
 *     web.env, read by Vite's own %VITE_*% interpolation in apps/web/index.html.
 *
 * A profile that ships neither file (or omits a field) simply keeps whatever is already on disk
 * — this script only overwrites what the profile actually provides.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = process.env.CLIENT_PROFILE?.trim() || 'gsi';
const profileDir = join(root, 'config', 'clients', profile);

if (!existsSync(profileDir)) {
  console.error(`No client profile at config/clients/${profile}/ (set CLIENT_PROFILE to an existing one)`);
  process.exit(1);
}

const webDir = join(root, 'apps', 'web');

// ---- manifest.webmanifest ---------------------------------------------------------------
const manifestFragmentPath = join(profileDir, 'manifest.json');
if (existsSync(manifestFragmentPath)) {
  const brand = JSON.parse(readFileSync(manifestFragmentPath, 'utf8'));
  const manifest = {
    name: brand.name,
    short_name: brand.short_name,
    description: brand.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: brand.background_color,
    theme_color: brand.theme_color,
    orientation: 'any',
    lang: brand.lang ?? 'en',
    dir: brand.dir ?? 'ltr',
    icons: brand.icons,
  };
  writeFileSync(join(webDir, 'public', 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[apply-client-profile] wrote apps/web/public/manifest.webmanifest from ${profile}`);
}

// ---- apps/web/.env (Vite %VITE_*% placeholders in index.html) ---------------------------
const webEnvPath = join(profileDir, 'web.env');
if (existsSync(webEnvPath)) {
  writeFileSync(join(webDir, '.env'), readFileSync(webEnvPath, 'utf8'));
  console.log(`[apply-client-profile] wrote apps/web/.env from ${profile}`);
}

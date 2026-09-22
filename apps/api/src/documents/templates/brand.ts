import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * The official logo files for printed documents, inlined as data URIs (Chromium renders the
 * letterhead with no network access). Same files the web app uses — packages/ui-kit/src/assets —
 * resolved through the workspace package so the path survives the Docker build.
 *
 * ASSUMPTION: only raster logos were supplied; an SVG would print sharper at A4.
 */
const cache = new Map<string, string>();

export function logoDataUri(file: 'logo-wordmark.png' | 'logo-globe.webp' | 'logo-stacked.png'): string {
  const cached = cache.get(file);
  if (cached) return cached;

  const pkg = dirname(require.resolve('@gsi/ui-kit/package.json'));
  const bytes = readFileSync(join(pkg, 'src', 'assets', file));
  const mime = file.endsWith('.webp') ? 'image/webp' : 'image/png';
  const uri = `data:${mime};base64,${bytes.toString('base64')}`;
  cache.set(file, uri);
  return uri;
}

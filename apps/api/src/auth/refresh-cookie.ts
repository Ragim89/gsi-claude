import type { Request, Response } from 'express';
import { config } from '../config';

/** Name and path of the httpOnly cookie that carries the refresh token (PHASE 12). Scoped to
 *  /api/auth so it is never sent on the ordinary API calls that already carry the bearer
 *  access token. */
export const REFRESH_COOKIE = 'gsi_rt';
const COOKIE_PATH = '/api/auth';

export function setRefreshCookie(res: Response, token: string, ttlSeconds: number): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: ttlSeconds * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

/** No cookie-parser middleware is installed (this is the only place a cookie is read), so the
 *  `Cookie` header is parsed by hand. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === REFRESH_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

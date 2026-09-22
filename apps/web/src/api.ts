import type { AuthTokens } from '@gsi/shared-types';

const SESSION_KEY = 'gsi.session';

// ASSUMPTION: tokens live in localStorage for MVP-1 simplicity. Moving the refresh token to an
// httpOnly cookie is planned hardening before production.
let session: AuthTokens | null = loadSession();
const listeners = new Set<(s: AuthTokens | null) => void>();

function loadSession(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as AuthTokens) : null;
  } catch {
    return null;
  }
}

export function getSession() {
  return session;
}

export function setSession(next: AuthTokens | null) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(next));
}

export function onSessionChange(fn: (s: AuthTokens | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    const token = session?.refreshToken;
    refreshing = (async () => {
      if (!token) return false;
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) return false;
      setSession((await res.json()) as AuthTokens);
      return true;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (session) headers.set('Authorization', `Bearer ${session.accessToken}`);
  const res = await fetch(`/api${path}`, { ...init, headers });

  if (res.status === 401 && retry && session) {
    if (await refreshOnce()) return request(path, init, false);
    setSession(null);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.message) ? body.message.join('; ') : body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

function json(body: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const api = {
  get: <T>(path: string) => request(path).then((r) => r.json() as Promise<T>),
  post: <T>(path: string, body?: unknown) =>
    request(path, { method: 'POST', ...json(body ?? {}) }).then((r) => r.json() as Promise<T>),
  patch: <T>(path: string, body: unknown) =>
    request(path, { method: 'PATCH', ...json(body) }).then((r) => r.json() as Promise<T>),
  del: (path: string) => request(path, { method: 'DELETE' }).then(() => undefined),
  upload: <T>(path: string, form: FormData) =>
    request(path, { method: 'POST', body: form }).then((r) => r.json() as Promise<T>),
  blob: (path: string) => request(path).then((r) => r.blob()),
};

/** Replaces empty strings with null so optional fields are cleared rather than failing validation. */
export function blanksToNull<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
  return out as T;
}

export async function downloadFile(path: string, filename: string) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens a PDF from an authenticated endpoint in a new tab. */
export async function openPdf(path: string) {
  const win = window.open('', '_blank'); // opened synchronously to avoid popup blockers
  try {
    const blob = await api.blob(path);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch (err) {
    win?.close();
    throw err;
  }
}

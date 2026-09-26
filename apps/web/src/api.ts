import type { AuthTokens } from '@gsi/shared-types';

const SESSION_KEY = 'gsi.session';

// The access token and user profile live in localStorage for convenience (they carry nothing
// that reading localStorage from a different origin, or from a report bug, would leak beyond
// what the API already hands back on every request). The refresh token itself is never here:
// it travels only as an httpOnly cookie the browser sends to /api/auth/* on its own (PHASE 12).
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
    refreshing = (async () => {
      if (!session) return false;
      // No body: the refresh token is the httpOnly cookie the browser attaches on its own.
      const res = await fetch('/api/auth/refresh', { method: 'POST' });
      if (!res.ok) return false;
      setSession((await res.json()) as AuthTokens);
      return true;
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Best-effort: tells the server to revoke the refresh cookie. Local session is cleared either way. */
export function apiLogout(): Promise<void> {
  return fetch('/api/auth/logout', { method: 'POST' }).then(
    () => undefined,
    () => undefined,
  );
}

export function apiLogoutAll(): Promise<{ revoked: number }> {
  return api.post<{ revoked: number }>('/auth/logout-all');
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
  put: <T>(path: string, body: unknown) =>
    request(path, { method: 'PUT', ...json(body) }).then((r) => r.json() as Promise<T>),
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

/** Shared by every SSE consumer: EventSource cannot send an Authorization header, so each stream is read from a fetch response instead. */
function subscribeStream(path: string, onEvent: (e: unknown) => void): () => void {
  const ctrl = new AbortController();
  void (async () => {
    while (!ctrl.signal.aborted) {
      try {
        const res = await request(path, {
          headers: { Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!ctrl.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()));
            } catch {
              /* keep-alive or partial frame */
            }
          }
        }
      } catch {
        /* dropped connection, token refresh, server restart */
      }
      if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 5000));
    }
  })();
  return () => ctrl.abort();
}

/** Live finance feed (SSE). */
export function subscribeFinance(onEvent: (e: unknown) => void): () => void {
  return subscribeStream('/finance/stream', onEvent);
}

/** Live notification feed (SSE): each event is a signal to refetch the list, not the payload itself. */
export function subscribeNotifications(onEvent: (e: unknown) => void): () => void {
  return subscribeStream('/notifications/stream', onEvent);
}

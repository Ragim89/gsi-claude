import { ChecklistResult, InspectionChecklist } from '@gsi/shared-types';
import { api, ApiError } from '../api';
import { allForUser, isIndexedDbAvailable, put, remove } from './db';

export type OfflineOpKind = 'checklist-answers' | 'checklist-photo' | 'sample-draft' | 'lab-result-draft';
export type OfflineOpStatus = 'queued' | 'syncing' | 'failed' | 'conflict';

export interface ChecklistAnswersPayload {
  inspectionId: string;
  answers: Array<{ itemId: string; result?: ChecklistResult | null; value?: string | null; notes?: string | null }>;
}

export interface ChecklistPhotoPayload {
  inspectionId: string;
  itemId: string;
  category: string;
  takenAt: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracyM?: number;
}

export interface SampleDraftPayload {
  tempId: string;
  body: Record<string, unknown>;
}

export interface LabResultDraftPayload {
  requestId: string;
  version: number | null;
  body: Record<string, unknown>;
}

export type OfflinePayload =
  | ({ kind: 'checklist-answers' } & ChecklistAnswersPayload)
  | ({ kind: 'checklist-photo' } & ChecklistPhotoPayload)
  | ({ kind: 'sample-draft' } & SampleDraftPayload)
  | ({ kind: 'lab-result-draft' } & LabResultDraftPayload);

export interface OfflineOp {
  id: string;
  userId: string;
  kind: OfflineOpKind;
  status: OfflineOpStatus;
  createdAt: number;
  attempt: number;
  nextAttemptAt: number;
  lastError?: string;
  payload: OfflinePayload;
}

type Listener = (ops: OfflineOp[]) => void;
type SyncedListener = (op: OfflineOp, result: unknown) => void;

const listeners = new Set<Listener>();
const syncedListeners = new Set<SyncedListener>();
let activeUserId: string | null = null;
let cache: OfflineOp[] = [];
let syncing = false;
let onlineBound = false;

function notify() {
  const mine = activeUserId ? cache.filter((o) => o.userId === activeUserId) : [];
  listeners.forEach((fn) => fn(mine));
}

async function reload() {
  if (!isIndexedDbAvailable() || !activeUserId) {
    cache = [];
    notify();
    return;
  }
  cache = await allForUser<OfflineOp>(activeUserId);
  notify();
}

/** Switches which user's queue the engine reads and syncs. Never touches another user's rows — that is how a shared device keeps one inspector's queued work invisible to the next. */
export function setActiveUser(userId: string | null) {
  activeUserId = userId;
  void reload();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(activeUserId ? cache.filter((o) => o.userId === activeUserId) : []);
  return () => listeners.delete(fn);
}

/** Fired once per op that reaches the server. Screens use it to invalidate their own queries instead of the engine knowing about react-query. */
export function onSynced(fn: SyncedListener): () => void {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}

export function pendingCount(userId: string): number {
  return cache.filter((o) => o.userId === userId && o.status !== 'conflict').length;
}

function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

async function enqueue(userId: string, payload: OfflinePayload): Promise<OfflineOp> {
  const op: OfflineOp = {
    id: crypto.randomUUID(),
    userId,
    kind: payload.kind,
    status: 'queued',
    createdAt: Date.now(),
    attempt: 0,
    nextAttemptAt: 0,
    payload,
  };
  await put(op);
  if (userId === activeUserId) {
    cache = [...cache, op];
    notify();
  }
  void kick();
  return op;
}

export const offlineQueue = {
  queueChecklistAnswers: (userId: string, payload: ChecklistAnswersPayload) =>
    enqueue(userId, { kind: 'checklist-answers', ...payload }),
  queueChecklistPhoto: (userId: string, payload: ChecklistPhotoPayload) =>
    enqueue(userId, { kind: 'checklist-photo', ...payload }),
  queueSampleDraft: (userId: string, payload: SampleDraftPayload) =>
    enqueue(userId, { kind: 'sample-draft', ...payload }),
  queueLabResultDraft: (userId: string, payload: LabResultDraftPayload) =>
    enqueue(userId, { kind: 'lab-result-draft', ...payload }),
};

/** A conflict is left for the person to resolve, not retried or silently discarded. */
export async function discardOp(id: string) {
  await remove(id);
  cache = cache.filter((o) => o.id !== id);
  notify();
}

async function runOne(op: OfflineOp): Promise<void> {
  try {
    let result: unknown;
    switch (op.payload.kind) {
      case 'checklist-answers':
        result = await api.patch<InspectionChecklist>(`/inspections/${op.payload.inspectionId}/checklist`, {
          answers: op.payload.answers,
        });
        break;
      case 'checklist-photo': {
        const form = new FormData();
        form.append('file', op.payload.blob, op.payload.fileName);
        form.append('checklistItemId', op.payload.itemId);
        form.append('category', op.payload.category);
        form.append('takenAt', op.payload.takenAt);
        if (op.payload.gpsLat != null) form.append('gpsLat', String(op.payload.gpsLat));
        if (op.payload.gpsLng != null) form.append('gpsLng', String(op.payload.gpsLng));
        if (op.payload.gpsAccuracyM != null) form.append('gpsAccuracyM', String(op.payload.gpsAccuracyM));
        result = await api.upload(`/inspections/${op.payload.inspectionId}/photos`, form);
        break;
      }
      case 'sample-draft':
        result = await api.post(`/samples`, op.payload.body);
        break;
      case 'lab-result-draft':
        result = await api.patch(`/lab/requests/${op.payload.requestId}/result`, {
          ...op.payload.body,
          version: op.payload.version,
        });
        break;
    }
    await remove(op.id);
    cache = cache.filter((o) => o.id !== op.id);
    notify();
    syncedListeners.forEach((fn) => fn(op, result));
  } catch (err) {
    const conflict = err instanceof ApiError && err.status === 409;
    const clientError = err instanceof ApiError && err.status < 500 && err.status !== 409 && err.status !== 401;
    const next: OfflineOp = {
      ...op,
      attempt: op.attempt + 1,
      status: conflict ? 'conflict' : 'failed',
      nextAttemptAt: conflict || clientError ? Number.MAX_SAFE_INTEGER : Date.now() + backoffMs(op.attempt + 1),
      lastError: err instanceof Error ? err.message : String(err),
    };
    await put(next);
    cache = cache.map((o) => (o.id === op.id ? next : o));
    notify();
    // A network drop stops the whole run: retrying the rest in order would just fail the same
    // way and burn the phone's radio. Everything after this op waits for the next `online`/timer tick.
    if (!conflict && !clientError) throw err;
  }
}

async function kick() {
  if (syncing || !activeUserId) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  syncing = true;
  try {
    const due = cache
      .filter((o) => o.userId === activeUserId && o.status !== 'conflict' && o.nextAttemptAt <= Date.now())
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const op of due) {
      const current = cache.find((o) => o.id === op.id);
      if (!current) continue;
      cache = cache.map((o) => (o.id === op.id ? { ...o, status: 'syncing' } : o));
      notify();
      try {
        await runOne(cache.find((o) => o.id === op.id)!);
      } catch {
        break; // network-level failure: stop this pass, the retry timer will try again
      }
    }
  } finally {
    syncing = false;
  }
}

let retryTimer: ReturnType<typeof setInterval> | null = null;

/** Registers the `online` listener and a slow poller for the backoff clock. Call once at app start. */
export function initOfflineSync() {
  if (onlineBound || typeof window === 'undefined') return;
  onlineBound = true;
  window.addEventListener('online', () => void kick());
  retryTimer = setInterval(() => void kick(), 20_000);
}

export function stopOfflineSync() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  onlineBound = false;
}

export function syncNow() {
  return kick();
}

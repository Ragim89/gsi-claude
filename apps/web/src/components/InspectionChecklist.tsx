import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState, Field, Input, Segmented, Spinner, TextArea, cx } from '@gsi/ui-kit/react';
import {
  Inspection,
  InspectionChecklist as Checklist,
  InspectionChecklistItem,
  InspectionPhoto,
  localize,
} from '@gsi/shared-types';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { offlineQueue, onSynced } from '../offline/queue';
import { useOffline } from '../offline/OfflineProvider';
import { cacheGet, cacheSet } from '../offline/db';
import { ErrorBox, Loading } from './common';
import { ChecklistProgress } from './InspectionBits';

type Result = 'ok' | 'deviation' | 'na';
type Answer = { result?: Result | null; value?: string | null; notes?: string | null };
type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'queued';

/** A `fetch` that never reached the server (offline, DNS, dropped connection) throws a plain
 * `TypeError`, never an `ApiError` — the server was never asked, so there is no status to read. */
function isNetworkFailure(err: unknown): boolean {
  return !(err instanceof ApiError) && err instanceof Error;
}

/** Long enough that typing a sentence is one request, short enough to feel instant. */
const DEBOUNCE_MS = 800;

/**
 * The field screen.
 *
 * Everything an inspector types is queued and sent as one batch a moment later, so a walk
 * round a hold on a bad connection is a handful of requests rather than hundreds. A failed
 * save keeps its edits and says so — it never pretends the work is safe.
 */
export function InspectionChecklist({ inspection }: { inspection: Inspection }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { isOnline, ops } = useOffline();
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<unknown>(null);

  // Edits waiting to go out, and the values shown while they do.
  const pending = useRef(new Map<string, Answer>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [local, setLocal] = useState<Record<string, Answer>>({});

  const checklist = useQuery({
    queryKey: ['inspection-checklist', inspection.id],
    queryFn: () => api.get<Checklist>(`/inspections/${inspection.id}/checklist`),
  });

  // The last checklist this device actually saw, per user. Reopening the app offline (killed
  // process, dead signal in the warehouse) must show that, not an empty list — the write queue
  // above only covers edits, not the read that has to come before anyone can make one.
  const cacheKey = user ? `checklist:${user.id}:${inspection.id}` : null;
  const [cached, setCached] = useState<Checklist | undefined>(undefined);
  useEffect(() => {
    if (checklist.data && cacheKey) void cacheSet(cacheKey, checklist.data);
  }, [checklist.data, cacheKey]);
  useEffect(() => {
    if (!checklist.data && checklist.isError && cacheKey) {
      void cacheGet<Checklist>(cacheKey).then((c) => c && setCached(c));
    }
  }, [checklist.data, checklist.isError, cacheKey]);
  const offlineData = checklist.data ?? cached;

  // Answers queued in a previous, now-closed session (app killed or reloaded while offline)
  // still live in IndexedDB. They are not in `pending` — that ref is fresh — so without this
  // they would read as unanswered until the queue drains, which is exactly the data loss an
  // offline queue exists to prevent.
  const queuedForThisInspection = useMemo(
    () =>
      ops
        .filter((o) => o.payload.kind === 'checklist-answers' && o.payload.inspectionId === inspection.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [ops, inspection.id],
  );
  useEffect(() => {
    if (!queuedForThisInspection.length) return;
    setLocal((prev) => {
      const merged: Record<string, Answer> = {};
      for (const op of queuedForThisInspection) {
        if (op.payload.kind !== 'checklist-answers') continue;
        for (const { itemId, ...vals } of op.payload.answers) merged[itemId] = { ...merged[itemId], ...vals };
      }
      return { ...merged, ...prev };
    });
    setSaveState((s) => (s === 'idle' || s === 'saved' ? 'queued' : s));
  }, [queuedForThisInspection]);

  useEffect(
    () =>
      onSynced((op) => {
        if (op.payload.kind !== 'checklist-answers' || op.payload.inspectionId !== inspection.id) return;
        qc.invalidateQueries({ queryKey: ['inspection-checklist', inspection.id] });
        qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
      }),
    [inspection.id, qc],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!pending.current.size) return;
    const batch = Array.from(pending.current.entries()).map(([itemId, a]) => ({ itemId, ...a }));

    if (!isOnline) {
      if (user) await offlineQueue.queueChecklistAnswers(user.id, { inspectionId: inspection.id, answers: batch });
      pending.current.clear();
      setSaveError(null);
      setSaveState('queued');
      return;
    }

    setSaveState('saving');
    try {
      const next = await api.patch<Checklist>(`/inspections/${inspection.id}/checklist`, { answers: batch });
      // Only clear what was actually sent: anything typed meanwhile is still owed a save.
      for (const { itemId } of batch) {
        const still = pending.current.get(itemId);
        if (still && sameAnswer(still, batch.find((b) => b.itemId === itemId)!)) pending.current.delete(itemId);
      }
      qc.setQueryData(['inspection-checklist', inspection.id], next);
      qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
      setSaveError(null);
      setSaveState(pending.current.size ? 'idle' : 'saved');
    } catch (err) {
      if (isNetworkFailure(err) && user) {
        await offlineQueue.queueChecklistAnswers(user.id, { inspectionId: inspection.id, answers: batch });
        pending.current.clear();
        setSaveError(null);
        setSaveState('queued');
        return;
      }
      setSaveError(err);
      setSaveState('failed');
    }
  }, [inspection.id, qc, isOnline, user]);

  const queue = useCallback(
    (itemId: string, patch: Answer) => {
      pending.current.set(itemId, { ...pending.current.get(itemId), ...patch });
      setLocal((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
      setSaveState('idle');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  // Leaving the screen, locking the phone or switching apps must not cost the last edit.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
    };
  }, [flush]);

  const data = offlineData;
  const usingCache = !checklist.data && !!cached;
  const items = data?.items ?? [];
  const editable = (data?.editable ?? false) && !inspection.archivedAt;

  // Progress counts the edits that have not reached the server yet, or the bar would jump back.
  const merged = useMemo(() => items.map((it) => ({ ...it, ...(local[it.id] ?? {}) })), [items, local]);
  const answered = merged.filter((i) => i.result).length;
  const requiredLeft = merged.filter((i) => i.isRequired && !i.result).length;

  const sections = useMemo(() => {
    const out = new Map<string, InspectionChecklistItem[]>();
    for (const item of merged) {
      const key = item.section ?? 'general';
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(item);
    }
    return Array.from(out.entries());
  }, [merged]);

  return (
    <Card
      title={t('checklist.title')}
      actions={
        <span className="row-actions">
          <SaveIndicator state={saveState} onRetry={() => void flush()} />
        </span>
      }
    >
      <div className="stack">
        <ChecklistProgress done={answered} total={items.length} required={requiredLeft} />
        {!editable && items.length ? (
          <div className="muted">
            {t('checklist.readOnly', { status: t(`inspectionStatus.${inspection.status}`) })}
          </div>
        ) : null}
        {usingCache && <div className="muted">{t('offline.offline')} — {t('offline.willSyncWhenOnline')}</div>}
        <ErrorBox error={usingCache ? saveError : (checklist.error ?? saveError)} />

        {checklist.isLoading && !usingCache ? (
          <Loading />
        ) : !items.length ? (
          <EmptyState>{t('checklist.empty')}</EmptyState>
        ) : (
          sections.map(([section, list]) => (
            <section key={section} className="stack" style={{ gap: 'var(--gsi-space-3)' }}>
              <h3 className="section-title">{t(`checklistSection.${section}`)}</h3>
              {list.map((item, i) => (
                <ItemCard
                  key={item.id}
                  inspectionId={inspection.id}
                  item={item}
                  index={i + 1}
                  editable={editable}
                  onChange={queue}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </Card>
  );
}

function sameAnswer(a: Answer, b: Answer): boolean {
  return a.result === b.result && a.value === b.value && a.notes === b.notes;
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry(): void }) {
  const { t } = useTranslation();
  if (state === 'queued') return <span className="save-state">{t('offline.queued')}</span>;
  if (state === 'saving') return <span className="save-state">{t('checklist.saving')}</span>;
  if (state === 'saved') return <span className="save-state save-state--ok">{t('checklist.saved')}</span>;
  if (state === 'failed') {
    return (
      <button type="button" className="save-state save-state--failed" onClick={onRetry}>
        {t('checklist.saveFailed')} — {t('common.retry')}
      </button>
    );
  }
  return null;
}

function ItemCard({
  inspectionId,
  item,
  index,
  editable,
  onChange,
}: {
  inspectionId: string;
  item: InspectionChecklistItem;
  index: number;
  editable: boolean;
  onChange(itemId: string, patch: Answer): void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { isOnline, ops } = useOffline();
  const [value, setValue] = useState(item.value ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<unknown>(null);

  const queuedPhotos = ops.filter(
    (o) => o.payload.kind === 'checklist-photo' && o.payload.inspectionId === inspectionId && o.payload.itemId === item.id,
  ).length;

  useEffect(() => setValue(item.value ?? ''), [item.value]);
  useEffect(() => setNotes(item.notes ?? ''), [item.notes]);

  useEffect(
    () =>
      onSynced((op) => {
        if (op.payload.kind !== 'checklist-photo' || op.payload.inspectionId !== inspectionId) return;
        qc.invalidateQueries({ queryKey: ['inspection-checklist', inspectionId] });
        qc.invalidateQueries({ queryKey: ['inspection-photos', inspectionId] });
      }),
    [inspectionId, qc],
  );

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const pos = await currentPosition();
      for (const file of files) {
        const takenAt = new Date(file.lastModified || Date.now()).toISOString();
        const gps = pos
          ? { gpsLat: pos.coords.latitude, gpsLng: pos.coords.longitude, gpsAccuracyM: Math.round(pos.coords.accuracy) }
          : {};
        if (!isOnline) {
          if (user) {
            await offlineQueue.queueChecklistPhoto(user.id, {
              inspectionId,
              itemId: item.id,
              category: 'general',
              takenAt,
              fileName: file.name,
              mimeType: file.type,
              blob: file,
              ...gps,
            });
          }
          continue;
        }
        try {
          const form = new FormData();
          form.append('file', file);
          form.append('checklistItemId', item.id);
          form.append('category', 'general');
          form.append('takenAt', takenAt);
          if (pos) {
            form.append('gpsLat', String(gps.gpsLat));
            form.append('gpsLng', String(gps.gpsLng));
            form.append('gpsAccuracyM', String(gps.gpsAccuracyM));
          }
          await api.upload<InspectionPhoto>(`/inspections/${inspectionId}/photos`, form);
        } catch (err) {
          if (isNetworkFailure(err) && user) {
            await offlineQueue.queueChecklistPhoto(user.id, {
              inspectionId,
              itemId: item.id,
              category: 'general',
              takenAt,
              fileName: file.name,
              mimeType: file.type,
              blob: file,
              ...gps,
            });
          } else throw err;
        }
      }
      qc.invalidateQueries({ queryKey: ['inspection-checklist', inspectionId] });
      qc.invalidateQueries({ queryKey: ['inspection-photos', inspectionId] });
      qc.invalidateQueries({ queryKey: ['inspection', inspectionId] });
    } catch (err) {
      setUploadError(err);
    } finally {
      setUploading(false);
    }
  }

  const commit = (field: 'value' | 'notes', v: string) => {
    const current = (field === 'value' ? item.value : item.notes) ?? '';
    if (v === current) return;
    onChange(item.id, { [field]: v.trim() === '' ? null : v } as Answer);
  };

  return (
    <div className={cx('check-item', item.result === 'deviation' ? 'is-deviation' : item.result ? 'is-done' : null)}>
      <div className="check-item__head">
        <div className="check-item__title">
          <span className="check-item__num">{index}.</span>
          {localize(item.label, i18n.language)}
          {item.isRequired ? <span className="required-dot" title={t('checklist.required')}> *</span> : null}
        </div>
        <Segmented<Result>
          value={item.result}
          disabled={!editable}
          onChange={(r) => onChange(item.id, { result: r })}
          options={[
            { value: 'ok', label: t('result.ok'), tone: 'success' },
            { value: 'deviation', label: t('result.deviation'), tone: 'danger' },
            { value: 'na', label: t('result.na'), tone: 'neutral' },
          ]}
        />
      </div>

      <div className="check-item__fields">
        {item.inputKind !== 'check' ? (
          <Field label={t('checklist.value')}>
            <Input
              inputMode={item.inputKind === 'number' ? 'decimal' : undefined}
              value={value}
              disabled={!editable}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => commit('value', value)}
            />
          </Field>
        ) : (
          <div />
        )}
        <Field label={t('checklist.notes')}>
          <TextArea
            rows={2}
            value={notes}
            disabled={!editable}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => commit('notes', notes)}
          />
        </Field>
      </div>

      <div className="photos">
        {item.media.map((m) => (
          <div key={m.id} className="photo">
            <a href={m.url} target="_blank" rel="noreferrer" title={m.caption ?? ''}>
              <img src={m.previewUrl} alt={m.caption ?? ''} loading="lazy" />
            </a>
          </div>
        ))}
        {editable && (
          <label className="photo-add">
            {uploading ? <Spinner /> : <span>📷<br />{t('checklist.addPhoto')}</span>}
            {/* capture="environment" opens the rear camera on a phone; no native app needed. */}
            <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} disabled={uploading} />
          </label>
        )}
      </div>
      {queuedPhotos > 0 && <div className="muted" style={{ fontSize: 12 }}>{t('offline.photoQueued')}</div>}
      <ErrorBox error={uploadError} />
    </div>
  );
}

/** Best-effort GPS fix for photo metadata; never blocks the upload for long. */
function currentPosition(): Promise<GeolocationPosition | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true,
      timeout: 5000,
      maximumAge: 60_000,
    });
  });
}

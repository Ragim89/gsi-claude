import { ChangeEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState, Field, Input, Segmented, Spinner, TextArea, cx } from '@gsi/ui-kit/react';
import { ChecklistItem, ChecklistResult, InspectionJob, localize, MediaAttachment } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading } from './common';

/** Mirrors ChecklistService.lockEditableJob on the API. */
function canEdit(job: InspectionJob, userId: string | undefined, role: string | undefined): boolean {
  if (role === 'inspector') return job.assignedInspectorId === userId && ['assigned', 'in_progress'].includes(job.status);
  return ['assigned', 'in_progress', 'under_review'].includes(job.status);
}

export function Checklist({ job }: { job: InspectionJob }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const items = useQuery({
    queryKey: ['checklist', job.id],
    queryFn: () => api.get<ChecklistItem[]>(`/jobs/${job.id}/checklist`),
  });
  const editable = canEdit(job, user?.id, user?.role);
  const total = items.data?.length ?? 0;
  const done = items.data?.filter((i) => i.result).length ?? 0;

  return (
    <Card
      title={t('checklist.title')}
      actions={<span className="muted">{t('checklist.progress', { done, total })}</span>}
    >
      <div className="stack">
        <div className="progress">
          <div className="progress__bar" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
        </div>
        {!editable && <div className="muted">{t('checklist.readOnly', { status: t(`status.${job.status}`) })}</div>}
        <ErrorBox error={items.error} />
        {items.isLoading ? (
          <Loading />
        ) : !total ? (
          <EmptyState>{t('checklist.empty')}</EmptyState>
        ) : (
          items.data!.map((item, i) => <ChecklistItemCard key={item.id} job={job} item={item} index={i + 1} editable={editable} />)
        )}
      </div>
    </Card>
  );
}

function ChecklistItemCard({ job, item, index, editable }: { job: InspectionJob; item: ChecklistItem; index: number; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [value, setValue] = useState(item.value ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');

  useEffect(() => {
    setValue(item.value ?? '');
    setNotes(item.notes ?? '');
  }, [item.value, item.notes]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['checklist', job.id] });
    // First edit moves the job assigned → in_progress on the server.
    if (job.status === 'assigned') qc.invalidateQueries({ queryKey: ['job', job.id] });
  };

  const update = useMutation({
    mutationFn: (patch: { result?: ChecklistResult | null; value?: string | null; notes?: string | null }) =>
      api.patch<ChecklistItem>(`/jobs/${job.id}/checklist/${item.id}`, patch),
    onSuccess: refresh,
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const pos = await currentPosition();
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        // ASSUMPTION: capture time = file's lastModified (camera capture ≈ now); EXIF parsing is MVP-2.
        form.append('takenAt', new Date(file.lastModified || Date.now()).toISOString());
        if (pos) {
          form.append('gpsLat', String(pos.coords.latitude));
          form.append('gpsLng', String(pos.coords.longitude));
          form.append('gpsAccuracyM', String(Math.round(pos.coords.accuracy)));
        }
        await api.upload<MediaAttachment>(`/jobs/${job.id}/checklist/${item.id}/media`, form);
      }
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (mediaId: string) => api.del(`/media/${mediaId}`),
    onSuccess: refresh,
  });

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) upload.mutate(files);
  }

  const saveIfChanged = (field: 'value' | 'notes', v: string) => {
    const current = item[field] ?? '';
    if (v === current) return;
    const next = v.trim() === '' ? null : v;
    update.mutate(field === 'value' ? { value: next } : { notes: next });
  };

  return (
    <div className={cx('check-item', item.result === 'deviation' ? 'is-deviation' : item.result ? 'is-done' : null)}>
      <div className="check-item__head">
        <div className="check-item__title">
          <span className="check-item__num">{index}.</span>
          {localize(item.label, i18n.language)}
        </div>
        <div className="row-actions">
          {update.isPending && <span className="save-state">{t('checklist.saving')}</span>}
          <Segmented<ChecklistResult>
            value={item.result}
            disabled={!editable || update.isPending}
            onChange={(r) => update.mutate({ result: r })}
            options={[
              { value: 'ok', label: t('result.ok'), tone: 'success' },
              { value: 'deviation', label: t('result.deviation'), tone: 'danger' },
              { value: 'na', label: t('result.na'), tone: 'neutral' },
            ]}
          />
        </div>
      </div>

      <div className="check-item__fields">
        {item.inputKind !== 'check' ? (
          <Field label={t('checklist.value')}>
            <Input
              inputMode={item.inputKind === 'number' ? 'decimal' : undefined}
              value={value}
              disabled={!editable}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => saveIfChanged('value', value)}
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
            onBlur={() => saveIfChanged('notes', notes)}
          />
        </Field>
      </div>

      <div className="photos">
        {item.media.map((m) => (
          <div key={m.id} className="photo">
            <a href={m.url} target="_blank" rel="noreferrer" title={m.originalName ?? ''}>
              <img src={m.previewUrl} alt={m.originalName ?? ''} loading="lazy" />
            </a>
            {editable && (
              <button
                type="button"
                className="photo__del"
                aria-label={t('checklist.deletePhoto')}
                title={t('checklist.deletePhoto')}
                disabled={remove.isPending}
                onClick={() => remove.mutate(m.id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {editable && (
          <label className="photo-add">
            {upload.isPending ? <Spinner /> : <span>📷<br />{t('checklist.addPhoto')}</span>}
            {/* capture="environment" opens the rear camera on phones/tablets in the field */}
            <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} disabled={upload.isPending} />
          </label>
        )}
      </div>
      <ErrorBox error={update.error ?? upload.error ?? remove.error} />
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

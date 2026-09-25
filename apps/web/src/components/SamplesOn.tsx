import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import {
  Commodity,
  Page,
  SAMPLE_TYPES,
  SAMPLING_METHODS,
  Sample,
  SampleType,
  SamplingMethod,
  localize,
} from '@gsi/shared-types';
import { api, ApiError, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { offlineQueue, onSynced } from '../offline/queue';
import { useOffline } from '../offline/OfflineProvider';
import { SampleStatusBadge, SealBadge } from './SampleBits';
import { ErrorBox, Loading, useFormatDate, useMediaQuery } from './common';

function isNetworkFailure(err: unknown): boolean {
  return !(err instanceof ApiError) && err instanceof Error;
}

/**
 * The samples taken on one inspection, or all the samples on a job.
 *
 * With an inspection it also takes new ones: the form is the short one an inspector fills in
 * standing on a deck, not the full record — the rest is added at the office when it is
 * registered.
 */
export function SamplesOn({
  inspectionId,
  jobId,
  jobStatus,
  locationHint,
}: {
  inspectionId?: string;
  jobId: string;
  jobStatus?: string;
  locationHint?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { can, user } = useAuth();
  const { isOnline, ops } = useOffline();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    sampleType: 'representative' as SampleType,
    samplingMethod: 'manual' as SamplingMethod,
    commodityId: '',
    commodity: '',
    quantity: '',
    unit: 'kg',
    location: locationHint ?? '',
    sealNumber: '',
    containerType: '',
    batchLotNumber: '',
    conditionNotes: '',
  });

  const scope = inspectionId ? `inspectionId=${inspectionId}` : `jobId=${jobId}`;
  const list = useQuery({
    queryKey: [inspectionId ? 'inspection-samples' : 'job-samples', inspectionId ?? jobId],
    queryFn: () => api.get<Page<Sample>>(`/samples?${scope}&limit=100`),
  });

  const commodities = useQuery({
    queryKey: ['commodities'],
    queryFn: () => api.get<Commodity[]>('/reference/commodities'),
    staleTime: 300_000,
    enabled: adding,
  });

  const create = useMutation({
    mutationFn: async (): Promise<{ queued: boolean; sample?: Sample }> => {
      const body: Record<string, unknown> = {
        ...(inspectionId ? { inspectionId } : { jobId }),
        ...blanksToNull({
          sampleType: form.sampleType,
          samplingMethod: form.samplingMethod,
          commodityId: form.commodityId,
          commodity: form.commodity,
          unit: form.unit,
          location: form.location,
          sealNumber: form.sealNumber,
          containerType: form.containerType,
          batchLotNumber: form.batchLotNumber,
          conditionNotes: form.conditionNotes,
        }),
        quantity: form.quantity === '' ? null : Number(form.quantity),
      };
      if (!isOnline) {
        if (user) await offlineQueue.queueSampleDraft(user.id, { tempId: crypto.randomUUID(), body });
        return { queued: true };
      }
      try {
        return { queued: false, sample: await api.post<Sample>('/samples', body) };
      } catch (err) {
        if (isNetworkFailure(err) && user) {
          await offlineQueue.queueSampleDraft(user.id, { tempId: crypto.randomUUID(), body });
          return { queued: true };
        }
        throw err;
      }
    },
    onSuccess: (result) => {
      setAdding(false);
      setForm({ ...form, quantity: '', sealNumber: '', batchLotNumber: '', conditionNotes: '' });
      qc.invalidateQueries({ queryKey: ['inspection-samples'] });
      qc.invalidateQueries({ queryKey: ['job-samples'] });
      qc.invalidateQueries({ queryKey: ['samples'] });
      if (!result.queued && result.sample) navigate(`/samples/${result.sample.id}`);
    },
  });

  const queuedDrafts = ops.filter(
    (o) =>
      o.payload.kind === 'sample-draft' &&
      (inspectionId ? o.payload.body.inspectionId === inspectionId : o.payload.body.jobId === jobId),
  );

  useEffect(() => {
    return onSynced((op) => {
      if (op.payload.kind !== 'sample-draft') return;
      const matches = inspectionId ? op.payload.body.inspectionId === inspectionId : op.payload.body.jobId === jobId;
      if (!matches) return;
      qc.invalidateQueries({ queryKey: ['inspection-samples'] });
      qc.invalidateQueries({ queryKey: ['job-samples'] });
      qc.invalidateQueries({ queryKey: ['samples'] });
    });
  }, [inspectionId, jobId, qc]);

  const rows = list.data?.rows ?? [];
  const canAdd =
    Boolean(inspectionId) && can('sample.create') && !['closed', 'cancelled'].includes(jobStatus ?? '');
  const commodityOf = (s: Sample) =>
    s.commodityName ? localize(s.commodityName, i18n.language) : (s.commodity ?? '—');

  return (
    <Card
      title={t('samples.title')}
      actions={
        canAdd ? (
          <Button variant={adding ? 'ghost' : 'secondary'} onClick={() => setAdding((v) => !v)}>
            {adding ? t('common.cancel') : `+ ${t('samples.new')}`}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={list.error ?? create.error} />

      {adding && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <div className="form-grid">
            <Field label={t('sample.type')}>
              <Select
                value={form.sampleType}
                onChange={(e) => setForm({ ...form, sampleType: e.target.value as SampleType })}
              >
                {SAMPLE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {t(`sampleType.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('sample.method')}>
              <Select
                value={form.samplingMethod}
                onChange={(e) => setForm({ ...form, samplingMethod: e.target.value as SamplingMethod })}
              >
                {SAMPLING_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`samplingMethod.${m}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.commodity')}>
              <Select value={form.commodityId} onChange={(e) => setForm({ ...form, commodityId: e.target.value })}>
                <option value="">{t('sample.commodityFree')}</option>
                {(commodities.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {localize(c.name, i18n.language)}
                  </option>
                ))}
              </Select>
            </Field>
            {!form.commodityId && (
              <Field label={t('sample.commodityText')}>
                <Input value={form.commodity} onChange={(e) => setForm({ ...form, commodity: e.target.value })} />
              </Field>
            )}
            <Field label={t('sample.quantity')}>
              <Input
                type="number"
                step="any"
                inputMode="decimal"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </Field>
            <Field label={t('sample.unit')}>
              <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </Field>
            <Field label={t('jobs.location')}>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </Field>
            <Field label={t('sample.sealNumber')} hint={t('sample.sealLater')}>
              <Input value={form.sealNumber} onChange={(e) => setForm({ ...form, sealNumber: e.target.value })} />
            </Field>
            <Field label={t('sample.container')}>
              <Input value={form.containerType} onChange={(e) => setForm({ ...form, containerType: e.target.value })} />
            </Field>
            <Field label={t('sample.batch')}>
              <Input
                value={form.batchLotNumber}
                onChange={(e) => setForm({ ...form, batchLotNumber: e.target.value })}
              />
            </Field>
            <div className="form-grid__wide">
              <Field label={t('sample.conditionNotes')}>
                <TextArea
                  rows={2}
                  value={form.conditionNotes}
                  onChange={(e) => setForm({ ...form, conditionNotes: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              {t('samples.create')}
            </Button>
            {!isOnline && <span className="muted" style={{ fontSize: 12 }}>{t('offline.sampleDraftQueued')}</span>}
          </div>
        </div>
      )}

      {queuedDrafts.length > 0 && (
        <div className="stack" style={{ gap: 6, marginBlockEnd: 'var(--gsi-space-3)' }}>
          {queuedDrafts.map((op) => (
            <div key={op.id} className="ins-card">
              <div className="ins-card__head">
                <span className="mono">{t('offline.queued')}</span>
                <span className="muted">{t('offline.sampleDraftQueued')}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {list.isLoading ? (
        <Loading />
      ) : !rows.length && !queuedDrafts.length ? (
        <EmptyState>{t('samples.noneHere')}</EmptyState>
      ) : narrow ? (
        <div className="stack">
          {rows.map((s) => (
            <Link key={s.id} to={`/samples/${s.id}`} className="ins-card">
              <div className="ins-card__head">
                <span className="mono">{s.sampleNumber}</span>
                <SampleStatusBadge status={s.status} />
              </div>
              <div className="ins-card__title">{commodityOf(s)}</div>
              <div className="muted">
                {t(`sampleType.${s.sampleType}`)}
                {s.quantity != null ? ` · ${s.quantity} ${s.unit ?? ''}` : ''}
              </div>
              <SealBadge number={s.sealNumber} state={s.sealState} />
            </Link>
          ))}
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('samples.number')}</th>
              <th>{t('sample.type')}</th>
              <th>{t('jobs.commodity')}</th>
              <th>{t('sample.quantity')}</th>
              <th>{t('sample.seal')}</th>
              <th>{t('sample.sampledAt')}</th>
              <th>{t('sample.destination')}</th>
              <th>{t('jobs.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="link-row" onClick={() => navigate(`/samples/${s.id}`)}>
                <td className="mono">
                  <Link to={`/samples/${s.id}`} onClick={(e) => e.stopPropagation()}>
                    {s.sampleNumber}
                  </Link>
                </td>
                <td>{t(`sampleType.${s.sampleType}`)}</td>
                <td>{commodityOf(s)}</td>
                <td className="num">{s.quantity != null ? `${s.quantity} ${s.unit ?? ''}` : '—'}</td>
                <td>
                  <SealBadge number={s.sealNumber} state={s.sealState} />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.sampledAt)}</td>
                <td>{s.destinationLaboratoryName ?? '—'}</td>
                <td>
                  <SampleStatusBadge status={s.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

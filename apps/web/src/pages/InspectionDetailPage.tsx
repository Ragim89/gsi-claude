import { ChangeEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Table, TextArea } from '@gsi/ui-kit/react';
import {
  ASSIGNMENT_ROLES,
  AssignmentRole,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FindingSeverity,
  FindingStatus,
  Inspection,
  InspectionAction,
  InspectionFinding,
  InspectionMeasurement,
  InspectionPhoto,
  InspectionStatusHistoryEntry,
  JobAssignment,
  MEASUREMENT_TYPES,
  PHOTO_CATEGORIES,
  PhotoCategory,
  User,
} from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { InspectionChecklist } from '../components/InspectionChecklist';
import { SamplesOn } from '../components/SamplesOn';
import {
  ActionBar,
  INSPECTION_ACTIONS_NEEDING_REASON,
  InspectionStatusBadge,
  InspectionTimeline,
  SeverityBadge,
} from '../components/InspectionBits';
import { ErrorBox, Loading, PageHead, toLocalInput, fromLocalInput, useFormatDate, useServiceLabel } from '../components/common';

type Tab = 'overview' | 'checklist' | 'findings' | 'measurements' | 'photos' | 'samples' | 'team' | 'history';

/**
 * The inspection card: everything about one piece of field work, and the only place its
 * status changes — through the actions the workflow offers, never a free-form dropdown.
 */
export function InspectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';

  const inspection = useQuery({
    queryKey: ['inspection', id],
    queryFn: () => api.get<Inspection>(`/inspections/${id}`),
  });
  const history = useQuery({
    queryKey: ['inspection-history', id],
    queryFn: () => api.get<InspectionStatusHistoryEntry[]>(`/inspections/${id}/history`),
  });
  const findings = useQuery({
    queryKey: ['inspection-findings', id],
    queryFn: () => api.get<InspectionFinding[]>(`/inspections/${id}/findings`),
  });
  const measurements = useQuery({
    queryKey: ['inspection-measurements', id],
    queryFn: () => api.get<InspectionMeasurement[]>(`/inspections/${id}/measurements`),
  });
  const photos = useQuery({
    queryKey: ['inspection-photos', id],
    queryFn: () => api.get<InspectionPhoto[]>(`/inspections/${id}/photos`),
    enabled: tab === 'photos',
  });
  const assignments = useQuery({
    queryKey: ['inspection-assignments', id],
    queryFn: () => api.get<JobAssignment[]>(`/inspections/${id}/assignments`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inspection', id] });
    qc.invalidateQueries({ queryKey: ['inspection-history', id] });
    qc.invalidateQueries({ queryKey: ['inspection-checklist', id] });
    qc.invalidateQueries({ queryKey: ['inspections'] });
    qc.invalidateQueries({ queryKey: ['job'] });
  };

  const transition = useMutation({
    mutationFn: ({ action, reason }: { action: InspectionAction; reason?: string }) =>
      api.post<Inspection>(`/inspections/${id}/transitions`, { action, reason }),
    onSuccess: refresh,
  });

  if (inspection.isLoading) return <Loading />;
  if (!inspection.data) return <ErrorBox error={inspection.error} />;
  const x = inspection.data;
  const actions = x.actions ?? [];

  function run(action: InspectionAction) {
    if (INSPECTION_ACTIONS_NEEDING_REASON.includes(action)) {
      const reason = window.prompt(t(`inspectionAction.reasonFor.${action}`));
      if (!reason?.trim()) return;
      transition.mutate({ action, reason });
      return;
    }
    if (action === 'complete' && (x.requiredRemaining ?? 0) > 0) {
      window.alert(t('inspection.requiredBlock', { count: x.requiredRemaining }));
      return;
    }
    if (action === 'approve' && !window.confirm(t('inspection.approveConfirm'))) return;
    transition.mutate({ action });
  }

  const tabs: { key: Tab; label: string; show: boolean; count?: number }[] = [
    { key: 'overview', label: t('job.details'), show: true },
    { key: 'checklist', label: t('checklist.title'), show: true, count: x.checklistTotal },
    { key: 'findings', label: t('inspection.findings'), show: true, count: findings.data?.length },
    { key: 'measurements', label: t('inspection.measurements'), show: true, count: measurements.data?.length },
    { key: 'photos', label: t('inspection.photos'), show: true, count: x.photoCount },
    { key: 'samples', label: t('samples.title'), show: can('sample.read') },
    { key: 'team', label: t('job.assignments'), show: true, count: assignments.data?.length },
    { key: 'history', label: t('job.history'), show: true },
  ];

  return (
    <div className="stack has-action-bar">
      <PageHead
        title={x.inspectionNumber}
        sub={
          <>
            {serviceLabel(x.type)} · <Link to={`/jobs/${x.jobId}`}>{x.jobNumber}</Link> · {x.clientName}
          </>
        }
      />

      <div className="job-head">
        <InspectionStatusBadge status={x.status} />
        {x.overdue ? <Badge tone="danger">{t('jobs.overdue')}</Badge> : null}
        {x.statusBeforeHold ? (
          <span className="muted">
            {t('job.heldFrom', { status: t(`inspectionStatus.${x.statusBeforeHold}`) })}
          </span>
        ) : null}
        {(x.requiredRemaining ?? 0) > 0 ? (
          <span className="muted">{t('inspection.requiredRemaining', { count: x.requiredRemaining })}</span>
        ) : null}
      </div>

      {x.status === 'approved' && (
        <Alert tone="success">
          {t('inspection.approvedBy', { name: x.reviewedByName ?? '—', at: fmt(x.reviewedAt) })}
        </Alert>
      )}
      {x.reviewComment && x.status === 'in_progress' && (
        <Alert tone="warning">
          {t('job.reviewComment')}: {x.reviewComment}
        </Alert>
      )}
      <ErrorBox error={transition.error} />

      <nav className="tabs">
        {tabs
          .filter((y) => y.show)
          .map((y) => (
            <button
              key={y.key}
              type="button"
              className={`tab${tab === y.key ? ' tab--on' : ''}`}
              onClick={() => setParams(y.key === 'overview' ? {} : { tab: y.key }, { replace: true })}
            >
              {y.label}
              {y.count ? <span className="tab__count">{y.count}</span> : null}
            </button>
          ))}
      </nav>

      {tab === 'overview' && <Overview inspection={x} onSaved={refresh} />}
      {tab === 'checklist' && <InspectionChecklist inspection={x} />}
      {tab === 'findings' && <Findings inspection={x} findings={findings.data ?? []} loading={findings.isLoading} />}
      {tab === 'measurements' && (
        <Measurements inspection={x} rows={measurements.data ?? []} loading={measurements.isLoading} />
      )}
      {tab === 'photos' && <Photos inspection={x} rows={photos.data ?? []} loading={photos.isLoading} />}
      {tab === 'samples' && (
        <SamplesOn
          inspectionId={x.id}
          jobId={x.jobId}
          jobStatus={x.status === 'cancelled' ? 'cancelled' : undefined}
          locationHint={x.location}
        />
      )}
      {tab === 'team' && <Team inspection={x} rows={assignments.data ?? []} loading={assignments.isLoading} />}
      {tab === 'history' && (
        <Card title={t('job.history')}>
          <ErrorBox error={history.error} />
          {history.isLoading ? (
            <Loading />
          ) : !history.data?.length ? (
            <EmptyState>{t('job.noHistory')}</EmptyState>
          ) : (
            <InspectionTimeline history={history.data} />
          )}
        </Card>
      )}

      {can('inspection.read') && <ActionBar actions={actions} busy={transition.isPending} onRun={run} />}
    </div>
  );
}

/** Details plus the narrative the inspector writes: conditions, observations, conclusion. */
function Overview({ inspection, onSaved }: { inspection: Inspection; onSaved(): void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const editable = ['draft', 'scheduled', 'in_progress'].includes(inspection.status) && can('inspection.update');

  const [form, setForm] = useState({
    location: inspection.location ?? '',
    city: inspection.city ?? '',
    scheduledStart: toLocalInput(inspection.scheduledStart),
    scheduledEnd: toLocalInput(inspection.scheduledEnd),
    weatherConditions: inspection.weatherConditions ?? '',
    siteConditions: inspection.siteConditions ?? '',
    generalObservations: inspection.generalObservations ?? '',
    conclusion: inspection.conclusion ?? '',
    internalNotes: inspection.internalNotes ?? '',
  });

  useEffect(() => {
    setForm({
      location: inspection.location ?? '',
      city: inspection.city ?? '',
      scheduledStart: toLocalInput(inspection.scheduledStart),
      scheduledEnd: toLocalInput(inspection.scheduledEnd),
      weatherConditions: inspection.weatherConditions ?? '',
      siteConditions: inspection.siteConditions ?? '',
      generalObservations: inspection.generalObservations ?? '',
      conclusion: inspection.conclusion ?? '',
      internalNotes: inspection.internalNotes ?? '',
    });
  }, [inspection]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<Inspection>(`/inspections/${inspection.id}`, {
        ...blanksToNull({
          location: form.location,
          city: form.city,
          weatherConditions: form.weatherConditions,
          siteConditions: form.siteConditions,
          generalObservations: form.generalObservations,
          conclusion: form.conclusion,
          internalNotes: form.internalNotes,
        }),
        scheduledStart: fromLocalInput(form.scheduledStart),
        scheduledEnd: fromLocalInput(form.scheduledEnd),
        // The version the form was filled against: the server refuses a save built on a
        // copy someone else has already changed.
        version: inspection.version,
      }),
    onSuccess: onSaved,
  });

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const detail = (label: string, value: React.ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );

  return (
    <div className="stack">
      <Card title={t('job.details')}>
        <dl className="detail-grid">
          {detail(t('inspections.job'), <Link to={`/jobs/${inspection.jobId}`}>{inspection.jobNumber}</Link>)}
          {detail(t('jobs.client'), inspection.clientName)}
          {detail(t('jobs.type'), serviceLabel(inspection.type))}
          {detail(t('common.branch'), inspection.branchCode)}
          {detail(t('jobs.lead'), inspection.leadInspectorName)}
          {detail(t('inspection.actualStart'), fmt(inspection.actualStart))}
          {detail(t('inspection.actualEnd'), fmt(inspection.actualEnd))}
          {detail(t('job.createdBy'), inspection.createdByName)}
          {detail(t('job.createdAt'), fmt(inspection.createdAt))}
          {detail(t('jobs.updated'), fmt(inspection.updatedAt))}
        </dl>
        {inspection.instructions ? (
          <>
            <h3 className="section-title">{t('jobs.instructions')}</h3>
            <p className="prewrap">{inspection.instructions}</p>
          </>
        ) : null}
      </Card>

      <Card
        title={t('inspection.record')}
        actions={
          editable ? (
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          ) : (
            <span className="muted">{t('checklist.readOnly', { status: t(`inspectionStatus.${inspection.status}`) })}</span>
          )
        }
      >
        <ErrorBox error={save.error} />
        <div className="form-grid">
          <Field label={t('jobs.location')}>
            <Input value={form.location} disabled={!editable} onChange={set('location')} />
          </Field>
          <Field label={t('job.city')}>
            <Input value={form.city} disabled={!editable} onChange={set('city')} />
          </Field>
          <Field label={t('inspection.scheduledStart')}>
            <Input type="datetime-local" value={form.scheduledStart} disabled={!editable} onChange={set('scheduledStart')} />
          </Field>
          <Field label={t('inspection.scheduledEnd')}>
            <Input type="datetime-local" value={form.scheduledEnd} disabled={!editable} onChange={set('scheduledEnd')} />
          </Field>
          <Field label={t('inspection.weather')}>
            <Input value={form.weatherConditions} disabled={!editable} onChange={set('weatherConditions')} />
          </Field>
          <Field label={t('inspection.siteConditions')}>
            <Input value={form.siteConditions} disabled={!editable} onChange={set('siteConditions')} />
          </Field>
          <div className="form-grid__wide">
            <Field label={t('inspection.observations')}>
              <TextArea rows={4} value={form.generalObservations} disabled={!editable} onChange={set('generalObservations')} />
            </Field>
          </div>
          <div className="form-grid__wide">
            <Field label={t('inspection.conclusion')}>
              <TextArea rows={3} value={form.conclusion} disabled={!editable} onChange={set('conclusion')} />
            </Field>
          </div>
          <div className="form-grid__wide">
            <Field label={t('inspection.internalNotes')} hint={t('inspection.internalNotesHint')}>
              <TextArea rows={2} value={form.internalNotes} disabled={!editable} onChange={set('internalNotes')} />
            </Field>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Findings({
  inspection,
  findings,
  loading,
}: {
  inspection: Inspection;
  findings: InspectionFinding[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const open = ['draft', 'scheduled', 'in_progress'].includes(inspection.status);
  const [form, setForm] = useState({
    title: '',
    severity: 'minor' as FindingSeverity,
    category: '',
    description: '',
    recommendation: '',
    isInternal: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inspection-findings', inspection.id] });
    qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
  };

  const add = useMutation({
    mutationFn: () => api.post<InspectionFinding>(`/inspections/${inspection.id}/findings`, blanksToNull(form)),
    onSuccess: () => {
      setForm({ title: '', severity: 'minor', category: '', description: '', recommendation: '', isInternal: false });
      refresh();
    },
  });

  const setStatus = useMutation({
    mutationFn: ({ findingId, status }: { findingId: string; status: FindingStatus }) =>
      api.patch<InspectionFinding>(`/inspections/${inspection.id}/findings/${findingId}`, { status }),
    onSuccess: refresh,
  });

  return (
    <Card title={t('inspection.findings')} actions={<span className="muted">{t('inspection.findingsHint')}</span>}>
      <ErrorBox error={add.error ?? setStatus.error} />
      {can('inspection.add_finding') && open && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <div className="form-grid">
            <div className="form-grid__wide">
              <Field label={t('inspection.findingTitle')}>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
            </div>
            <Field label={t('inspection.severity')}>
              <Select
                value={form.severity}
                onChange={(e) => setForm({ ...form, severity: e.target.value as FindingSeverity })}
              >
                {FINDING_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`severity.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('inspection.category')}>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </Field>
            <div className="form-grid__wide">
              <Field label={t('common.description')}>
                <TextArea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>
            <div className="form-grid__wide">
              <Field label={t('inspection.recommendation')}>
                <TextArea
                  rows={2}
                  value={form.recommendation}
                  onChange={(e) => setForm({ ...form, recommendation: e.target.value })}
                />
              </Field>
            </div>
            <div className="form-grid__wide">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.isInternal}
                  onChange={(e) => setForm({ ...form, isInternal: e.target.checked })}
                />
                {t('inspection.internalOnly')}
              </label>
            </div>
          </div>
          <div>
            <Button disabled={form.title.trim().length < 3} loading={add.isPending} onClick={() => add.mutate()}>
              {t('inspection.addFinding')}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !findings.length ? (
        <EmptyState>{t('inspection.noFindings')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('inspection.findingTitle')}</th>
              <th>{t('inspection.severity')}</th>
              <th>{t('jobs.status')}</th>
              <th>{t('job.createdBy')}</th>
              <th>{t('job.createdAt')}</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((f) => (
              <tr key={f.id}>
                <td>
                  <strong>{f.title}</strong>
                  {f.isInternal ? <Badge tone="neutral">{t('inspection.internalOnly')}</Badge> : null}
                  {f.description ? <div className="muted prewrap">{f.description}</div> : null}
                  {f.recommendation ? (
                    <div className="timeline__reason">{t('inspection.recommendation')}: {f.recommendation}</div>
                  ) : null}
                </td>
                <td>
                  <SeverityBadge severity={f.severity} />
                </td>
                <td>
                  {can('inspection.add_finding') ? (
                    <Select
                      value={f.status}
                      onChange={(e) => setStatus.mutate({ findingId: f.id, status: e.target.value as FindingStatus })}
                    >
                      {FINDING_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`findingStatus.${s}`)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    t(`findingStatus.${f.status}`)
                  )}
                </td>
                <td>{f.createdByName ?? '—'}</td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmt(f.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Measurements({
  inspection,
  rows,
  loading,
}: {
  inspection: Inspection;
  rows: InspectionMeasurement[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const open = ['draft', 'scheduled', 'in_progress'].includes(inspection.status);
  const [form, setForm] = useState({
    measurementType: 'temperature',
    label: '',
    valueNumeric: '',
    valueText: '',
    unit: '',
    position: '',
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inspection-measurements', inspection.id] });
    qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.post<InspectionMeasurement>(`/inspections/${inspection.id}/measurements`, {
        ...blanksToNull({
          measurementType: form.measurementType,
          label: form.label,
          valueText: form.valueText,
          unit: form.unit,
          position: form.position,
        }),
        valueNumeric: form.valueNumeric === '' ? null : Number(form.valueNumeric),
      }),
    onSuccess: () => {
      setForm({ ...form, label: '', valueNumeric: '', valueText: '', position: '' });
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (measurementId: string) => api.del(`/inspections/${inspection.id}/measurements/${measurementId}`),
    onSuccess: refresh,
  });

  const hasValue = form.valueNumeric !== '' || form.valueText.trim() !== '';

  return (
    <Card title={t('inspection.measurements')}>
      <ErrorBox error={add.error ?? remove.error} />
      {can('inspection.add_measurement') && open && (
        <div className="filter-row" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Select
            value={form.measurementType}
            onChange={(e) => setForm({ ...form, measurementType: e.target.value })}
          >
            {MEASUREMENT_TYPES.map((m) => (
              <option key={m} value={m}>
                {t(`measurementType.${m}`)}
              </option>
            ))}
          </Select>
          <Input placeholder={t('inspection.measurementLabel')} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            placeholder={t('inspection.value')}
            value={form.valueNumeric}
            onChange={(e) => setForm({ ...form, valueNumeric: e.target.value })}
          />
          <Input placeholder={t('inspection.unit')} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <Input placeholder={t('inspection.position')} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
          <Button disabled={!hasValue} loading={add.isPending} onClick={() => add.mutate()}>
            {t('inspection.addMeasurement')}
          </Button>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('inspection.noMeasurements')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('inspection.measurementType')}</th>
              <th>{t('inspection.value')}</th>
              <th>{t('inspection.position')}</th>
              <th>{t('inspection.measuredBy')}</th>
              <th>{t('inspection.measuredAt')}</th>
              {can('inspection.add_measurement') && open && <th style={{ width: 100 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  {t(`measurementType.${m.measurementType}`, { defaultValue: m.measurementType })}
                  {m.label ? <div className="muted">{m.label}</div> : null}
                </td>
                <td className="num">
                  {m.valueNumeric != null ? m.valueNumeric.toLocaleString() : m.valueText}
                  {m.unit ? ` ${m.unit}` : ''}
                </td>
                <td>{m.position ?? '—'}</td>
                <td>{m.measuredByName ?? '—'}</td>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmt(m.measuredAt)}</td>
                {can('inspection.add_measurement') && open && (
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>
                      {t('common.delete')}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Photos({ inspection, rows, loading }: { inspection: Inspection; rows: InspectionPhoto[]; loading: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const open = ['draft', 'scheduled', 'in_progress'].includes(inspection.status);
  const [category, setCategory] = useState<PhotoCategory>('general');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.append('file', file);
        form.append('category', category);
        if (caption.trim()) form.append('caption', caption.trim());
        form.append('takenAt', new Date(file.lastModified || Date.now()).toISOString());
        await api.upload<InspectionPhoto>(`/inspections/${inspection.id}/photos`, form);
      }
      setCaption('');
      qc.invalidateQueries({ queryKey: ['inspection-photos', inspection.id] });
      qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const groups = PHOTO_CATEGORIES.map((c) => [c, rows.filter((p) => p.category === c)] as const).filter(
    ([, list]) => list.length,
  );

  return (
    <Card title={t('inspection.photos')}>
      <ErrorBox error={error} />
      {can('media.upload') && open && (
        <div className="filter-row" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Select value={category} onChange={(e) => setCategory(e.target.value as PhotoCategory)}>
            {PHOTO_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`photoCategory.${c}`)}
              </option>
            ))}
          </Select>
          <Input placeholder={t('inspection.caption')} value={caption} onChange={(e) => setCaption(e.target.value)} />
          <label className="photo-add photo-add--inline">
            {busy ? <Spinner /> : <span>📷 {t('checklist.addPhoto')}</span>}
            <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} disabled={busy} />
          </label>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('inspection.noPhotos')}</EmptyState>
      ) : (
        groups.map(([c, list]) => (
          <div key={c} className="stack" style={{ gap: 'var(--gsi-space-2)' }}>
            <h3 className="section-title">
              {t(`photoCategory.${c}`)} ({list.length})
            </h3>
            <div className="photos">
              {list.map((p) => (
                <div key={p.id} className="photo photo--lg">
                  <a href={p.url} target="_blank" rel="noreferrer" title={p.caption ?? p.originalName ?? ''}>
                    <img src={p.previewUrl} alt={p.caption ?? p.originalName ?? ''} loading="lazy" />
                  </a>
                  <div className="photo__cap">
                    {p.caption || fmt(p.takenAt)}
                    {p.gpsLat != null ? ' · GPS' : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Card>
  );
}

function Team({ inspection, rows, loading }: { inspection: Inspection; rows: JobAssignment[]; loading: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<AssignmentRole>('inspector');
  const open = !['approved', 'cancelled'].includes(inspection.status);

  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: can('inspection.assign'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inspection-assignments', inspection.id] });
    qc.invalidateQueries({ queryKey: ['inspection', inspection.id] });
  };

  const assign = useMutation({
    mutationFn: () => api.post<JobAssignment[]>(`/inspections/${inspection.id}/assignments`, { userId, role }),
    onSuccess: () => {
      setUserId('');
      refresh();
    },
  });

  const unassign = useMutation({
    mutationFn: (assignmentId: string) => api.del(`/inspections/${inspection.id}/assignments/${assignmentId}`),
    onSuccess: refresh,
  });

  const assignable = (people.data ?? []).filter(
    (u) => u.branchId === inspection.branchId && u.isActive && !rows.some((a) => a.userId === u.id),
  );

  return (
    <Card title={t('job.assignments')}>
      <ErrorBox error={assign.error ?? unassign.error} />
      {can('inspection.assign') && open && (
        <div className="filter-row" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('job.selectPerson')}</option>
            {assignable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} — {t(`roleNames.${u.role}`)}
              </option>
            ))}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value as AssignmentRole)}>
            {ASSIGNMENT_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`assignmentRole.${r}`)}
              </option>
            ))}
          </Select>
          <Button disabled={!userId} loading={assign.isPending} onClick={() => assign.mutate()}>
            {t('job.assign')}
          </Button>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('job.noAssignments')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('users.fullName')}</th>
              <th>{t('job.assignmentRole')}</th>
              <th>{t('job.assignedAt')}</th>
              {can('inspection.assign') && open && <th style={{ width: 120 }} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.userName}
                  <div className="muted">{a.userEmail}</div>
                </td>
                <td>
                  <Badge tone={a.role === 'lead_inspector' ? 'accent' : 'neutral'}>
                    {t(`assignmentRole.${a.role}`)}
                  </Badge>
                </td>
                <td>{fmt(a.assignedAt)}</td>
                {can('inspection.assign') && open && (
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => unassign.mutate(a.id)}>
                      {t('job.unassign')}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

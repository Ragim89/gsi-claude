import { ChangeEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, TextArea } from '@gsi/ui-kit/react';
import {
  InspectionPhoto,
  Laboratory,
  PHOTO_CATEGORIES,
  PhotoCategory,
  SAMPLE_CONDITIONS,
  SAMPLE_REJECTION_REASONS,
  SEAL_CONDITIONS,
  Sample,
  SampleAction,
  SampleCustodyEvent,
  SampleLabel,
  SampleStatusHistoryEntry,
  User,
  localize,
} from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { LabOnSample } from '../components/LabOn';
import {
  CustodyTimeline,
  SAMPLE_ACTIONS_NEEDING_REASON,
  SAMPLE_ACTIONS_WITH_FORM,
  SampleActionBar,
  SampleStatusBadge,
  SampleTimeline,
  SealBadge,
} from '../components/SampleBits';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

type Tab = 'overview' | 'laboratory' | 'custody' | 'attachments' | 'history';

/** Everything a status move may carry; only the fields the chosen move needs are shown. */
type MoveForm = {
  reason: string;
  notes: string;
  sealNumber: string;
  sealType: string;
  sealState: string;
  condition: string;
  destinationLaboratoryId: string;
  courier: string;
  trackingReference: string;
  packageCount: string;
  rejectionReason: string;
};

const EMPTY_FORM: MoveForm = {
  reason: '',
  notes: '',
  sealNumber: '',
  sealType: '',
  sealState: 'intact',
  condition: 'good',
  destinationLaboratoryId: '',
  courier: '',
  trackingReference: '',
  packageCount: '',
  rejectionReason: 'damaged',
};

/**
 * The sample card: what it is, where it has been, and who had it. The custody tab is the one
 * that matters in a dispute, so it is one click away and never summarised into the status.
 */
export function SampleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [move, setMove] = useState<SampleAction | null>(null);
  const [form, setForm] = useState<MoveForm>(EMPTY_FORM);

  const sample = useQuery({ queryKey: ['sample', id], queryFn: () => api.get<Sample>(`/samples/${id}`) });
  const custody = useQuery({
    queryKey: ['sample-custody', id],
    queryFn: () => api.get<SampleCustodyEvent[]>(`/samples/${id}/custody`),
    enabled: can('sample.read_custody'),
  });
  const history = useQuery({
    queryKey: ['sample-history', id],
    queryFn: () => api.get<SampleStatusHistoryEntry[]>(`/samples/${id}/history`),
  });
  const attachments = useQuery({
    queryKey: ['sample-attachments', id],
    queryFn: () => api.get<InspectionPhoto[]>(`/samples/${id}/attachments`),
  });
  const labs = useQuery({
    queryKey: ['laboratories'],
    queryFn: () => api.get<Laboratory[]>('/samples/laboratories'),
    staleTime: 300_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sample', id] });
    qc.invalidateQueries({ queryKey: ['sample-custody', id] });
    qc.invalidateQueries({ queryKey: ['sample-history', id] });
    qc.invalidateQueries({ queryKey: ['samples'] });
    qc.invalidateQueries({ queryKey: ['job-samples'] });
    qc.invalidateQueries({ queryKey: ['inspection-samples'] });
  };

  const transition = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Sample>(`/samples/${id}/transitions`, body),
    onSuccess: () => {
      setMove(null);
      setForm(EMPTY_FORM);
      refresh();
    },
  });

  if (sample.isLoading) return <Loading />;
  if (!sample.data) return <ErrorBox error={sample.error} />;
  const s = sample.data;
  const actions = s.actions ?? [];

  function run(action: SampleAction) {
    if (SAMPLE_ACTIONS_WITH_FORM.includes(action) || SAMPLE_ACTIONS_NEEDING_REASON.includes(action)) {
      setForm({ ...EMPTY_FORM, destinationLaboratoryId: s.destinationLaboratoryId ?? '' });
      setMove(action);
      return;
    }
    transition.mutate({ action });
  }

  function submitMove() {
    if (!move) return;
    const body: Record<string, unknown> = { action: move };
    if (form.reason.trim()) body.reason = form.reason.trim();
    if (form.notes.trim()) body.notes = form.notes.trim();
    if (move === 'seal') {
      body.sealNumber = form.sealNumber.trim();
      if (form.sealType.trim()) body.sealType = form.sealType.trim();
    }
    if (move === 'dispatch') {
      body.destinationLaboratoryId = form.destinationLaboratoryId || undefined;
      if (form.courier.trim()) body.courier = form.courier.trim();
      if (form.trackingReference.trim()) body.trackingReference = form.trackingReference.trim();
      if (form.packageCount) body.packageCount = Number(form.packageCount);
    }
    if (move === 'receive') {
      body.sealState = form.sealState;
      body.condition = form.condition;
    }
    if (move === 'reject') body.rejectionReason = form.rejectionReason;
    transition.mutate(body);
  }

  const set = (k: keyof MoveForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const commodity = s.commodityName ? localize(s.commodityName, i18n.language) : s.commodity;

  const tabs: { key: Tab; label: string; show: boolean; count?: number }[] = [
    { key: 'overview', label: t('job.details'), show: true },
    { key: 'laboratory', label: t('lab.title'), show: can('lab.test.read') },
    { key: 'custody', label: t('custody.title'), show: can('sample.read_custody'), count: s.custodyEventCount },
    { key: 'attachments', label: t('sample.attachments'), show: true, count: s.attachmentCount },
    { key: 'history', label: t('job.history'), show: true },
  ];

  return (
    <div className="stack has-action-bar">
      <PageHead
        title={s.sampleNumber}
        sub={
          <>
            {t(`sampleType.${s.sampleType}`)} · <Link to={`/jobs/${s.jobId}`}>{s.jobNumber}</Link>
            {s.inspectionId ? (
              <>
                {' · '}
                <Link to={`/inspections/${s.inspectionId}`}>{s.inspectionNumber}</Link>
              </>
            ) : null}{' '}
            · {s.clientName}
          </>
        }
        actions={can('sample.print_label') ? <LabelButton sampleId={s.id} /> : undefined}
      />

      <div className="job-head">
        <SampleStatusBadge status={s.status} />
        <SealBadge number={s.sealNumber} state={s.sealState} />
        {s.statusBeforeHold ? (
          <span className="muted">{t('job.heldFrom', { status: t(`sampleStatus.${s.statusBeforeHold}`) })}</span>
        ) : null}
      </div>

      {s.status === 'rejected_by_lab' && (
        <Alert tone="warning">
          {t('sample.rejectedBy', {
            reason: t(`rejectionReason.${s.rejectionReason ?? 'other'}`),
            name: s.labDecisionByName ?? '—',
          })}
          {s.rejectionNotes ? ` — ${s.rejectionNotes}` : ''}
        </Alert>
      )}
      {s.status === 'accepted_by_lab' && (
        <Alert tone="success">
          {t('sample.acceptedBy', { name: s.labDecisionByName ?? '—', at: fmt(s.labDecisionAt) })}
        </Alert>
      )}
      <ErrorBox error={transition.error} />

      {move && (
        <Card title={t(`sampleAction.${move}`)}>
          <div className="form-grid">
            {move === 'seal' && (
              <>
                <Field label={t('sample.sealNumber')}>
                  <Input value={form.sealNumber} onChange={set('sealNumber')} autoFocus />
                </Field>
                <Field label={t('sample.sealType')}>
                  <Input value={form.sealType} onChange={set('sealType')} />
                </Field>
              </>
            )}
            {move === 'dispatch' && (
              <>
                <Field label={t('sample.destination')}>
                  <Select value={form.destinationLaboratoryId} onChange={set('destinationLaboratoryId')}>
                    <option value="">{t('sample.chooseLab')}</option>
                    {(labs.data ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.isExternal ? ` — ${t('sample.external')}` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('sample.courier')}>
                  <Input value={form.courier} onChange={set('courier')} />
                </Field>
                <Field label={t('sample.tracking')}>
                  <Input value={form.trackingReference} onChange={set('trackingReference')} />
                </Field>
                <Field label={t('sample.packages')}>
                  <Input type="number" min="1" value={form.packageCount} onChange={set('packageCount')} />
                </Field>
              </>
            )}
            {move === 'receive' && (
              <>
                <Field label={t('sample.sealCondition')}>
                  <Select value={form.sealState} onChange={set('sealState')}>
                    {SEAL_CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {t(`sealCondition.${c}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('sample.condition')}>
                  <Select value={form.condition} onChange={set('condition')}>
                    {SAMPLE_CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {t(`sampleCondition.${c}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            {move === 'reject' && (
              <Field label={t('sample.rejectionReason')}>
                <Select value={form.rejectionReason} onChange={set('rejectionReason')}>
                  {SAMPLE_REJECTION_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`rejectionReason.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {(SAMPLE_ACTIONS_NEEDING_REASON.includes(move) || move === 'reject') && (
              <div className="form-grid__wide">
                <Field label={t('sample.reason')}>
                  <TextArea rows={2} value={form.reason} onChange={set('reason')} />
                </Field>
              </div>
            )}
            <div className="form-grid__wide">
              <Field label={t('checklist.notes')}>
                <TextArea rows={2} value={form.notes} onChange={set('notes')} />
              </Field>
            </div>
          </div>
          <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              loading={transition.isPending}
              disabled={
                (move === 'seal' && !form.sealNumber.trim()) ||
                (SAMPLE_ACTIONS_NEEDING_REASON.includes(move) && !form.reason.trim())
              }
              onClick={submitMove}
            >
              {t(`sampleAction.${move}`)}
            </Button>
            <Button variant="ghost" onClick={() => setMove(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      <nav className="tabs">
        {tabs
          .filter((x) => x.show)
          .map((x) => (
            <button
              key={x.key}
              type="button"
              className={`tab${tab === x.key ? ' tab--on' : ''}`}
              onClick={() => setParams(x.key === 'overview' ? {} : { tab: x.key }, { replace: true })}
            >
              {x.label}
              {x.count ? <span className="tab__count">{x.count}</span> : null}
            </button>
          ))}
      </nav>

      {tab === 'overview' && (
        <Card title={t('job.details')}>
          <dl className="detail-grid">
            <Detail label={t('sample.type')} value={t(`sampleType.${s.sampleType}`)} />
            <Detail label={t('sample.method')} value={t(`samplingMethod.${s.samplingMethod}`)} />
            <Detail label={t('jobs.commodity')} value={commodity} />
            <Detail label={t('sample.quantity')} value={s.quantity != null ? `${s.quantity} ${s.unit ?? ''}` : null} />
            <Detail label={t('sample.container')} value={s.containerType} />
            <Detail label={t('sample.batch')} value={s.batchLotNumber} />
            <Detail label={t('sample.containerRef')} value={s.containerReference} />
            <Detail label={t('jobs.location')} value={s.location} />
            <Detail label={t('sample.sampledBy')} value={s.sampledByName} />
            <Detail label={t('sample.sampledAt')} value={fmt(s.sampledAt)} />
            <Detail label={t('sample.sealedBy')} value={s.sealedByName} />
            <Detail label={t('sample.sealedAt')} value={fmt(s.sealedAt)} />
            <Detail label={t('sample.destination')} value={s.destinationLaboratoryName} />
            <Detail label={t('sample.dispatchedAt')} value={fmt(s.dispatchedAt)} />
            <Detail label={t('sample.courier')} value={s.courier} />
            <Detail label={t('sample.tracking')} value={s.trackingReference} />
            <Detail label={t('sample.receivedAt')} value={fmt(s.receivedAt)} />
            <Detail label={t('sample.custodian')} value={s.currentCustodianName ?? s.currentLocation} />
            <Detail label={t('sample.group')} value={s.sampleGroup} />
            <Detail label={t('job.createdBy')} value={s.createdByName} />
          </dl>
          {s.conditionNotes ? (
            <>
              <h3 className="section-title">{t('sample.conditionNotes')}</h3>
              <p className="prewrap">{s.conditionNotes}</p>
            </>
          ) : null}
          {s.instructions ? (
            <>
              <h3 className="section-title">{t('jobs.instructions')}</h3>
              <p className="prewrap">{s.instructions}</p>
            </>
          ) : null}
          {s.internalNotes ? (
            <>
              <h3 className="section-title">{t('inspection.internalNotes')}</h3>
              <p className="prewrap muted">{s.internalNotes}</p>
            </>
          ) : null}

        </Card>
      )}

      {tab === 'laboratory' && <LabOnSample sample={s} />}

      {tab === 'custody' && <CustodyTab sample={s} events={custody.data ?? []} loading={custody.isLoading} />}
      {tab === 'attachments' && (
        <Attachments sample={s} rows={attachments.data ?? []} loading={attachments.isLoading} />
      )}
      {tab === 'history' && (
        <Card title={t('job.history')}>
          <ErrorBox error={history.error} />
          {history.isLoading ? (
            <Loading />
          ) : !history.data?.length ? (
            <EmptyState>{t('job.noHistory')}</EmptyState>
          ) : (
            <SampleTimeline history={history.data} />
          )}
        </Card>
      )}

      <SampleActionBar actions={actions} busy={transition.isPending} onRun={run} />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );
}

/** The chain of custody, plus the two things that add to it: a handover and a correction. */
function CustodyTab({
  sample,
  events,
  loading,
}: {
  sample: Sample;
  events: SampleCustodyEvent[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [handing, setHanding] = useState(false);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [toUserId, setToUserId] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [notes, setNotes] = useState('');
  const open = !['accepted_by_lab', 'cancelled'].includes(sample.status);

  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: can('user.read'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sample-custody', sample.id] });
    qc.invalidateQueries({ queryKey: ['sample', sample.id] });
  };

  const handover = useMutation({
    mutationFn: () =>
      api.post<SampleCustodyEvent[]>(`/samples/${sample.id}/custody`, blanksToNull({ toUserId, toLocation, notes })),
    onSuccess: () => {
      setHanding(false);
      setToUserId('');
      setToLocation('');
      setNotes('');
      refresh();
    },
  });

  const correct = useMutation({
    mutationFn: (eventId: string) =>
      api.post<SampleCustodyEvent[]>(`/samples/${sample.id}/custody/${eventId}/corrections`, { notes }),
    onSuccess: () => {
      setCorrecting(null);
      setNotes('');
      refresh();
    },
  });

  return (
    <Card
      title={t('custody.title')}
      actions={
        can('sample.update') && open ? (
          <Button variant={handing ? 'ghost' : 'secondary'} onClick={() => setHanding((v) => !v)}>
            {handing ? t('common.cancel') : t('custody.handover')}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={handover.error ?? correct.error} />
      <p className="muted">{t('custody.hint')}</p>

      {handing && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <div className="form-grid">
            <Field label={t('custody.toPerson')}>
              <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
                <option value="">{t('job.selectPerson')}</option>
                {(people.data ?? [])
                  .filter((u) => u.isActive)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('custody.toLocation')}>
              <Input value={toLocation} onChange={(e) => setToLocation(e.target.value)} />
            </Field>
            <div className="form-grid__wide">
              <Field label={t('checklist.notes')}>
                <TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </div>
          <div>
            <Button
              disabled={!toUserId && !toLocation.trim()}
              loading={handover.isPending}
              onClick={() => handover.mutate()}
            >
              {t('custody.record')}
            </Button>
          </div>
        </div>
      )}

      {correcting && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Alert tone="warning">{t('custody.correctionHint')}</Alert>
          <Field label={t('custody.whatWasWrong')}>
            <TextArea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="row-actions">
            <Button disabled={!notes.trim()} loading={correct.isPending} onClick={() => correct.mutate(correcting)}>
              {t('custody.recordCorrection')}
            </Button>
            <Button variant="ghost" onClick={() => setCorrecting(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !events.length ? (
        <EmptyState>{t('custody.empty')}</EmptyState>
      ) : (
        <>
          <CustodyTimeline events={events} />
          {can('sample.update') && (
            <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)', flexWrap: 'wrap' }}>
              {events
                .filter((e) => e.eventType !== 'correction' && !e.correctedByEventId)
                .map((e) => (
                  <Button key={e.id} size="sm" variant="ghost" onClick={() => setCorrecting(e.id)}>
                    {t('custody.correct', { event: t(`custodyEvent.${e.eventType}`) })}
                  </Button>
                ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Attachments({ sample, rows, loading }: { sample: Sample; rows: InspectionPhoto[]; loading: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [category, setCategory] = useState<PhotoCategory>('seal');
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const open = sample.status !== 'cancelled';

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
        await api.upload<InspectionPhoto>(`/samples/${sample.id}/attachments`, form);
      }
      setCaption('');
      qc.invalidateQueries({ queryKey: ['sample-attachments', sample.id] });
      qc.invalidateQueries({ queryKey: ['sample', sample.id] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('sample.attachments')}>
      <ErrorBox error={error} />
      {can('sample.add_attachment') && open && (
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
            <input type="file" accept="image/*,application/pdf" capture="environment" multiple onChange={onFiles} disabled={busy} />
          </label>
        </div>
      )}

      {loading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('sample.noAttachments')}</EmptyState>
      ) : (
        <div className="photos">
          {rows.map((p) => (
            <div key={p.id} className="photo photo--lg">
              <a href={p.url} target="_blank" rel="noreferrer" title={p.caption ?? p.originalName ?? ''}>
                {p.mimeType === 'application/pdf' ? (
                  <span className="photo__doc">PDF</span>
                ) : (
                  <img src={p.previewUrl} alt={p.caption ?? ''} loading="lazy" />
                )}
              </a>
              <div className="photo__cap">
                <Badge tone="neutral">{t(`photoCategory.${p.category}`)}</Badge> {p.caption || fmt(p.takenAt)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Opens the printable label in its own window. The QR on it is a link into the application,
 * so a label picked up in a port does not hand a stranger the client's business.
 */
function LabelButton({ sampleId }: { sampleId: string }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);

  async function print() {
    setBusy(true);
    const win = window.open('', '_blank');
    try {
      const label = await api.get<SampleLabel>(`/samples/${sampleId}/label?locale=${i18n.language}`);
      const rows: [string, string | null][] = [
        [t('inspections.job'), label.jobNumber],
        [t('jobs.client'), label.clientName],
        [t('jobs.commodity'), label.commodity],
        [t('sample.type'), t(`sampleType.${label.sampleType}`)],
        [t('sample.quantity'), label.quantity],
        [t('sample.seal'), label.sealNumber],
        [t('sample.sampledAt'), label.sampledAt ? new Date(label.sampledAt).toLocaleString(i18n.language) : null],
        [t('sample.destination'), label.destination],
      ];
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${label.sampleNumber}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 12mm; }
  .label { width: 90mm; border: 1px solid #222; border-radius: 3mm; padding: 6mm; display: grid; gap: 3mm; }
  .head { display: flex; justify-content: space-between; align-items: center; }
  .brand { font-weight: 700; letter-spacing: .08em; }
  .no { font-family: ui-monospace, monospace; font-size: 5mm; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 3.4mm; }
  td { padding: 1mm 0; vertical-align: top; }
  td:first-child { color: #555; width: 34%; }
  img { width: 26mm; height: 26mm; }
  @media print { body { padding: 0; } }
</style></head><body><div class="label">
  <div class="head"><span class="brand">GSI</span><span class="no">${label.sampleNumber}</span></div>
  <div class="head">
    <table>${rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td>${k}</td><td>${String(v)}</td></tr>`)
      .join('')}</table>
    <img src="${label.qrDataUrl}" alt="${label.sampleNumber}" />
  </div>
</div><script>window.onload = () => window.print();</script></body></html>`;
      if (win) {
        win.document.write(html);
        win.document.close();
      }
    } catch {
      win?.close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" loading={busy} onClick={print}>
      {t('sample.printLabel')}
    </Button>
  );
}

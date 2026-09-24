import { ChangeEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import {
  LabInstrument,
  TestRequest,
  TestRequestAction,
  TestRequestHistoryEntry,
  TestResult,
  User,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  EvaluationBadge,
  LAB_ACTIONS_NEEDING_REASON,
  LabActionBar,
  LabTimeline,
  ResultValue,
  TestStatusBadge,
  useSpecText,
} from '../components/LabBits';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

type Tab = 'result' | 'revisions' | 'history';

/** The draft an analyst is typing. The numeric value stays a string: 12.40 is not 12.4. */
type Draft = {
  numericValue: string;
  textValue: string;
  booleanValue: string;
  qualitativeValue: string;
  unit: string;
  instrumentId: string;
  comments: string;
};

const EMPTY_DRAFT: Draft = {
  numericValue: '',
  textValue: '',
  booleanValue: '',
  qualitativeValue: '',
  unit: '',
  instrumentId: '',
  comments: '',
};

function draftFrom(result: TestResult | null | undefined, fallbackUnit: string | null | undefined): Draft {
  return {
    numericValue: result?.numericValue != null ? String(result.numericValue) : '',
    textValue: result?.textValue ?? '',
    booleanValue: result?.booleanValue == null ? '' : String(result.booleanValue),
    qualitativeValue: result?.qualitativeValue ?? '',
    unit: result?.unit ?? fallbackUnit ?? '',
    instrumentId: result?.instrumentId ?? '',
    comments: result?.comments ?? '',
  };
}

/**
 * One analysis, from the bench to the signature.
 *
 * The three things this screen exists to make impossible are all visible on it: the analyst
 * cannot write once the result has been handed in, the reviewer cannot be the analyst, and an
 * approved number is corrected by a new revision that leaves the old one exactly as it was.
 */
export function LabRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const specs = useSpecText();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'result';

  const [move, setMove] = useState<TestRequestAction | null>(null);
  const [reason, setReason] = useState('');
  const [analystId, setAnalystId] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);

  const request = useQuery({
    queryKey: ['lab-request', id],
    queryFn: () => api.get<TestRequest>(`/lab/requests/${id}`),
  });
  const history = useQuery({
    queryKey: ['lab-request-history', id],
    queryFn: () => api.get<TestRequestHistoryEntry[]>(`/lab/requests/${id}/history`),
  });
  const revisions = useQuery({
    queryKey: ['lab-request-revisions', id],
    queryFn: () => api.get<TestResult[]>(`/lab/requests/${id}/revisions`),
  });
  const instruments = useQuery({
    queryKey: ['lab-instruments', request.data?.laboratoryId],
    queryFn: () => api.get<LabInstrument[]>(`/lab/instruments?laboratoryId=${request.data?.laboratoryId}`),
    enabled: Boolean(request.data?.laboratoryId) && can('lab.instrument.read'),
    staleTime: 300_000,
  });
  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    staleTime: 300_000,
    enabled: move === 'assign' && can('user.read'),
  });

  const r = request.data;

  // The form follows the record until the analyst starts typing, and then leaves them alone.
  useEffect(() => {
    if (r && !dirty) setDraft(draftFrom(r.result, r.result?.unit ?? null));
  }, [r?.result?.id, r?.result?.version, r?.updatedAt, dirty]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lab-request', id] });
    qc.invalidateQueries({ queryKey: ['lab-request-history', id] });
    qc.invalidateQueries({ queryKey: ['lab-request-revisions', id] });
    qc.invalidateQueries({ queryKey: ['lab-requests'] });
    qc.invalidateQueries({ queryKey: ['lab-dashboard'] });
    qc.invalidateQueries({ queryKey: ['sample-lab'] });
    qc.invalidateQueries({ queryKey: ['job-lab'] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { version: r?.result?.version };
      if (r?.resultType === 'numeric') body.numericValue = draft.numericValue === '' ? null : draft.numericValue;
      if (r?.resultType === 'text') body.textValue = draft.textValue || null;
      if (r?.resultType === 'boolean' || r?.resultType === 'pass_fail') {
        body.booleanValue = draft.booleanValue === '' ? null : draft.booleanValue === 'true';
      }
      if (r?.resultType === 'qualitative') body.qualitativeValue = draft.qualitativeValue || null;
      if (draft.unit.trim()) body.unit = draft.unit.trim();
      if (draft.instrumentId) body.instrumentId = draft.instrumentId;
      body.comments = draft.comments.trim() || null;
      return api.patch<TestRequest>(`/lab/requests/${id}/result`, body);
    },
    onSuccess: () => {
      setDirty(false);
      refresh();
    },
  });

  const act = useMutation({
    mutationFn: (v: { path: string; body?: Record<string, unknown> }) =>
      api.post<TestRequest>(`/lab/requests/${id}${v.path}`, v.body ?? {}),
    onSuccess: () => {
      setMove(null);
      setReason('');
      setAnalystId('');
      setDirty(false);
      refresh();
    },
  });

  if (request.isLoading) return <Loading />;
  if (!r) return <ErrorBox error={request.error} />;

  const result = r.result ?? null;
  const spec = result?.specificationSnapshot ?? null;
  const actions = (r.actions ?? []).filter((a) => a !== 'enter');
  const editable = ['in_progress', 'result_entered'].includes(r.status) && can('lab.result.enter');
  const isAnalyst = result?.analystId === user?.id || r.assignedAnalystId === user?.id;

  function run(action: TestRequestAction) {
    if (action === 'assign') {
      setAnalystId(r?.assignedAnalystId ?? '');
      setMove('assign');
      return;
    }
    if (LAB_ACTIONS_NEEDING_REASON.includes(action) || action === 'review') {
      setReason('');
      setMove(action);
      return;
    }
    if (action === 'submit') return act.mutate({ path: '/result/submit' });
    if (action === 'approve') return act.mutate({ path: '/result/approve' });
    if (action === 'release') return act.mutate({ path: '/result/release' });
    act.mutate({ path: '/transitions', body: { action } });
  }

  function submitMove() {
    if (!move) return;
    if (move === 'assign') return act.mutate({ path: '/assignment', body: { analystId } });
    if (move === 'review') return act.mutate({ path: '/result/review', body: { comment: reason.trim() || undefined } });
    if (move === 'return') return act.mutate({ path: '/result/return', body: { reason: reason.trim() } });
    if (move === 'amend') return act.mutate({ path: '/result/amendments', body: { reason: reason.trim() } });
    act.mutate({ path: '/transitions', body: { action: move, reason: reason.trim() } });
  }

  const set = (k: keyof Draft) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDirty(true);
    setDraft({ ...draft, [k]: e.target.value });
  };

  const testName = r.testName ? localize(r.testName, i18n.language) : (r.testCode ?? '—');
  const commodity = r.commodityName ? localize(r.commodityName, i18n.language) : (r.commodity ?? '—');

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'result', label: t('lab.result') },
    { key: 'revisions', label: t('lab.revisions'), count: r.revisionCount },
    { key: 'history', label: t('job.history') },
  ];

  return (
    <div className="stack has-action-bar">
      <PageHead
        title={testName}
        sub={
          <>
            <Link to={`/samples/${r.sampleId}`}>{r.sampleNumber}</Link>
            {r.jobId ? (
              <>
                {' · '}
                <Link to={`/jobs/${r.jobId}`}>{r.jobNumber}</Link>
              </>
            ) : null}{' '}
            · {r.clientName} · {commodity}
          </>
        }
      />

      <div className="job-head">
        <TestStatusBadge status={r.status} />
        {result ? <EvaluationBadge evaluation={result.evaluation} /> : null}
        <Badge tone={r.priority === 'urgent' || r.priority === 'high' ? 'warning' : 'neutral'}>
          {t(`priority.${r.priority}`)}
        </Badge>
        {r.overdue ? <Badge tone="danger">{t('lab.overdue')}</Badge> : null}
        {r.statusBeforeHold ? (
          <span className="muted">{t('job.heldFrom', { status: t(`testStatus.${r.statusBeforeHold}`) })}</span>
        ) : null}
      </div>

      {result?.evaluation === 'out_of_spec' && (
        <Alert tone="warning">
          {t('lab.outOfSpecNotice', { limits: specs(spec) })}
        </Alert>
      )}
      {result?.instrumentOverdue && (
        <Alert tone="warning">{t('lab.instrumentOverdueNotice', { name: result.instrumentName ?? '—' })}</Alert>
      )}
      {result?.amendmentReason && r.status !== 'released' && (
        <Alert tone="warning">{t('lab.amendedBecause', { reason: result.amendmentReason })}</Alert>
      )}
      {result?.reviewComment && r.status === 'in_progress' && (
        <Alert tone="warning">{t('lab.returnedBecause', { reason: result.reviewComment })}</Alert>
      )}
      <ErrorBox error={act.error ?? save.error} />

      {move && (
        <Card title={t(`testAction.${move}`)}>
          <div className="form-grid">
            {move === 'assign' ? (
              <Field label={t('lab.analyst')}>
                <Select value={analystId} onChange={(e) => setAnalystId(e.target.value)}>
                  <option value="">{t('lab.chooseAnalyst')}</option>
                  {(people.data ?? [])
                    .filter((u) => u.isActive)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName}
                      </option>
                    ))}
                </Select>
              </Field>
            ) : (
              <div className="form-grid__wide">
                <Field
                  label={move === 'review' ? t('lab.reviewComment') : t('sample.reason')}
                  hint={move === 'amend' ? t('lab.amendHint') : undefined}
                >
                  <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                </Field>
              </div>
            )}
          </div>
          <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              loading={act.isPending}
              disabled={
                (move === 'assign' && !analystId) ||
                (LAB_ACTIONS_NEEDING_REASON.includes(move) && reason.trim().length < 3)
              }
              onClick={submitMove}
            >
              {t(`testAction.${move}`)}
            </Button>
            <Button variant="ghost" onClick={() => setMove(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      <nav className="tabs">
        {tabs.map((x) => (
          <button
            key={x.key}
            type="button"
            className={`tab${tab === x.key ? ' tab--on' : ''}`}
            onClick={() => setParams(x.key === 'result' ? {} : { tab: x.key }, { replace: true })}
          >
            {x.label}
            {x.count ? <span className="tab__count">{x.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'result' && (
        <>
          <Card title={t('lab.analysis')}>
            <dl className="detail-grid">
              <Detail label={t('lab.test')} value={testName} />
              <Detail
                label={t('lab.method')}
                value={`${r.methodCode ?? '—'} — ${r.methodName ?? ''} (v${r.methodVersion ?? 1})`}
              />
              <Detail label={t('lab.laboratory')} value={r.laboratoryName} />
              <Detail label={t('lab.analyst')} value={r.assignedAnalystName} />
              <Detail label={t('lab.requestedBy')} value={r.requestedByName} />
              <Detail label={t('lab.requestedAt')} value={fmt(r.requestedAt)} />
              <Detail label={t('lab.startedAt')} value={fmt(r.startedAt)} />
              <Detail label={t('lab.due')} value={fmt(r.dueAt)} />
              <Detail label={t('lab.specification')} value={specs(spec)} />
              <Detail label={t('lab.specScope')} value={spec ? t(`lab.scope.${spec.scope}`) : '—'} />
            </dl>
            {r.instructions ? (
              <>
                <h3 className="section-title">{t('jobs.instructions')}</h3>
                <p className="prewrap">{r.instructions}</p>
              </>
            ) : null}
            {r.cancelReason ? (
              <>
                <h3 className="section-title">{t('sample.reason')}</h3>
                <p className="prewrap">{r.cancelReason}</p>
              </>
            ) : null}
          </Card>

          {editable ? (
            <Card title={t('lab.enterResult')}>
              <div className="form-grid">
                {r.resultType === 'numeric' && (
                  <>
                    <Field
                      label={t('lab.value')}
                      hint={
                        result?.methodSnapshot?.detectionLimit != null
                          ? t('lab.detectionLimit', { value: result.methodSnapshot.detectionLimit })
                          : undefined
                      }
                    >
                      <Input
                        inputMode="decimal"
                        value={draft.numericValue}
                        onChange={set('numericValue')}
                        placeholder="0.00"
                      />
                    </Field>
                    <Field label={t('sample.unit')}>
                      <Input value={draft.unit} onChange={set('unit')} />
                    </Field>
                  </>
                )}
                {r.resultType === 'text' && (
                  <div className="form-grid__wide">
                    <Field label={t('lab.value')}>
                      <TextArea rows={3} value={draft.textValue} onChange={set('textValue')} />
                    </Field>
                  </div>
                )}
                {(r.resultType === 'boolean' || r.resultType === 'pass_fail') && (
                  <Field label={t('lab.value')}>
                    <Select value={draft.booleanValue} onChange={set('booleanValue')}>
                      <option value="">{t('lab.noValue')}</option>
                      <option value="true">
                        {r.resultType === 'pass_fail' ? t('lab.pass') : t('lab.detected')}
                      </option>
                      <option value="false">
                        {r.resultType === 'pass_fail' ? t('lab.fail') : t('lab.notDetected')}
                      </option>
                    </Select>
                  </Field>
                )}
                {r.resultType === 'qualitative' && (
                  <Field label={t('lab.value')}>
                    <Input value={draft.qualitativeValue} onChange={set('qualitativeValue')} />
                  </Field>
                )}
                {can('lab.instrument.read') && (
                  <Field label={t('lab.instrument')}>
                    <Select value={draft.instrumentId} onChange={set('instrumentId')}>
                      <option value="">{t('lab.noInstrument')}</option>
                      {(instruments.data ?? []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.code} — {x.name}
                          {x.calibrationOverdue ? ` (${t('lab.calibrationOverdue')})` : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <div className="form-grid__wide">
                  <Field label={t('checklist.notes')}>
                    <TextArea rows={2} value={draft.comments} onChange={set('comments')} />
                  </Field>
                </div>
              </div>
              <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
                <Button loading={save.isPending} onClick={() => save.mutate()}>
                  {t('lab.saveResult')}
                </Button>
                {dirty ? <span className="muted">{t('lab.unsaved')}</span> : null}
              </div>
            </Card>
          ) : null}

          <Card title={t('lab.result')}>
            {!result ? (
              <EmptyState>{t('lab.noResultYet')}</EmptyState>
            ) : (
              <>
                <div className="job-head">
                  <span className="result-value">
                    <ResultValue result={result} />
                  </span>
                  <EvaluationBadge evaluation={result.evaluation} />
                  <span className="muted">{t('lab.revisionNo', { n: result.revision })}</span>
                </div>
                <dl className="detail-grid">
                  <Detail label={t('lab.specification')} value={specs(spec)} />
                  <Detail label={t('lab.methodUsed')} value={`${result.methodSnapshot.code} v${result.methodSnapshot.version}`} />
                  <Detail label={t('lab.standard')} value={result.methodSnapshot.standardReference} />
                  <Detail label={t('lab.instrument')} value={result.instrumentName} />
                  <Detail label={t('lab.analyst')} value={result.analystName} />
                  <Detail label={t('lab.enteredAt')} value={fmt(result.enteredAt)} />
                  <Detail label={t('lab.submittedAt')} value={fmt(result.submittedAt)} />
                  <Detail
                    label={t('lab.reviewedBy')}
                    value={result.reviewedBy ? `${result.reviewedByName ?? '—'} · ${fmt(result.reviewedAt)}` : null}
                  />
                  <Detail
                    label={t('lab.approvedBy')}
                    value={result.approvedBy ? `${result.approvedByName ?? '—'} · ${fmt(result.approvedAt)}` : null}
                  />
                  <Detail
                    label={t('lab.releasedBy')}
                    value={result.releasedBy ? `${result.releasedByName ?? '—'} · ${fmt(result.releasedAt)}` : null}
                  />
                </dl>
                {result.comments ? (
                  <>
                    <h3 className="section-title">{t('checklist.notes')}</h3>
                    <p className="prewrap">{result.comments}</p>
                  </>
                ) : null}
                {result.reviewComment ? (
                  <>
                    <h3 className="section-title">{t('lab.reviewComment')}</h3>
                    <p className="prewrap">{result.reviewComment}</p>
                  </>
                ) : null}
                {isAnalyst && ['under_review', 'approved', 'released'].includes(r.status) ? (
                  <p className="muted">{t('lab.handedInNotice')}</p>
                ) : null}
              </>
            )}
          </Card>
        </>
      )}

      {tab === 'revisions' && (
        <Card title={t('lab.revisions')}>
          <ErrorBox error={revisions.error} />
          {revisions.isLoading ? (
            <Loading />
          ) : !revisions.data?.length ? (
            <EmptyState>{t('lab.noResultYet')}</EmptyState>
          ) : (
            <>
              <p className="muted">{t('lab.revisionsNotice')}</p>
              <Table>
                <thead>
                  <tr>
                    <th>{t('lab.revision')}</th>
                    <th>{t('lab.value')}</th>
                    <th>{t('lab.specification')}</th>
                    <th>{t('lab.analyst')}</th>
                    <th>{t('lab.approvedBy')}</th>
                    <th>{t('lab.releasedBy')}</th>
                    <th>{t('lab.amendmentReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.data.map((v) => (
                    <tr key={v.id} className={v.isCurrent ? '' : 'row--superseded'}>
                      <td className="mono">
                        {v.revision}
                        {v.isCurrent ? <Badge tone="info">{t('lab.current')}</Badge> : null}
                      </td>
                      <td>
                        <ResultValue result={v} />
                      </td>
                      <td>
                        <EvaluationBadge evaluation={v.evaluation} />
                      </td>
                      <td>{v.analystName ?? '—'}</td>
                      <td>{v.approvedByName ? `${v.approvedByName} · ${fmt(v.approvedAt)}` : '—'}</td>
                      <td>{v.releasedByName ? `${v.releasedByName} · ${fmt(v.releasedAt)}` : '—'}</td>
                      <td className="prewrap">{v.amendmentReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card title={t('job.history')}>
          <ErrorBox error={history.error} />
          {history.isLoading ? (
            <Loading />
          ) : !history.data?.length ? (
            <EmptyState>{t('job.noHistory')}</EmptyState>
          ) : (
            <LabTimeline history={history.data} />
          )}
        </Card>
      )}

      <LabActionBar actions={actions} busy={act.isPending} onRun={run} />
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

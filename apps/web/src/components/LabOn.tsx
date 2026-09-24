import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  JOB_PRIORITIES,
  JobPriority,
  Page,
  ReleasedResult,
  Sample,
  TestPanel,
  TestRequest,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { EvaluationBadge, ResultValue, TestStatusBadge, useSpecText, useTestName } from './LabBits';
import { ErrorBox, Loading, useFormatDate, useMediaQuery } from './common';

/**
 * The laboratory work on one sample: what was asked for, where each analysis has got to, and
 * what it measured. Analyses can only be asked for once the laboratory has accepted the
 * sample — before that there is nothing on a bench to measure.
 */
export function LabOnSample({ sample }: { sample: Sample }) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const nameOf = useTestName();
  const narrow = useMediaQuery('(max-width: 720px)');

  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [priority, setPriority] = useState<JobPriority>('normal');
  const [dueAt, setDueAt] = useState('');

  const list = useQuery({
    queryKey: ['sample-lab', sample.id],
    queryFn: () => api.get<Page<TestRequest>>(`/lab/requests?sampleId=${sample.id}&limit=100`),
    enabled: can('lab.test.read'),
  });
  const panel = useQuery({
    queryKey: ['lab-panel', sample.commodityId, sample.id],
    queryFn: () => api.get<TestPanel>(`/lab/panels/${sample.commodityId}?sampleId=${sample.id}`),
    enabled: asking && Boolean(sample.commodityId) && can('lab.test.read'),
  });

  const request = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ created: TestRequest[]; skipped: number }>('/lab/requests', { sampleId: sample.id, ...body }),
    onSuccess: () => {
      setAsking(false);
      setPicked({});
      qc.invalidateQueries({ queryKey: ['sample-lab', sample.id] });
      qc.invalidateQueries({ queryKey: ['lab-requests'] });
      qc.invalidateQueries({ queryKey: ['lab-dashboard'] });
    },
  });

  const rows = list.data?.rows ?? [];
  const accepted = sample.status === 'accepted_by_lab';
  const canAsk = can('lab.test.request') && accepted;
  const available = (panel.data?.tests ?? []).filter((x) => x.testMethodId && !x.alreadyRequested);
  const chosen = available.filter((x) => picked[x.labTestId]);

  if (!can('lab.test.read')) return null;

  const common = {
    priority,
    ...(dueAt ? { dueAt: new Date(`${dueAt}T17:00:00`).toISOString() } : {}),
  };

  return (
    <Card
      title={t('lab.title')}
      actions={
        canAsk ? (
          <Button variant={asking ? 'ghost' : 'secondary'} onClick={() => setAsking((v) => !v)}>
            {asking ? t('common.cancel') : `+ ${t('lab.requestTests')}`}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={list.error ?? request.error} />

      {!accepted && !rows.length ? (
        <p className="muted">{t('lab.needsAcceptedSample')}</p>
      ) : null}

      {asking && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          {!sample.commodityId ? (
            <Alert tone="warning">{t('lab.noCommodityPanel')}</Alert>
          ) : panel.isLoading ? (
            <Loading />
          ) : !available.length ? (
            <EmptyState>{t('lab.panelAllRequested')}</EmptyState>
          ) : (
            <>
              <div className="form-grid">
                <Field label={t('jobs.priority')}>
                  <Select value={priority} onChange={(e) => setPriority(e.target.value as JobPriority)}>
                    {JOB_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {t(`priority.${p}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('lab.due')}>
                  <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
                </Field>
              </div>
              <div className="chips">
                {available.map((x) => (
                  <button
                    key={x.labTestId}
                    type="button"
                    className={`chip${picked[x.labTestId] ? ' chip--on' : ''}`}
                    onClick={() => setPicked({ ...picked, [x.labTestId]: !picked[x.labTestId] })}
                  >
                    {localize(x.name, i18n.language)}
                  </button>
                ))}
              </div>
              <div className="row-actions">
                <Button
                  loading={request.isPending}
                  onClick={() => request.mutate({ usePanel: true, skipDuplicates: true, ...common })}
                >
                  {t('lab.requestWholePanel', { count: available.length })}
                </Button>
                <Button
                  variant="secondary"
                  disabled={!chosen.length}
                  loading={request.isPending}
                  onClick={() =>
                    request.mutate({
                      tests: chosen.map((x) => ({ labTestId: x.labTestId, testMethodId: x.testMethodId })),
                      ...common,
                    })
                  }
                >
                  {t('lab.requestChosen', { count: chosen.length })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {list.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('lab.noneOnSample')}</EmptyState>
      ) : narrow ? (
        <div className="stack">
          {rows.map((r) => (
            <Link key={r.id} to={`/lab/requests/${r.id}`} className="ins-card">
              <div className="ins-card__head">
                <span>{nameOf(r.testName, r.testCode)}</span>
                <TestStatusBadge status={r.status} />
              </div>
              <div className="muted">
                {r.methodCode} v{r.methodVersion}
              </div>
              <div className="ins-card__meta">
                <ResultValue result={r.result} />
                {r.result ? <EvaluationBadge evaluation={r.result.evaluation} /> : null}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('lab.test')}</th>
              <th>{t('lab.method')}</th>
              <th>{t('lab.analyst')}</th>
              <th>{t('lab.value')}</th>
              <th>{t('lab.againstSpec')}</th>
              <th>{t('lab.due')}</th>
              <th>{t('jobs.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="link-row" onClick={() => navigate(`/lab/requests/${r.id}`)}>
                <td>
                  <Link to={`/lab/requests/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    {nameOf(r.testName, r.testCode)}
                  </Link>
                </td>
                <td className="mono">
                  {r.methodCode}
                  <span className="muted"> v{r.methodVersion}</span>
                </td>
                <td>{r.assignedAnalystName ?? <span className="muted">{t('lab.unassignedShort')}</span>}</td>
                <td>
                  <ResultValue result={r.result} />
                </td>
                <td>
                  {r.result ? <EvaluationBadge evaluation={r.result.evaluation} /> : <span className="muted">—</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.dueAt)}</td>
                <td>
                  <TestStatusBadge status={r.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/**
 * The laboratory position on a whole job, counted from the same rows: how many analyses are
 * outstanding, how many are released, and whether any of them is outside its limits. A job
 * whose laboratory work is not finished should say so on its own card.
 */
export function LabOnJob({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nameOf = useTestName();
  const fmt = useFormatDate();
  const specs = useSpecText();
  const navigate = useNavigate();

  const list = useQuery({
    queryKey: ['job-lab', jobId],
    queryFn: () => api.get<Page<TestRequest>>(`/lab/requests?jobId=${jobId}&limit=200`),
    enabled: can('lab.test.read'),
  });
  // The read model a report is allowed through, shown here as the report will see it.
  const released = useQuery({
    queryKey: ['job-lab-released', jobId],
    queryFn: () => api.get<ReleasedResult[]>(`/lab/released?jobId=${jobId}`),
    enabled: can('lab.test.read'),
  });

  if (!can('lab.test.read')) return null;
  const rows = list.data?.rows ?? [];
  if (!list.isLoading && !rows.length) return null;

  const outstanding = rows.filter((r) =>
    ['requested', 'assigned', 'in_progress', 'result_entered', 'under_review', 'approved', 'on_hold'].includes(r.status),
  ).length;
  const releasedRows = released.data ?? [];
  const outOfSpec = rows.filter((r) => r.result?.evaluation === 'out_of_spec').length;

  return (
    <div className="stack">
      <Card title={t('lab.releasedForReport')}>
        <ErrorBox error={released.error} />
        <p className="muted">{t('lab.releasedForReportHint')}</p>
        {released.isLoading ? (
          <Loading />
        ) : !releasedRows.length ? (
          <EmptyState>{t('lab.noneReleased')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('samples.number')}</th>
                <th>{t('lab.test')}</th>
                <th>{t('lab.methodUsed')}</th>
                <th>{t('lab.value')}</th>
                <th>{t('lab.specification')}</th>
                <th>{t('lab.againstSpec')}</th>
                <th>{t('lab.revision')}</th>
                <th>{t('lab.releasedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {releasedRows.map((x) => (
                <tr key={x.resultId}>
                  <td className="mono">{x.sampleNumber}</td>
                  <td>{nameOf(x.testName, x.testCode)}</td>
                  <td className="mono">
                    {x.methodCode}
                    <span className="muted"> v{x.methodVersion}</span>
                  </td>
                  <td className="mono">
                    {x.numericValue ?? x.textValue ?? x.qualitativeValue ??
                      (x.booleanValue == null ? '—' : t(x.booleanValue ? 'lab.detected' : 'lab.notDetected'))}
                    {x.numericValue != null && x.unit ? ` ${x.unit}` : ''}
                  </td>
                  <td>{specs(x.specificationSnapshot)}</td>
                  <td>
                    <EvaluationBadge evaluation={x.evaluation} />
                  </td>
                  <td className="num">{x.revision}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(x.releasedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={t('lab.allWorkOnJob')}>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Loading />
        ) : (
          <>
          <div className="job-head">
            <Badge tone={outstanding ? 'warning' : 'success'}>
              {t('lab.outstandingCount', { count: outstanding })}
            </Badge>
            <Badge tone="success">{t('lab.releasedCount', { count: releasedRows.length })}</Badge>
            {outOfSpec ? <Badge tone="danger">{t('lab.outOfSpecCount', { count: outOfSpec })}</Badge> : null}
          </div>
          <Table>
            <thead>
              <tr>
                <th>{t('samples.number')}</th>
                <th>{t('lab.test')}</th>
                <th>{t('lab.value')}</th>
                <th>{t('lab.againstSpec')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="link-row" onClick={() => navigate(`/lab/requests/${r.id}`)}>
                  <td className="mono">{r.sampleNumber}</td>
                  <td>{nameOf(r.testName, r.testCode)}</td>
                  <td>
                    <ResultValue result={r.result} />
                  </td>
                  <td>
                    {r.result ? <EvaluationBadge evaluation={r.result.evaluation} /> : <span className="muted">—</span>}
                  </td>
                  <td>
                    <TestStatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          </>
        )}
      </Card>
    </div>
  );
}

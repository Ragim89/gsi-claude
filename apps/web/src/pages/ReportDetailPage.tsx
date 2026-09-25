import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Field, Select, Table, TextArea } from '@gsi/ui-kit/react';
import {
  ReportAction,
  ReportContent,
  ReportDocument,
  ReportHistoryEntry,
  ReportSources,
  ReportVersion,
  localize,
} from '@gsi/shared-types';
import { api, downloadFile, openPdf } from '../api';
import { useAuth } from '../auth';
import {
  DocumentStatusBadge,
  REPORT_ACTIONS_NEEDING_REASON,
  ReportActionBar,
  ReportTimeline,
} from '../components/ReportBits';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

type Tab = 'overview' | 'content' | 'sources' | 'versions' | 'history';

/**
 * One document, from the page somebody writes to the file a client receives.
 *
 * The three rules this screen exists to make visible: an issued document cannot be edited, the
 * person who wrote it does not approve it, and everything factual on the page comes from the
 * system — the writer supplies the paragraphs, never the results.
 */
export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';

  const [move, setMove] = useState<ReportAction | null>(null);
  const [reason, setReason] = useState('');
  const [draft, setDraft] = useState<ReportContent>({});
  const [dirty, setDirty] = useState(false);

  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.get<ReportDocument>(`/reports/${id}`),
  });
  const history = useQuery({
    queryKey: ['report-history', id],
    queryFn: () => api.get<ReportHistoryEntry[]>(`/reports/${id}/history`),
  });
  const versions = useQuery({
    queryKey: ['report-versions', id],
    queryFn: () => api.get<ReportVersion[]>(`/reports/${id}/versions`),
  });
  const sources = useQuery({
    queryKey: ['report-sources', id],
    queryFn: () => api.get<ReportSources>(`/reports/${id}/sources`),
    enabled: tab === 'sources' || tab === 'content',
  });

  const r = report.data;
  const version = r?.currentVersion ?? null;

  useEffect(() => {
    if (version && !dirty) setDraft(version.content ?? {});
  }, [version?.id, version?.lockVersion, dirty]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['report', id] });
    qc.invalidateQueries({ queryKey: ['report-history', id] });
    qc.invalidateQueries({ queryKey: ['report-versions', id] });
    qc.invalidateQueries({ queryKey: ['reports'] });
    qc.invalidateQueries({ queryKey: ['job-reports'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch<ReportDocument>(`/reports/${id}`, { content: draft, lockVersion: version?.lockVersion }),
    onSuccess: () => {
      setDirty(false);
      refresh();
    },
  });

  const act = useMutation({
    mutationFn: (v: { path: string; body?: Record<string, unknown> }) =>
      api.post<ReportDocument>(`/reports/${id}${v.path}`, v.body ?? {}),
    onSuccess: () => {
      setMove(null);
      setReason('');
      setDirty(false);
      refresh();
    },
  });

  if (report.isLoading) return <Loading />;
  if (!r) return <ErrorBox error={report.error} />;

  const editable = ['draft', 'changes_requested'].includes(r.status) && can('report.update');
  const actions = r.actions ?? [];

  function run(action: ReportAction) {
    if (REPORT_ACTIONS_NEEDING_REASON.includes(action) || action === 'review') {
      setReason('');
      setMove(action);
      return;
    }
    if (action === 'submit') return act.mutate({ path: '/submit' });
    if (action === 'approve') return act.mutate({ path: '/approve' });
    if (action === 'issue') return act.mutate({ path: '/issue' });
  }

  function submitMove() {
    if (!move) return;
    if (move === 'review') return act.mutate({ path: '/review', body: { comment: reason.trim() || undefined } });
    if (move === 'request_changes') return act.mutate({ path: '/changes', body: { reason: reason.trim() } });
    if (move === 'revise') return act.mutate({ path: '/revisions', body: { reason: reason.trim() } });
    if (move === 'cancel') return act.mutate({ path: '/cancel', body: { reason: reason.trim() } });
  }

  const set = (k: keyof ReportContent) => (e: { target: { value: string } }) => {
    setDirty(true);
    setDraft({ ...draft, [k]: e.target.value });
  };

  const togglePhoto = (photoId: string) => {
    setDirty(true);
    const chosen = draft.photoIds ?? [];
    setDraft({
      ...draft,
      photoIds: chosen.includes(photoId) ? chosen.filter((x) => x !== photoId) : [...chosen, photoId],
    });
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'overview', label: t('job.details') },
    { key: 'content', label: t('reports.content') },
    { key: 'sources', label: t('reports.dataSources') },
    { key: 'versions', label: t('reports.versions'), count: r.versionCount },
    { key: 'history', label: t('job.history') },
  ];

  return (
    <div className="stack has-action-bar">
      <PageHead
        title={r.reportNumber}
        sub={
          <>
            {t(`reportType.${r.reportType}`)} · <Link to={`/jobs/${r.jobId}`}>{r.jobNumber}</Link>
            {r.clientName ? ` · ${r.clientName}` : ''}
          </>
        }
        actions={
          <>
            {can('report.preview') && (
              <Button variant="secondary" onClick={() => openPdf(`/reports/${r.id}/preview`)}>
                {t('reports.preview')}
              </Button>
            )}
            {r.status === 'issued' && can('report.download') && (
              <Button
                onClick={() => downloadFile(`/reports/${r.id}/file`, `${r.reportNumber}-r${r.version}.pdf`)}
              >
                ⤓ {t('reports.download')}
              </Button>
            )}
          </>
        }
      />

      <div className="job-head">
        <DocumentStatusBadge status={r.status} />
        <Badge tone="neutral">
          {t('reports.version')} {r.version}
        </Badge>
        <Badge tone="neutral">{r.language?.toUpperCase()}</Badge>
        {r.templateName ? <span className="muted">{r.templateName}</span> : null}
      </div>

      {version?.reviewComment && r.status === 'changes_requested' && (
        <Alert tone="warning">{t('reports.changesRequested', { reason: version.reviewComment })}</Alert>
      )}
      {r.status === 'issued' && (
        <Alert tone="success">
          {t('reports.issuedOn', { name: r.issuedByName ?? '—', at: fmt(r.issuedAt, false) })}
        </Alert>
      )}
      {r.status === 'cancelled' && <Alert tone="danger">{r.cancelReason}</Alert>}
      <ErrorBox error={act.error ?? save.error} />

      {move && (
        <Card title={t(`reportAction.${move}`)}>
          <div className="form-grid">
            <div className="form-grid__wide">
              <Field
                label={move === 'review' ? t('reports.reviewComment') : t('sample.reason')}
                hint={move === 'revise' ? t('reports.reviseHint') : undefined}
              >
                <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </Field>
            </div>
          </div>
          <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              loading={act.isPending}
              disabled={REPORT_ACTIONS_NEEDING_REASON.includes(move) && reason.trim().length < 3}
              onClick={submitMove}
            >
              {t(`reportAction.${move}`)}
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
            onClick={() => setParams(x.key === 'overview' ? {} : { tab: x.key }, { replace: true })}
          >
            {x.label}
            {x.count && x.count > 1 ? <span className="tab__count">{x.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <Card title={t('job.details')}>
          <dl className="detail-grid">
            <Detail label={t('reports.number')} value={r.reportNumber} />
            <Detail label={t('reports.type')} value={t(`reportType.${r.reportType}`)} />
            <Detail label={t('reports.title')} value={r.title} />
            <Detail label={t('reports.language')} value={r.language?.toUpperCase()} />
            <Detail label={t('reports.template')} value={r.templateName ?? r.templateCode} />
            <Detail label={t('jobs.client')} value={r.clientName} />
            <Detail label={t('reports.job')} value={r.jobNumber} />
            <Detail label={t('reports.preparedBy')} value={r.preparedByName} />
            <Detail label={t('reports.preparedAt')} value={fmt(r.preparedAt)} />
            <Detail label={t('reports.submittedAt')} value={fmt(r.submittedAt)} />
            <Detail
              label={t('reports.reviewedBy')}
              value={r.reviewedBy ? `${r.reviewedByName ?? '—'} · ${fmt(r.reviewedAt)}` : null}
            />
            <Detail
              label={t('reports.approvedBy')}
              value={r.approvedBy ? `${r.approvedByName ?? '—'} · ${fmt(r.approvedAt)}` : null}
            />
            <Detail
              label={t('reports.issuedBy')}
              value={r.issuedBy ? `${r.issuedByName ?? '—'} · ${fmt(r.issuedAt)}` : null}
            />
            <Detail label={t('verify.checksum')} value={r.pdfSha256 ? `${r.pdfSha256.slice(0, 16)}…` : null} />
          </dl>
        </Card>
      )}

      {tab === 'content' && (
        <Card
          title={t('reports.content')}
          actions={
            editable ? (
              <Button loading={save.isPending} onClick={() => save.mutate()}>
                {t('common.save')}
                {dirty ? ' •' : ''}
              </Button>
            ) : null
          }
        >
          {!editable && <p className="muted">{t('reports.readOnly')}</p>}
          <div className="stack">
            <Field label={t('reports.executiveSummary')}>
              <TextArea
                rows={3}
                disabled={!editable}
                value={draft.executiveSummary ?? ''}
                onChange={set('executiveSummary')}
              />
            </Field>
            <Field label={t('reports.observations')}>
              <TextArea rows={4} disabled={!editable} value={draft.observations ?? ''} onChange={set('observations')} />
            </Field>
            <Field label={t('reports.conclusions')}>
              <TextArea rows={3} disabled={!editable} value={draft.conclusions ?? ''} onChange={set('conclusions')} />
            </Field>
            <Field label={t('reports.recommendations')}>
              <TextArea
                rows={3}
                disabled={!editable}
                value={draft.recommendations ?? ''}
                onChange={set('recommendations')}
              />
            </Field>

            <h3 className="section-title">{t('reports.photos')}</h3>
            <p className="muted">{t('reports.photosHint')}</p>
            {sources.isLoading ? (
              <Loading />
            ) : !sources.data?.photos.length ? (
              <EmptyState>{t('reports.noPhotos')}</EmptyState>
            ) : (
              <div className="photos">
                {sources.data.photos.map((p) => {
                  const chosen = (draft.photoIds ?? []).includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`photo photo--lg${chosen ? ' photo--chosen' : ''}`}
                      disabled={!editable}
                      onClick={() => togglePhoto(p.id)}
                    >
                      <div className="photo__doc">{chosen ? '✓' : ''}</div>
                      <div className="photo__cap">
                        {p.caption || p.category || '—'} · {fmt(p.takenAt, false)}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {tab === 'sources' && (
        <Card title={t('reports.dataSources')}>
          <p className="muted">{t('reports.dataSourcesHint')}</p>
          <ErrorBox error={sources.error} />
          {sources.isLoading ? (
            <Loading />
          ) : !sources.data ? null : (
            <div className="stack">
              <h3 className="section-title">{t('inspections.title')}</h3>
              {!sources.data.inspections.length ? (
                <EmptyState>{t('reports.none')}</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('inspections.number')}</th>
                      <th>{t('jobs.type')}</th>
                      <th>{t('jobs.status')}</th>
                      <th>{t('inspection.actualStart')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.data.inspections.map((x) => (
                      <tr key={x.id}>
                        <td className="mono">{x.inspectionNumber}</td>
                        <td>{x.type}</td>
                        <td>{x.status}</td>
                        <td>{fmt(x.actualStart)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}

              <h3 className="section-title">{t('samples.title')}</h3>
              {!sources.data.samples.length ? (
                <EmptyState>{t('reports.none')}</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('samples.number')}</th>
                      <th>{t('jobs.commodity')}</th>
                      <th>{t('sample.seal')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.data.samples.map((x) => (
                      <tr key={x.id}>
                        <td className="mono">{x.sampleNumber}</td>
                        <td>{x.commodity ?? '—'}</td>
                        <td className="mono">{x.sealNumber ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}

              <h3 className="section-title">{t('reports.releasedResults')}</h3>
              <p className="muted">{t('reports.releasedOnly')}</p>
              {!sources.data.results.length ? (
                <EmptyState>{t('reports.noResults')}</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('samples.number')}</th>
                      <th>{t('lab.test')}</th>
                      <th>{t('lab.value')}</th>
                      <th>{t('lab.specification')}</th>
                      <th>{t('lab.method')}</th>
                      <th>{t('lab.revision')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.data.results.map((x) => (
                      <tr key={x.resultId}>
                        <td className="mono">{x.sampleNumber}</td>
                        <td>{localize(x.testName, i18n.language)}</td>
                        <td className="mono">
                          <strong>{x.value}</strong> {x.unit ?? ''}
                        </td>
                        <td className="mono">{x.specification ?? '—'}</td>
                        <td className="mono">
                          {x.methodCode} v{x.methodVersion}
                        </td>
                        <td className="num">{x.revision}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'versions' && (
        <Card title={t('reports.versions')}>
          <p className="muted">{t('reports.versionsNotice')}</p>
          <ErrorBox error={versions.error} />
          {versions.isLoading ? (
            <Loading />
          ) : !versions.data?.length ? (
            <EmptyState>{t('reports.none')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('reports.version')}</th>
                  <th>{t('jobs.status')}</th>
                  <th>{t('reports.preparedBy')}</th>
                  <th>{t('reports.approvedBy')}</th>
                  <th>{t('reports.issued')}</th>
                  <th>{t('reports.reason')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.data.map((v) => (
                  <tr key={v.id} className={v.versionNumber === r.version ? '' : 'row--superseded'}>
                    <td className="num">
                      {v.versionNumber}
                      {v.isLegacy ? <Badge tone="neutral">{t('reports.legacy')}</Badge> : null}
                    </td>
                    <td>
                      <DocumentStatusBadge status={v.status} />
                    </td>
                    <td>{v.preparedByName ?? '—'}</td>
                    <td>{v.approvedByName ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{v.issuedAt ? fmt(v.issuedAt, false) : '—'}</td>
                    <td className="prewrap">{v.revisionReason ?? '—'}</td>
                    <td>
                      {v.pdfStorageKey && can('report.download') ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            downloadFile(
                              `/reports/${r.id}/file?version=${v.versionNumber}`,
                              `${r.reportNumber}-r${v.versionNumber}.pdf`,
                            )
                          }
                        >
                          ⤓
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
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
            <ReportTimeline history={history.data} />
          )}
        </Card>
      )}

      <ReportActionBar actions={actions} busy={act.isPending} onRun={run} />
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

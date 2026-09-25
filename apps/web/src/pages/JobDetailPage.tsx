import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Button, Card, EmptyState, Select, Table } from '@gsi/ui-kit/react';
import {
  ASSIGNMENT_ROLES,
  AssignmentRole,
  InspectionJob,
  Invoice,
  JobAction,
  JobAssignment,
  JobFinanceSummary,
  JobStatusHistoryEntry,
  Page,
  ReportDocument,
  User,
} from '@gsi/shared-types';
import { api, openPdf } from '../api';
import { useAuth } from '../auth';
import { StatTile } from '../components/charts';
import { JobInspections } from '../components/JobInspections';
import { SamplesOn } from '../components/SamplesOn';
import { LabOnJob } from '../components/LabOn';
import { ACTIONS_NEEDING_REASON, PriorityBadge, StatusTimeline } from '../components/JobBits';
import { ReportsTable } from '../components/ReportsTable';
import { DocumentsCard } from '../components/DocumentsCard';
import { Breadcrumbs, ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

type Tab = 'overview' | 'assignments' | 'inspection' | 'samples' | 'laboratory' | 'reports' | 'finance' | 'documents' | 'history';

/**
 * The job card. Everything about one piece of work, and the only place its status changes —
 * through the actions the workflow says are available, never a free-form status dropdown.
 */
export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [notice, setNotice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignRole, setAssignRole] = useState<AssignmentRole>('inspector');

  const job = useQuery({ queryKey: ['job', id], queryFn: () => api.get<InspectionJob>(`/jobs/${id}`) });
  const assignments = useQuery({
    queryKey: ['assignments', id],
    queryFn: () => api.get<JobAssignment[]>(`/jobs/${id}/assignments`),
  });
  const history = useQuery({
    queryKey: ['job-history', id],
    queryFn: () => api.get<JobStatusHistoryEntry[]>(`/jobs/${id}/history`),
    enabled: can('job.read_history', 'job.read'),
  });
  const reports = useQuery({
    queryKey: ['reports', 'job', id],
    queryFn: () => api.get<Page<ReportDocument>>(`/reports?jobId=${id}&limit=100`),
    enabled: can('report.read'),
  });
  const invoices = useQuery({
    queryKey: ['invoices', 'job', id],
    queryFn: () => api.get<Invoice[]>(`/finance/invoices?jobId=${id}`),
    enabled: can('finance.read') && tab === 'finance',
  });
  const financeSummary = useQuery({
    queryKey: ['job-finance', id],
    queryFn: () => api.get<JobFinanceSummary>(`/finance/jobs/${id}/summary`),
    enabled: can('job.read_finance') && tab === 'finance',
  });
  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: can('job.assign'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['job', id] });
    qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['assignments', id] });
    qc.invalidateQueries({ queryKey: ['job-history', id] });
    qc.invalidateQueries({ queryKey: ['job-inspections', id] });
    qc.invalidateQueries({ queryKey: ['reports'] });
  };

  const transition = useMutation({
    mutationFn: ({ action, reason }: { action: JobAction; reason?: string }) =>
      api.post<{ job: InspectionJob; report?: ReportDocument }>(`/jobs/${id}/transitions`, { action, reason }),
    onSuccess: (res, vars) => {
      refresh();
      if (vars.action === 'approve' && res.report) {
        setNotice(t('job.approvedIssued', { number: res.report.reportNumber }));
      }
    },
  });

  const assign = useMutation({
    mutationFn: () => api.post<JobAssignment[]>(`/jobs/${id}/assignments`, { userId: assignUserId, role: assignRole }),
    onSuccess: () => {
      setAssignUserId('');
      refresh();
    },
  });

  const unassign = useMutation({
    mutationFn: (assignmentId: string) => api.del(`/jobs/${id}/assignments/${assignmentId}`),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () => api.del(`/jobs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate('/jobs');
    },
  });

  if (job.isLoading) return <Loading />;
  if (!job.data) return <ErrorBox error={job.error} />;
  const j = job.data;
  const actions = j.actions ?? [];

  /** A few moves have to be explained; the rest just confirm. */
  function run(action: JobAction) {
    setNotice(null);
    if (ACTIONS_NEEDING_REASON.includes(action)) {
      const reason = window.prompt(t(`jobAction.reasonFor.${action}`));
      if (!reason?.trim()) return;
      transition.mutate({ action, reason });
      return;
    }
    if (action === 'approve' && !window.confirm(t('job.approveConfirm'))) return;
    if (action === 'close' && !window.confirm(t('job.closeConfirm'))) return;
    transition.mutate({ action });
  }

  async function preview() {
    setPreviewError(null);
    try {
      await openPdf(`/jobs/${id}/report-preview`);
    } catch (err) {
      setPreviewError(err);
    }
  }

  const detail = (label: string, value: React.ReactNode) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );

  const assignable = (people.data ?? []).filter(
    (u) => u.branchId === j.branchId && u.isActive && !(assignments.data ?? []).some((a) => a.userId === u.id),
  );

  const tabs: { key: Tab; label: string; show: boolean; count?: number }[] = [
    { key: 'overview', label: t('job.details'), show: true },
    { key: 'assignments', label: t('job.assignments'), show: true, count: assignments.data?.length },
    { key: 'inspection', label: t('inspections.title'), show: can('inspection.read') },
    { key: 'samples', label: t('samples.title'), show: can('sample.read') },
    { key: 'laboratory', label: t('lab.title'), show: can('lab.test.read') },
    { key: 'reports', label: t('job.reports'), show: can('report.read'), count: reports.data?.total },
    { key: 'finance', label: t('nav.invoices'), show: can('finance.read', 'job.read_finance') },
    { key: 'documents', label: t('documents.title'), show: can('document.read') },
    { key: 'history', label: t('job.history'), show: can('job.read_history', 'job.read') },
  ];

  return (
    <div className="stack">
      <Breadcrumbs
        items={[
          { label: t('nav.groups.operations') },
          { label: t('nav.jobs'), to: can('job.read') ? '/jobs' : undefined },
          { label: j.jobNumber },
        ]}
      />
      <PageHead
        title={j.jobNumber}
        sub={`${serviceLabel(j.type)} · ${j.clientName}${j.clientReference ? ` · ${j.clientReference}` : ''}`}
        actions={
          <>
            {actions.map((action) => (
              <Button
                key={action}
                variant={action === 'approve' || action === 'confirm' ? 'primary' : 'secondary'}
                loading={transition.isPending}
                onClick={() => run(action)}
              >
                {t(`jobAction.${action}`)}
              </Button>
            ))}
            {can('report.preview') && ['under_review', 'report_preparation'].includes(j.status) && (
              <Button variant="ghost" onClick={preview}>
                {t('job.previewPdf')}
              </Button>
            )}
            {can('job.update') && ['draft', 'confirmed', 'assigned'].includes(j.status) && (
              <Button variant="ghost" onClick={() => navigate(`/jobs/${j.id}/edit`)}>
                {t('common.edit')}
              </Button>
            )}
            {can('job.archive') && ['draft', 'confirmed', 'cancelled'].includes(j.status) && (
              <Button
                variant="ghost"
                loading={archive.isPending}
                onClick={() => window.confirm(t('job.archiveConfirm')) && archive.mutate()}
              >
                {t('job.archive')}
              </Button>
            )}
          </>
        }
      />

      <div className="job-head">
        <StatusBadge status={j.status} />
        <PriorityBadge priority={j.priority} />
        {j.overdue ? <Badge tone="danger">{t('jobs.overdue')}</Badge> : null}
        {j.statusBeforeHold ? (
          <span className="muted">{t('job.heldFrom', { status: t(`status.${j.statusBeforeHold}`) })}</span>
        ) : null}
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {j.reviewComment && j.status === 'in_progress' && (
        <Alert tone="warning">
          {t('job.reviewComment')}: {j.reviewComment}
        </Alert>
      )}
      <ErrorBox error={transition.error ?? assign.error ?? unassign.error ?? archive.error ?? previewError} />

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
        <>
          <Card title={t('job.details')}>
            <dl className="detail-grid">
              {detail(t('jobs.client'), <Link to={`/clients/${j.clientId}`}>{j.clientName}</Link>)}
              {detail(t('job.contact'), j.clientContactName)}
              {detail(
                t('job.contract'),
                j.contractId ? <Link to={`/clients/${j.clientId}?tab=contracts`}>{j.contractRef}</Link> : j.contractNo,
              )}
              {detail(t('jobs.clientReference'), j.clientReference)}
              {detail(t('jobs.type'), serviceLabel(j.type))}
              {detail(t('jobs.commodity'), j.commodity)}
              {detail(
                t('jobs.volume'),
                j.quantityValue != null ? `${j.quantityValue.toLocaleString()} ${j.quantityUnit}` : j.quantity,
              )}
              {detail(t('jobs.location'), [j.location, j.city].filter(Boolean).join(', '))}
              {detail(t('jobs.vessel'), j.vesselOrObject)}
              {detail(t('job.containerNo'), j.containerNo)}
              {detail(t('job.transportRef'), j.transportRef)}
              {detail(t('common.branch'), j.branchCode)}
              {detail(t('job.requestedDate'), j.requestedDate ? fmt(j.requestedDate) : null)}
              {detail(t('jobs.scheduled'), fmt(j.scheduledAt))}
              {detail(t('jobs.lead'), j.assignedInspectorName)}
              {detail(t('job.createdBy'), j.createdByName)}
              {detail(t('job.createdAt'), fmt(j.createdAt))}
              {detail(t('jobs.updated'), fmt(j.updatedAt))}
            </dl>
            {j.instructions ? (
              <>
                <h3 className="section-title">{t('jobs.instructions')}</h3>
                <p className="prewrap">{j.instructions}</p>
              </>
            ) : null}
            {j.internalNotes ? (
              <>
                <h3 className="section-title">{t('job.internalNotes')}</h3>
                <p className="prewrap muted">{j.internalNotes}</p>
              </>
            ) : null}
          </Card>

          {history.data?.length ? (
            <Card title={t('job.timeline')}>
              <StatusTimeline history={history.data} />
            </Card>
          ) : null}
        </>
      )}

      {tab === 'assignments' && (
        <Card
          title={t('job.assignments')}
          actions={<span className="muted">{t('job.assignmentsHint')}</span>}
        >
          {can('job.assign') && !['approved', 'completed', 'invoiced', 'closed', 'cancelled'].includes(j.status) && (
            <div className="filter-row" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
              <Select value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)}>
                <option value="">{t('job.selectPerson')}</option>
                {assignable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} — {t(`roleNames.${u.role}`)}
                  </option>
                ))}
              </Select>
              <Select value={assignRole} onChange={(e) => setAssignRole(e.target.value as AssignmentRole)}>
                {ASSIGNMENT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`assignmentRole.${r}`)}
                  </option>
                ))}
              </Select>
              <Button disabled={!assignUserId} loading={assign.isPending} onClick={() => assign.mutate()}>
                {t('job.assign')}
              </Button>
            </div>
          )}

          {assignments.isLoading ? (
            <Loading />
          ) : !assignments.data?.length ? (
            <EmptyState>{t('job.noAssignments')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('users.fullName')}</th>
                  <th>{t('job.assignmentRole')}</th>
                  <th>{t('job.assignedAt')}</th>
                  {can('job.assign') && <th style={{ width: 120 }}>{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {assignments.data.map((a) => (
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
                    {can('job.assign') && (
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
      )}

      {tab === 'inspection' && <JobInspections job={j} />}
      {tab === 'samples' && <SamplesOn jobId={j.id} jobStatus={j.status} locationHint={j.location} />}
      {tab === 'laboratory' && <LabOnJob jobId={j.id} />}

      {tab === 'reports' && (
        <Card title={t('job.reports')}>
          <ErrorBox error={reports.error} />
          {reports.isLoading ? (
            <Loading />
          ) : (
            <ReportsTable reports={reports.data?.rows ?? []} emptyText={t('job.noReports')} />
          )}
        </Card>
      )}

      {tab === 'finance' && (
        <>
          {can('job.read_finance') && financeSummary.data && (
            <Card title={t('jobFinance.title')}>
              <div className="kpi-row">
                <StatTile
                  label={t('jobFinance.revenue')}
                  value={`${financeSummary.data.revenueBase.toLocaleString()} ${financeSummary.data.baseCurrency}`}
                />
                <StatTile
                  label={t('jobFinance.costs')}
                  value={`${financeSummary.data.costsBase.toLocaleString()} ${financeSummary.data.baseCurrency}`}
                />
                <StatTile
                  label={t('jobFinance.margin')}
                  value={`${financeSummary.data.marginBase.toLocaleString()} ${financeSummary.data.baseCurrency}`}
                  hint={financeSummary.data.marginPct != null ? `${financeSummary.data.marginPct.toFixed(1)}%` : undefined}
                  tone={financeSummary.data.marginBase >= 0 ? 'positive' : 'negative'}
                />
              </div>
              {financeSummary.data.costLines.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('jobFinance.date')}</th>
                      <th>{t('jobFinance.line')}</th>
                      <th>{t('jobFinance.kind')}</th>
                      <th className="num">{t('jobFinance.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...financeSummary.data.revenueLines, ...financeSummary.data.costLines]
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((l) => (
                        <tr key={l.id}>
                          <td>{fmt(l.date)}</td>
                          <td>{l.description}</td>
                          <td>
                            <Badge tone={l.kind === 'invoice' ? 'success' : 'neutral'}>
                              {t(`jobFinance.kindLabel.${l.kind}`)}
                            </Badge>
                          </td>
                          <td className="num">
                            {l.amount.toLocaleString()} {l.currency}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
          <Card title={t('nav.invoices')}>
          <ErrorBox error={invoices.error} />
          {invoices.isLoading ? (
            <Loading />
          ) : !invoices.data?.length ? (
            <EmptyState>{t('job.noInvoices')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('invoices.number')}</th>
                  <th>{t('invoices.issued')}</th>
                  <th>{t('invoices.total')}</th>
                  <th>{t('invoices.status')}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.data.map((i) => (
                  <tr key={i.id}>
                    <td className="mono">
                      <Link to={`/finance/invoices/${i.id}`}>{i.invoiceNumber}</Link>
                    </td>
                    <td>{fmt(i.issueDate)}</td>
                    <td className="num">
                      {i.amountTotal.toLocaleString()} {i.currency}
                    </td>
                    <td>
                      <Badge tone={i.status === 'paid' ? 'success' : i.daysOverdue ? 'danger' : 'info'}>
                        {t(`invoiceStatus.${i.status}`)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          </Card>
        </>
      )}

      {tab === 'documents' && <DocumentsCard entityType="job" entityId={j.id} />}

      {tab === 'history' && (
        <Card title={t('job.history')}>
          <ErrorBox error={history.error} />
          {history.isLoading ? (
            <Loading />
          ) : !history.data?.length ? (
            <EmptyState>{t('job.noHistory')}</EmptyState>
          ) : (
            <StatusTimeline history={history.data} />
          )}
        </Card>
      )}
    </div>
  );
}

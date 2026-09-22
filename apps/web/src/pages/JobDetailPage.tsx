import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Select } from '@gsi/ui-kit/react';
import { InspectionJob, Report, User } from '@gsi/shared-types';
import { api, openPdf } from '../api';
import { canManage, useAuth } from '../auth';
import { Checklist } from '../components/Checklist';
import { ReportsTable } from '../components/ReportsTable';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [inspectorId, setInspectorId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const job = useQuery({ queryKey: ['job', id], queryFn: () => api.get<InspectionJob>(`/jobs/${id}`) });
  const reports = useQuery({ queryKey: ['reports', 'job', id], queryFn: () => api.get<Report[]>(`/reports?jobId=${id}`) });
  const manager = canManage(user?.role);
  const inspectors = useQuery({
    queryKey: ['users', 'inspector'],
    queryFn: () => api.get<User[]>('/users?role=inspector'),
    enabled: manager,
  });

  const action = useMutation({
    mutationFn: async ({ path, body }: { path: string; body?: unknown }) => api.post<unknown>(`/jobs/${id}/${path}`, body),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['job', id] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['checklist', id] });
      qc.invalidateQueries({ queryKey: ['reports'] });
      if (vars.path === 'approve') {
        const report = (res as { report: Report }).report;
        setNotice(t('job.approvedIssued', { number: report.reportNumber }));
      }
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/jobs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate('/jobs');
    },
  });

  if (job.isLoading) return <Loading />;
  if (!job.data) return <ErrorBox error={job.error} />;
  const j = job.data;

  const isAssignedInspector = user?.role === 'inspector' && j.assignedInspectorId === user.id;
  const canWork = isAssignedInspector || manager;
  const run = (path: string, confirmText?: string, body?: unknown) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setNotice(null);
    action.mutate({ path, body });
  };
  const branchInspectors = (inspectors.data ?? []).filter((u) => u.branchId === j.branchId && u.isActive);

  async function preview() {
    setPreviewError(null);
    try {
      await openPdf(`/jobs/${id}/report-preview`);
    } catch (err) {
      setPreviewError(err);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title={
          <span className="row-actions">
            <span className="mono" style={{ fontSize: 'inherit' }}>{j.jobNumber}</span>
            <StatusBadge status={j.status} />
          </span>
        }
        sub={
          <>
            <Link to={`/clients/${j.clientId}`}>{j.clientName}</Link> · {serviceLabel(j.type)}
          </>
        }
        actions={
          <>
            {canWork && j.status === 'assigned' && (
              <Button loading={action.isPending} onClick={() => run('start')}>
                ▶ {t('job.start')}
              </Button>
            )}
            {canWork && j.status === 'in_progress' && (
              <Button variant="accent" loading={action.isPending} onClick={() => run('submit', t('job.submitConfirm'))}>
                {t('job.submit')}
              </Button>
            )}
            {manager && ['under_review', 'in_progress'].includes(j.status) && (
              <Button variant="secondary" onClick={preview}>
                {t('job.previewPdf')}
              </Button>
            )}
            {manager && j.status === 'under_review' && (
              <>
                <Button
                  variant="secondary"
                  disabled={action.isPending}
                  onClick={() => {
                    const comment = window.prompt(t('job.returnPrompt'));
                    if (comment && comment.trim().length >= 3) run('return', undefined, { comment: comment.trim() });
                  }}
                >
                  ↩ {t('job.return')}
                </Button>
                <Button variant="accent" loading={action.isPending} onClick={() => run('approve', t('job.approveConfirm'))}>
                  ✓ {t('job.approve')}
                </Button>
              </>
            )}
            {manager && !['approved', 'cancelled'].includes(j.status) && (
              <Button variant="secondary" onClick={() => navigate(`/jobs/${j.id}/edit`)}>
                {t('common.edit')}
              </Button>
            )}
            {manager && ['new', 'assigned', 'in_progress'].includes(j.status) && (
              <Button variant="danger" disabled={action.isPending} onClick={() => run('cancel', t('job.cancelConfirm'))}>
                {t('job.cancel')}
              </Button>
            )}
            {manager && ['new', 'assigned'].includes(j.status) && (
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate()}
              >
                {t('common.delete')}
              </Button>
            )}
          </>
        }
      />

      {notice && <Alert tone="success">{notice}</Alert>}
      <ErrorBox error={action.error ?? remove.error ?? previewError} />
      {j.reviewComment && j.status === 'in_progress' && (
        <Alert tone="warning">
          <strong>{t('job.reviewComment')}:</strong> {j.reviewComment}
        </Alert>
      )}

      <div className="two-col">
        <Checklist job={j} />

        <div className="stack">
          <Card title={t('job.details')}>
            <dl className="detail-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div>
                <dt>{t('jobs.location')}</dt>
                <dd>{j.location}</dd>
              </div>
              <div>
                <dt>{t('jobs.vessel')}</dt>
                <dd>{j.vesselOrObject ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('jobs.commodity')}</dt>
                <dd>{j.commodity ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('jobs.quantity')}</dt>
                <dd>{j.quantity ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('jobs.scheduled')}</dt>
                <dd>{fmt(j.scheduledAt)}</dd>
              </div>
              <div>
                <dt>{t('jobs.inspector')}</dt>
                <dd>{j.assignedInspectorName ?? t('jobs.unassigned')}</dd>
              </div>
              {j.instructions && (
                <div>
                  <dt>{t('jobs.instructions')}</dt>
                  <dd style={{ whiteSpace: 'pre-wrap', fontWeight: 400 }}>{j.instructions}</dd>
                </div>
              )}
            </dl>

            {manager && ['new', 'assigned', 'in_progress'].includes(j.status) && (
              <div className="row-actions" style={{ marginTop: 16 }}>
                <Select value={inspectorId} onChange={(e) => setInspectorId(e.target.value)} style={{ flex: 1 }}>
                  <option value="">{t('job.selectInspector')}</option>
                  {branchInspectors.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  disabled={!inspectorId || action.isPending}
                  onClick={() => {
                    run('assign', undefined, { inspectorId });
                    setInspectorId('');
                  }}
                >
                  {t('job.assign')}
                </Button>
              </div>
            )}
          </Card>

          <Card title={t('job.reports')}>
            <ErrorBox error={reports.error} />
            <ReportsTable reports={reports.data ?? []} showJob={false} emptyText={t('job.noReports')} />
          </Card>
        </div>
      </div>
    </div>
  );
}

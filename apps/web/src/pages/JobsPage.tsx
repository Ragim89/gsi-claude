import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import { InspectionJob, JOB_STATUSES, JobStatus } from '@gsi/shared-types';
import { api } from '../api';
import { canManage, useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

export function JobsPage() {
  const { t } = useTranslation();
  const { user, isHq } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [search, setSearch] = useState('');

  const { branchId, current } = useBranch();
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);

  const jobs = useQuery({
    queryKey: ['jobs', status, search.trim(), branchId],
    queryFn: () => api.get<InspectionJob[]>(`/jobs?${params}`),
  });

  const isInspector = user?.role === 'inspector';

  return (
    <>
      <PageHead
        title={isInspector ? t('jobs.myTitle') : t('jobs.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={
          canManage(user?.role) && (
            <Button onClick={() => navigate('/jobs/new')}>+ {t('jobs.new')}</Button>
          )
        }
      />
      <div className="filters">
        <Input placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | '')}>
          <option value="">{t('jobs.status')}: {t('common.all')}</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        <ErrorBox error={jobs.error} />
        {jobs.isLoading ? (
          <Loading />
        ) : !jobs.data?.length ? (
          <EmptyState>{t('jobs.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('jobs.number')}</th>
                {isHq && <th>{t('common.branch')}</th>}
                <th>{t('jobs.client')}</th>
                <th>{t('jobs.type')}</th>
                <th>{t('jobs.location')}</th>
                <th>{t('jobs.scheduled')}</th>
                {!isInspector && <th>{t('jobs.inspector')}</th>}
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id} className="link-row" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td className="mono">
                    <Link to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>
                      {j.jobNumber}
                    </Link>
                  </td>
                  {isHq && <td>{j.branchCode}</td>}
                  <td>{j.clientName}</td>
                  <td>{serviceLabel(j.type)}</td>
                  <td>
                    {j.location}
                    {j.vesselOrObject ? <div className="muted">{j.vesselOrObject}</div> : null}
                  </td>
                  <td>{fmt(j.scheduledAt)}</td>
                  {!isInspector && <td>{j.assignedInspectorName ?? <span className="muted">{t('jobs.unassigned')}</span>}</td>}
                  <td>
                    <StatusBadge status={j.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

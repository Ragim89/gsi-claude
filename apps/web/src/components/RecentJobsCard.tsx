import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState } from '@gsi/ui-kit/react';
import { InspectionJob, Page } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { StatusBadge, useFormatDate } from './common';

/**
 * Dashboard Visual Upgrade 2.0 — Recent Jobs. The same `/jobs` list endpoint the Jobs screen
 * uses, sorted by last update, limited to five rows — a glance, not a second jobs table.
 */
export function RecentJobsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const { can } = useAuth();

  const jobs = useQuery({
    queryKey: ['dashboard', 'recent-jobs'],
    queryFn: () => api.get<Page<InspectionJob>>('/jobs?sort=updatedAt&dir=desc&limit=5&offset=0'),
    enabled: can('job.read'),
  });

  if (!can('job.read')) return null;
  const rows = jobs.data?.rows ?? [];

  return (
    <Card
      title={t('dashboardHome.recentJobs')}
      actions={
        <button type="button" className="chart-toggle" onClick={() => navigate('/jobs')}>
          {t('dashboardHome.viewAll')}
        </button>
      }
    >
      {rows.length === 0 ? (
        <EmptyState>{t('jobs.empty')}</EmptyState>
      ) : (
        <ul className="feed-list">
          {rows.map((j) => (
            <li key={j.id} className="feed-list__row">
              <button type="button" className="feed-list__link" onClick={() => navigate(`/jobs/${j.id}`)}>
                <span className="feed-list__text">
                  <span className="feed-list__title">
                    {j.jobNumber} <span className="muted">· {j.clientName}</span>
                  </span>
                  <span className="feed-list__time">{fmt(j.updatedAt)}</span>
                </span>
                <StatusBadge status={j.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

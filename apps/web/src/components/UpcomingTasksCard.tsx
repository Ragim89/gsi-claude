import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState } from '@gsi/ui-kit/react';
import { Inspection, Page, ReportDocument } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { useFormatDate } from './common';
import { IconClipboardCheck, IconDocument } from './icons';

/**
 * Dashboard Visual Upgrade 2.0 — Upcoming Tasks.
 *
 * Built only from data the app already exposes through the same list endpoints as the
 * Inspections and Reports screens (`/inspections?status=scheduled…`, `/reports?status=
 * under_review…`), so there is no new analytics mechanism and nothing here is fabricated.
 * Each section is gated by the same permission its own screen requires, and drops out
 * silently when the viewer cannot see it.
 */
export function UpcomingTasksCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const { can } = useAuth();

  const canInspections = can('inspection.read');
  const canReports = can('report.read');

  const inspectionsQ = useQuery({
    queryKey: ['dashboard', 'upcoming-inspections'],
    queryFn: () =>
      api.get<Page<Inspection>>('/inspections?status=scheduled&sort=scheduledStart&dir=asc&limit=5&offset=0'),
    enabled: canInspections,
  });
  const reportsQ = useQuery({
    queryKey: ['dashboard', 'upcoming-reports'],
    queryFn: () => api.get<Page<ReportDocument>>('/reports?status=under_review&sort=createdAt&dir=asc&limit=5&offset=0'),
    enabled: canReports,
  });

  const inspectionRows = inspectionsQ.data?.rows ?? [];
  const reportRows = reportsQ.data?.rows ?? [];
  const hasAny = inspectionRows.length > 0 || reportRows.length > 0;

  return (
    <Card title={t('dashboardHome.upcomingTasks')}>
      {!hasAny ? (
        <EmptyState>{t('dashboardHome.upcomingTasksEmpty')}</EmptyState>
      ) : (
        <ul className="feed-list">
          {inspectionRows.map((x) => (
            <li key={`ins-${x.id}`} className="feed-list__row">
              <button type="button" className="feed-list__link" onClick={() => navigate(`/inspections/${x.id}`)}>
                <span className="feed-list__icon feed-list__icon--cyan">
                  <IconClipboardCheck />
                </span>
                <span className="feed-list__text">
                  <span className="feed-list__title">{t('dashboardHome.inspectionDue', { number: x.inspectionNumber })}</span>
                  <span className="feed-list__time">{fmt(x.scheduledStart)}</span>
                </span>
              </button>
            </li>
          ))}
          {reportRows.map((r) => (
            <li key={`rep-${r.id}`} className="feed-list__row">
              <button type="button" className="feed-list__link" onClick={() => navigate(`/reports/${r.id}`)}>
                <span className="feed-list__icon feed-list__icon--purple">
                  <IconDocument />
                </span>
                <span className="feed-list__text">
                  <span className="feed-list__title">{t('dashboardHome.reportReview', { number: r.reportNumber })}</span>
                  <span className="feed-list__time">{fmt(r.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState } from '@gsi/ui-kit/react';
import { NotificationList, NotificationType } from '@gsi/shared-types';
import { api } from '../api';
import { useFormatDate } from './common';
import { IconBanknote, IconBriefcase, IconClipboardCheck, IconDocument, IconFlask } from './icons';

const ENTITY_ROUTE: Record<string, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  inspection: (id) => `/inspections/${id}`,
  sample: (id) => `/samples/${id}`,
  report: (id) => `/reports/${id}`,
  invoice: (id) => `/finance/invoices/${id}`,
};

const TYPE_ICON: Record<NotificationType, JSX.Element> = {
  'job.assigned': <IconBriefcase />,
  'inspection.due': <IconClipboardCheck />,
  'sample.received': <IconFlask />,
  'lab_result.awaiting_review': <IconFlask />,
  'report.awaiting_review': <IconDocument />,
  'report.awaiting_issue': <IconDocument />,
  'report.issued': <IconDocument />,
  'invoice.overdue': <IconBanknote />,
};

/**
 * Dashboard Visual Upgrade 2.0 — Recent Activity.
 *
 * Reuses the same `/notifications` query the topbar bell already uses (see NotificationBell.tsx)
 * under the same query key, so this is a second view of one feed, not a second data mechanism.
 */
export function RecentActivityCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const fmt = useFormatDate();

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationList>('/notifications'),
    refetchInterval: 60_000,
  });

  const items = (notifications.data?.items ?? []).slice(0, 8);

  return (
    <Card title={t('dashboardHome.recentActivity')}>
      {items.length === 0 ? (
        <EmptyState>{t('dashboardHome.recentActivityEmpty')}</EmptyState>
      ) : (
        <ul className="feed-list">
          {items.map((n) => {
            const route = n.entityType ? ENTITY_ROUTE[n.entityType] : undefined;
            const clickable = Boolean(route && n.entityId);
            return (
              <li key={n.id} className={`feed-list__row${n.readAt ? '' : ' feed-list__row--unread'}`}>
                <button
                  type="button"
                  className="feed-list__link"
                  disabled={!clickable}
                  onClick={() => clickable && navigate(route!(n.entityId!))}
                >
                  <span className="feed-list__icon">{TYPE_ICON[n.type] ?? <IconDocument />}</span>
                  <span className="feed-list__text">
                    <span className="feed-list__title">{n.title}</span>
                    <span className="feed-list__time">{fmt(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { NotificationList, NotificationRecord } from '@gsi/shared-types';
import { api, subscribeNotifications } from '../api';
import { useFormatDate } from './common';

const ENTITY_ROUTE: Record<string, (id: string) => string> = {
  job: (id) => `/jobs/${id}`,
  inspection: (id) => `/inspections/${id}`,
  sample: (id) => `/samples/${id}`,
  report: (id) => `/reports/${id}`,
  invoice: (id) => `/finance/invoices/${id}`,
};

/** PHASE 10 — notification centre. Polling is the source of truth; the SSE stream just makes the badge feel live. */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationList>('/notifications'),
    refetchInterval: 60_000,
  });

  useEffect(() => subscribeNotifications(() => qc.invalidateQueries({ queryKey: ['notifications'] })), [qc]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  function open_(n: NotificationRecord) {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    const route = n.entityType && ENTITY_ROUTE[n.entityType];
    if (route && n.entityId) navigate(route(n.entityId));
  }

  const unread = notifications.data?.unreadCount ?? 0;
  const items = notifications.data?.items ?? [];

  return (
    <div className="notif-bell" ref={ref}>
      <button type="button" className="notif-bell__button" onClick={() => setOpen((o) => !o)} aria-label={t('notifications.title')}>
        🔔
        {unread > 0 && <span className="notif-bell__badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-bell__panel">
          <div className="notif-bell__head">
            <strong>{t('notifications.title')}</strong>
            {unread > 0 && (
              <Button size="sm" variant="ghost" onClick={() => markAllRead.mutate()}>
                {t('notifications.markAllRead')}
              </Button>
            )}
          </div>
          {items.length === 0 ? (
            <div style={{ padding: 'var(--gsi-space-4)' }} className="muted">
              {t('notifications.empty')}
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`notif-item${n.readAt ? '' : ' notif-item--unread'}`}
                onClick={() => open_(n)}
              >
                {n.title}
                <span className="notif-item__time">{fmt(n.createdAt)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

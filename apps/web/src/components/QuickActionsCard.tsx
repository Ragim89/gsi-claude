import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@gsi/ui-kit/react';
import { useAuth } from '../auth';
import { IconBriefcase, IconClipboardCheck, IconDocument, IconFlask, IconPlus, IconUpload, IconUsers } from './icons';

interface Action {
  key: string;
  label: string;
  icon: ReactNode;
  to: string;
}

/**
 * Dashboard Visual Upgrade 2.0 — Quick Actions.
 *
 * Purely a set of shortcuts to routes and permissions that already exist (see App.tsx and
 * Layout.tsx's own `can(...)`-gated nav) — no new capability, no new route. Buttons are grouped
 * by the kind of work they shortcut to (ops/HQ, field inspection, laboratory) and each one only
 * appears when the viewer already holds the permission its destination route requires.
 */
export function QuickActionsCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const own = user?.scope === 'own';

  const actions: Action[] = [
    ...(can('job.create') ? [{ key: 'newJob', label: t('dashboardHome.actions.newJob'), icon: <IconPlus />, to: '/jobs/new' }] : []),
    ...(can('client.create')
      ? [{ key: 'newClient', label: t('dashboardHome.actions.newClient'), icon: <IconUsers />, to: '/clients' }]
      : []),
    ...(can('import.run')
      ? [{ key: 'uploadDocument', label: t('dashboardHome.actions.uploadDocument'), icon: <IconUpload />, to: '/import' }]
      : []),
    ...(can('report.read')
      ? [{ key: 'reports', label: t('dashboardHome.actions.reports'), icon: <IconDocument />, to: '/reports' }]
      : []),
    ...(own && can('job.read')
      ? [{ key: 'myJobs', label: t('dashboardHome.actions.myJobs'), icon: <IconBriefcase />, to: '/jobs?mine=true' }]
      : []),
    ...(own && can('inspection.read')
      ? [
          {
            key: 'myInspections',
            label: t('dashboardHome.actions.myInspections'),
            icon: <IconClipboardCheck />,
            to: '/inspections?mine=true',
          },
        ]
      : []),
    ...(own && can('sample.read')
      ? [{ key: 'addSample', label: t('dashboardHome.actions.addSample'), icon: <IconFlask />, to: '/samples?mine=true' }]
      : []),
    ...(can('lab.test.read')
      ? [{ key: 'labQueue', label: t('dashboardHome.actions.labQueue'), icon: <IconFlask />, to: '/lab' }]
      : []),
  ];

  return (
    <Card title={t('dashboardHome.quickActions')}>
      {actions.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          {t('dashboardHome.quickActionsEmpty')}
        </p>
      ) : (
        <div className="quick-actions">
          {actions.map((a) => (
            <button key={a.key} type="button" className="quick-actions__item" onClick={() => navigate(a.to)}>
              <span className="quick-actions__icon">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

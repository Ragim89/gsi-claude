import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Table } from '@gsi/ui-kit/react';
import { Branch, Role } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { StatTile } from '../components/charts';
import { ErrorBox, Loading, PageHead } from '../components/common';

interface BranchCard extends Branch {
  team: { id: string; fullName: string; role: Role; email: string; isActive: boolean }[];
  stats: {
    clientCount: number;
    jobCount: number;
    openJobCount: number;
    reportCount: number;
    activeUserCount: number;
  };
}

/** One legal entity: requisites, team, workload, and shortcuts into its data. */
export function BranchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { isHq } = useAuth();
  const { setBranchId, branchId } = useBranch();
  const navigate = useNavigate();

  const q = useQuery({ queryKey: ['branch', id], queryFn: () => api.get<BranchCard>(`/branches/${id}`) });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const b = q.data;

  const focus = (path: string) => {
    if (isHq) setBranchId(b.id);
    navigate(path);
  };

  const detail = (label: string, value: string | null | undefined) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );

  return (
    <div className="stack">
      <PageHead
        title={
          <span className="row-actions">
            <span>
              {flag(b.country)} {b.code}
            </span>
            <span className="muted" style={{ fontSize: 16 }}>
              {b.city}
            </span>
            {b.isHq ? <Badge tone="accent">HQ</Badge> : null}
            {isHq && branchId === b.id ? <Badge tone="info">{t('branches.active')}</Badge> : null}
          </span>
        }
        sub={b.legalName}
        actions={
          <>
            {isHq && <Button variant="secondary" onClick={() => setBranchId(b.id)}>{t('branches.focus')}</Button>}
            <Button variant="secondary" onClick={() => focus('/jobs')}>
              {t('nav.jobs')}
            </Button>
            <Button variant="secondary" onClick={() => focus('/clients')}>
              {t('nav.clients')}
            </Button>
            <Button variant="secondary" onClick={() => focus('/finance')}>
              {t('nav.dashboard')}
            </Button>
          </>
        }
      />

      <div className="kpi-row">
        <StatTile label={t('clients.title')} value={String(b.stats.clientCount)} />
        <StatTile label={t('jobs.title')} value={String(b.stats.jobCount)} hint={t('branches.openJobs', { count: b.stats.openJobCount })} />
        <StatTile label={t('dashboard.reportsIssued')} value={String(b.stats.reportCount)} />
        <StatTile label={t('branches.team')} value={String(b.stats.activeUserCount)} hint={t('branches.activeUsers')} />
      </div>

      <div className="two-col">
        <Card title={t('branches.requisites')}>
          <dl className="detail-grid">
            {detail(t('branches.legalName'), b.legalName)}
            {detail(t('clients.address'), b.address)}
            {detail(t('clients.country'), b.country)}
            {detail(t('branches.currency'), b.currency)}
            {detail(t('branches.timezone'), b.timezone)}
            {detail(t('branches.locale'), `${b.locale} (${b.uiLocales.join(', ')})`)}
            {detail(t('clients.contactPhone'), b.phone)}
            {detail(t('clients.contactEmail'), b.email)}
            {detail(t('branches.accreditation'), b.accreditation)}
            {detail(t('branches.template'), b.letterheadTemplateId)}
          </dl>
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
            {t('branches.editHint')}
          </p>
        </Card>

        <Card title={t('branches.team')}>
          {!b.team.length ? (
            <EmptyState>{t('branches.noTeam')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('users.fullName')}</th>
                  <th>{t('users.role')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {b.team.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.fullName}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.email}
                      </div>
                    </td>
                    <td>{t(`roles.${u.role}`)}</td>
                    <td style={{ textAlign: 'end' }}>
                      {u.isActive ? null : <Badge tone="neutral">{t('users.inactive')}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
            <Link to="/users">{t('nav.users')}</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}

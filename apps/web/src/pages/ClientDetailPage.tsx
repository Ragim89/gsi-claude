import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Table } from '@gsi/ui-kit/react';
import { AuditEntry, Client, ClientStatement, InspectionJob, Invoice, Page, ReportDocument } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ClientForm } from '../components/ClientForm';
import { ContactsCard } from '../components/ContactsCard';
import { ContractsCard } from '../components/ContractsCard';
import { ReportsTable } from '../components/ReportsTable';
import { DocumentsCard } from '../components/DocumentsCard';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

type Tab = 'overview' | 'contacts' | 'contracts' | 'jobs' | 'reports' | 'invoices' | 'statement' | 'activity' | 'documents';

/**
 * Client card. Everything the company knows about one counterparty, in the order someone
 * picking up the phone needs it: who to talk to, what has been agreed, what is running, what
 * has been issued and what is owed.
 */
export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';

  const client = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Client>(`/clients/${id}`) });
  const reports = useQuery({
    queryKey: ['reports', 'client', id],
    queryFn: () => api.get<Page<ReportDocument>>(`/reports?clientId=${id}&limit=100`),
    enabled: can('report.read') && tab === 'reports',
  });
  const jobs = useQuery({
    queryKey: ['jobs', 'client', id],
    queryFn: () => api.get<InspectionJob[]>(`/jobs?clientId=${id}`),
    enabled: can('job.read') && (tab === 'jobs' || tab === 'overview'),
  });
  const invoices = useQuery({
    queryKey: ['invoices', 'client', id],
    queryFn: () => api.get<Invoice[]>(`/finance/invoices?clientId=${id}`),
    enabled: can('finance.read') && tab === 'invoices',
  });
  const activity = useQuery({
    queryKey: ['activity', 'client', id],
    queryFn: () => api.get<Page<AuditEntry>>(`/admin/audit?clientId=${id}&limit=50`),
    enabled: can('audit.read') && tab === 'activity',
  });
  const statement = useQuery({
    queryKey: ['client-statement', id],
    queryFn: () => api.get<ClientStatement>(`/finance/clients/${id}/statement`),
    enabled: can('finance.read') && tab === 'statement',
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/clients/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      navigate('/clients');
    },
  });

  if (client.isLoading) return <Loading />;
  if (!client.data) return <ErrorBox error={client.error} />;
  const c = client.data;
  const manager = can('client.update');

  const detail = (label: string, value: string | null | undefined) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );

  const tabs: { key: Tab; label: string; show: boolean; count?: number }[] = [
    { key: 'overview', label: t('clients.info'), show: true },
    { key: 'contacts', label: t('contacts.title'), show: can('client.read') },
    { key: 'contracts', label: t('contracts.title'), show: can('contract.read'), count: c.activeContracts },
    { key: 'jobs', label: t('clients.jobs'), show: can('job.read'), count: c.jobCount },
    { key: 'reports', label: t('clients.reports'), show: can('report.read') },
    { key: 'invoices', label: t('nav.invoices'), show: can('finance.read') },
    { key: 'statement', label: t('statement.title'), show: can('finance.read') },
    { key: 'documents', label: t('documents.title'), show: can('document.read') },
    { key: 'activity', label: t('clients.activity'), show: can('audit.read') },
  ];

  return (
    <div className="stack">
      <PageHead
        title={c.name}
        sub={[c.branchCode, c.gaftaFosfaRef, c.country].filter(Boolean).join(' · ')}
        actions={
          manager &&
          !editing && (
            <>
              {can('job.create') && (
                <Button onClick={() => navigate(`/jobs/new?clientId=${c.id}`)}>+ {t('jobs.new')}</Button>
              )}
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              {can('client.archive') && (
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => window.confirm(t('clients.confirmArchive')) && remove.mutate()}
                >
                  {t('clients.archive')}
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorBox error={remove.error} />

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
        <Card title={t('clients.info')}>
          {editing ? (
            <ClientForm
              client={c}
              onCancel={() => setEditing(false)}
              onSaved={(saved) => {
                qc.setQueryData(['client', id], saved);
                qc.invalidateQueries({ queryKey: ['clients'] });
                setEditing(false);
              }}
            />
          ) : (
            <dl className="detail-grid">
              {detail(t('clients.gafta'), c.gaftaFosfaRef)}
              {detail(t('clients.taxId'), c.taxId)}
              {detail(t('clients.country'), c.country)}
              {detail(t('clients.address'), c.address)}
              {detail(t('contacts.primary'), c.primaryContact ?? c.contactName)}
              {detail(t('clients.contactEmail'), c.contactEmail)}
              {detail(t('clients.contactPhone'), c.contactPhone)}
              {detail(t('clients.notes'), c.notes)}
            </dl>
          )}
        </Card>
      )}

      {tab === 'contacts' && <ContactsCard clientId={c.id} />}
      {tab === 'contracts' && <ContractsCard clientId={c.id} />}

      {tab === 'reports' && (
        <Card title={t('clients.reports')}>
          <ErrorBox error={reports.error} />
          {reports.isLoading ? (
            <Loading />
          ) : (
            <ReportsTable reports={reports.data?.rows ?? []} emptyText={t('clients.noReports')} />
          )}
        </Card>
      )}

      {(tab === 'jobs' || tab === 'overview') && (
        <Card title={`${t('clients.jobs')} (${jobs.data?.length ?? 0})`}>
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
                  <th>{t('jobs.type')}</th>
                  <th>{t('jobs.location')}</th>
                  <th>{t('jobs.scheduled')}</th>
                  <th>{t('jobs.status')}</th>
                </tr>
              </thead>
              <tbody>
                {(tab === 'overview' ? jobs.data.slice(0, 5) : jobs.data).map((j) => (
                  <tr key={j.id}>
                    <td className="mono">
                      <Link to={`/jobs/${j.id}`}>{j.jobNumber}</Link>
                    </td>
                    <td>{serviceLabel(j.type)}</td>
                    <td>{j.location}</td>
                    <td>{fmt(j.scheduledAt)}</td>
                    <td>
                      <StatusBadge status={j.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'invoices' && (
        <Card title={t('nav.invoices')}>
          <ErrorBox error={invoices.error} />
          {invoices.isLoading ? (
            <Loading />
          ) : !invoices.data?.length ? (
            <EmptyState>{t('invoices.empty')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('invoices.number')}</th>
                  <th>{t('invoices.issued')}</th>
                  <th>{t('invoices.due')}</th>
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
                    <td>{i.dueDate ? fmt(i.dueDate) : '—'}</td>
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
      )}

      {tab === 'statement' && (
        <Card
          title={t('statement.title')}
          actions={
            statement.data ? (
              <span className="muted">
                {t('statement.opening')}: {statement.data.openingBalanceBase.toLocaleString()} {statement.data.baseCurrency}
              </span>
            ) : null
          }
        >
          <ErrorBox error={statement.error} />
          {statement.isLoading ? (
            <Loading />
          ) : !statement.data?.entries.length ? (
            <EmptyState>{t('statement.empty')}</EmptyState>
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <th>{t('expenses.date')}</th>
                    <th>{t('statement.reference')}</th>
                    <th className="num">{t('statement.debit')}</th>
                    <th className="num">{t('statement.credit')}</th>
                    <th className="num">{t('statement.balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.data.entries.map((e, i) => (
                    <tr key={`${e.date}-${i}`}>
                      <td>{fmt(e.date, false)}</td>
                      <td>{e.reference}</td>
                      <td className="num">{e.debitBase ? e.debitBase.toLocaleString() : '—'}</td>
                      <td className="num">{e.creditBase ? e.creditBase.toLocaleString() : '—'}</td>
                      <td className="num">
                        <strong>{e.balanceBase.toLocaleString()}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="muted" style={{ marginTop: 8 }}>
                {t('statement.closing')}: <strong>{statement.data.closingBalanceBase.toLocaleString()} {statement.data.baseCurrency}</strong>
              </p>
            </>
          )}
        </Card>
      )}

      {tab === 'documents' && <DocumentsCard entityType="client" entityId={c.id} />}

      {tab === 'activity' && (
        <Card title={t('clients.activity')} actions={<span className="muted">{t('clients.activityHint')}</span>}>
          <ErrorBox error={activity.error} />
          {activity.isLoading ? (
            <Loading />
          ) : !activity.data?.rows.length ? (
            <EmptyState>{t('audit.empty')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>{t('audit.when')}</th>
                  <th style={{ width: 200 }}>{t('audit.who')}</th>
                  <th style={{ width: 170 }}>{t('audit.action')}</th>
                  <th>{t('audit.record')}</th>
                </tr>
              </thead>
              <tbody>
                {activity.data.rows.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{new Date(e.occurredAt).toLocaleString()}</td>
                    <td>{e.userEmail ?? '—'}</td>
                    <td>
                      <Badge tone="info">{e.action}</Badge>
                    </td>
                    <td>
                      {e.entityLabel ?? '—'}
                      {e.entityType ? <span className="muted"> · {e.entityType}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}

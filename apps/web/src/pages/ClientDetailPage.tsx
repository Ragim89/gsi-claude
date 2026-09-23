import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Table } from '@gsi/ui-kit/react';
import { Client, InspectionJob, Report } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ClientForm } from '../components/ClientForm';
import { ReportsTable } from '../components/ReportsTable';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

/** Client card: details, jobs and the list of issued reports with PDF download (MVP-1 step 7). */
export function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [editing, setEditing] = useState(false);

  const client = useQuery({ queryKey: ['client', id], queryFn: () => api.get<Client>(`/clients/${id}`) });
  const reports = useQuery({ queryKey: ['reports', 'client', id], queryFn: () => api.get<Report[]>(`/reports?clientId=${id}`) });
  const jobs = useQuery({ queryKey: ['jobs', 'client', id], queryFn: () => api.get<InspectionJob[]>(`/jobs?clientId=${id}`) });

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
  const manager = can('client.update', 'job.update');

  const detail = (label: string, value: string | null | undefined) => (
    <div>
      <dt>{label}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );

  return (
    <div className="stack">
      <PageHead
        title={c.name}
        sub={[c.branchCode, c.gaftaFosfaRef].filter(Boolean).join(' · ')}
        actions={
          manager &&
          !editing && (
            <>
              <Button onClick={() => navigate(`/jobs/new?clientId=${c.id}`)}>+ {t('jobs.new')}</Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('common.edit')}
              </Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate()}
              >
                {t('common.delete')}
              </Button>
            </>
          )
        }
      />
      <ErrorBox error={remove.error} />

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
            {detail(t('clients.contactName'), c.contactName)}
            {detail(t('clients.contactEmail'), c.contactEmail)}
            {detail(t('clients.contactPhone'), c.contactPhone)}
            {detail(t('clients.notes'), c.notes)}
          </dl>
        )}
      </Card>

      <Card title={`${t('clients.reports')} (${reports.data?.length ?? 0})`}>
        <ErrorBox error={reports.error} />
        {reports.isLoading ? <Loading /> : <ReportsTable reports={reports.data ?? []} emptyText={t('clients.noReports')} />}
      </Card>

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
              {jobs.data.map((j) => (
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
    </div>
  );
}

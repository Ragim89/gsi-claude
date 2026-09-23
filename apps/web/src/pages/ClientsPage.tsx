import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Table } from '@gsi/ui-kit/react';
import { Client } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { ClientForm } from '../components/ClientForm';
import { ExportButton } from '../components/ExportButton';
import { ErrorBox, Loading, PageHead } from '../components/common';

export function ClientsPage() {
  const { t } = useTranslation();
  const { user, isHq, can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const { branchId, current } = useBranch();
  const q = search.trim();
  const params = new URLSearchParams();
  if (q) params.set('search', q);
  if (branchId) params.set('branchId', branchId);
  const clients = useQuery({
    queryKey: ['clients', q, branchId],
    queryFn: () => api.get<Client[]>(`/clients?${params}`),
  });

  return (
    <div className="stack">
      <PageHead
        title={t('clients.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={
          <>
            <ExportButton section="clients" params={branchId ? `branchId=${branchId}` : ''} />
            {can('client.create') && !creating && (
              <Button onClick={() => setCreating(true)}>+ {t('clients.new')}</Button>
            )}
          </>
        }
      />
      {creating && (
        <Card title={t('clients.new')}>
          <ClientForm
            onCancel={() => setCreating(false)}
            onSaved={(c) => {
              qc.invalidateQueries({ queryKey: ['clients'] });
              navigate(`/clients/${c.id}`);
            }}
          />
        </Card>
      )}
      <div className="filters" style={{ marginBottom: 0 }}>
        <Input placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card>
        <ErrorBox error={clients.error} />
        {clients.isLoading ? (
          <Loading />
        ) : !clients.data?.length ? (
          <EmptyState>{t('clients.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('clients.name')}</th>
                {isHq && <th>{t('common.branch')}</th>}
                <th>{t('clients.gafta')}</th>
                <th>{t('clients.country')}</th>
                <th>{t('clients.contactEmail')}</th>
                <th>{t('clients.jobs')}</th>
              </tr>
            </thead>
            <tbody>
              {clients.data.map((c) => (
                <tr key={c.id} className="link-row" onClick={() => navigate(`/clients/${c.id}`)}>
                  <td>
                    <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.name}
                    </Link>
                  </td>
                  {isHq && <td>{c.branchCode}</td>}
                  <td>{c.gaftaFosfaRef ?? '—'}</td>
                  <td>{c.country ?? '—'}</td>
                  <td>{c.contactEmail ?? '—'}</td>
                  <td>{c.jobCount ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

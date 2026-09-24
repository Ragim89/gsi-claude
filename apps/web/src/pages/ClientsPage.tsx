import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Input, Table } from '@gsi/ui-kit/react';
import { Client, Page } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { ClientForm } from '../components/ClientForm';
import { ExportButton } from '../components/ExportButton';
import { Pagination } from '../components/Pagination';
import { ErrorBox, Loading, PageHead } from '../components/common';

const PAGE_SIZE = 50;

export function ClientsPage() {
  const { t } = useTranslation();
  const { isHq, can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const { branchId, current } = useBranch();
  const q = search.trim();

  // Searching or switching office starts from the first page again — staying on page 7 of a
  // list that now has two rows is never what anyone wants.
  useEffect(() => setOffset(0), [q, branchId]);

  const params = new URLSearchParams();
  if (q) params.set('search', q);
  if (branchId) params.set('branchId', branchId);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  const clients = useQuery({
    queryKey: ['clients', q, branchId, offset],
    queryFn: () => api.get<Page<Client>>(`/clients?${params}`),
    placeholderData: (previous) => previous,
  });

  const rows = clients.data?.rows ?? [];

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
        ) : !rows.length ? (
          <EmptyState>{t('clients.empty')}</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>{t('clients.name')}</th>
                  {isHq && <th>{t('common.branch')}</th>}
                  <th>{t('clients.gafta')}</th>
                  <th>{t('clients.country')}</th>
                  <th>{t('contacts.primary')}</th>
                  <th>{t('contracts.active')}</th>
                  <th>{t('clients.jobs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="link-row" onClick={() => navigate(`/clients/${c.id}`)}>
                    <td>
                      <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>
                        {c.name}
                      </Link>
                    </td>
                    {isHq && <td>{c.branchCode}</td>}
                    <td>{c.gaftaFosfaRef ?? '—'}</td>
                    <td>{c.country ?? '—'}</td>
                    <td>{c.primaryContact ?? c.contactName ?? '—'}</td>
                    <td>{c.activeContracts ? <Badge tone="success">{c.activeContracts}</Badge> : '—'}</td>
                    <td>{c.jobCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination
              total={clients.data?.total ?? 0}
              limit={PAGE_SIZE}
              offset={offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>
    </div>
  );
}

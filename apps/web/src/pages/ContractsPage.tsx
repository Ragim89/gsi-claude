import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import { CONTRACT_STATUSES, Contract, ContractStatus, Page } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { CONTRACT_TONE } from '../components/ContractsCard';
import { Pagination } from '../components/Pagination';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

const PAGE_SIZE = 50;

/**
 * Contracts across the group. The default view is the one operations actually needs: what is
 * running now and what runs out soon — a contract that lapses mid-shipment is a problem long
 * before anyone notices it in a client card.
 */
export function ContractsPage() {
  const { t } = useTranslation();
  const { isHq } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const { branchId, current } = useBranch();
  const [status, setStatus] = useState<ContractStatus | ''>('');
  const [expiring, setExpiring] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const q = search.trim();
  useEffect(() => setOffset(0), [q, branchId, status, expiring]);

  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  if (status) params.set('status', status);
  if (expiring) params.set('expiringInDays', expiring);
  if (q) params.set('search', q);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  const contracts = useQuery({
    queryKey: ['contracts', 'list', params.toString()],
    queryFn: () => api.get<Page<Contract>>(`/contracts?${params}`),
    placeholderData: (previous) => previous,
  });

  const rows = contracts.data?.rows ?? [];

  return (
    <div className="stack">
      <PageHead
        title={t('contracts.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : t('contracts.sub')}
      />

      <Card>
        <div className="filter-row">
          <Input placeholder={t('contracts.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select value={status} onChange={(e) => setStatus(e.target.value as ContractStatus | '')}>
            <option value="">{t('contracts.allStatuses')}</option>
            {CONTRACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`contracts.statuses.${s}`)}
              </option>
            ))}
          </Select>
          <Select value={expiring} onChange={(e) => setExpiring(e.target.value)}>
            <option value="">{t('contracts.anyExpiry')}</option>
            <option value="30">{t('contracts.expiringIn', { days: 30 })}</option>
            <option value="60">{t('contracts.expiringIn', { days: 60 })}</option>
            <option value="90">{t('contracts.expiringIn', { days: 90 })}</option>
          </Select>
        </div>
      </Card>

      <Card>
        <ErrorBox error={contracts.error} />
        {contracts.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('contracts.empty')}</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>{t('contracts.number')}</th>
                  <th>{t('clients.name')}</th>
                  {isHq && <th>{t('common.branch')}</th>}
                  <th>{t('contracts.status')}</th>
                  <th>{t('contracts.validity')}</th>
                  <th>{t('contracts.paymentTerms')}</th>
                  <th>{t('clients.jobs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="link-row" onClick={() => navigate(`/clients/${c.clientId}?tab=contracts`)}>
                    <td>
                      <strong>{c.contractNo}</strong>
                      {c.title ? <div className="muted">{c.title}</div> : null}
                    </td>
                    <td>
                      <Link to={`/clients/${c.clientId}`} onClick={(e) => e.stopPropagation()}>
                        {c.clientName}
                      </Link>
                    </td>
                    {isHq && <td>{c.branchCode}</td>}
                    <td>
                      <Badge tone={CONTRACT_TONE[c.status]}>{t(`contracts.statuses.${c.status}`)}</Badge>
                    </td>
                    <td>
                      {c.validFrom ? fmt(c.validFrom) : '—'} — {c.validTo ? fmt(c.validTo) : '∞'}
                      {c.daysToExpiry != null && c.daysToExpiry >= 0 && c.daysToExpiry <= 60 && c.status === 'active' && (
                        <div className="import-msg import-msg--warn">
                          {t('contracts.expiresIn', { days: c.daysToExpiry })}
                        </div>
                      )}
                      {c.daysToExpiry != null && c.daysToExpiry < 0 && (
                        <div className="import-msg import-msg--error">{t('contracts.expiredAgo')}</div>
                      )}
                    </td>
                    <td>{c.paymentTermsDays != null ? t('contracts.days', { days: c.paymentTermsDays }) : '—'}</td>
                    <td>{c.jobCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={contracts.data?.total ?? 0} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

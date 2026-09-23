import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  Commodity,
  InspectionJob,
  JOB_STATUSES,
  JobStatus,
  localize,
  Port,
  SERVICE_TYPES,
  ServiceType,
} from '@gsi/shared-types';
import { api } from '../api';
import { canManage, useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

export function JobsPage() {
  const { t, i18n } = useTranslation();
  const { user, isHq } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const { branchId, current } = useBranch();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [type, setType] = useState<ServiceType | ''>('');
  const [commodityId, setCommodityId] = useState('');
  const [portId, setPortId] = useState('');
  const [contractNo, setContractNo] = useState('');
  const [minQuantity, setMinQuantity] = useState('');
  const [maxQuantity, setMaxQuantity] = useState('');
  const [search, setSearch] = useState('');
  const [more, setMore] = useState(false);

  const commodities = useQuery({ queryKey: ['commodities'], queryFn: () => api.get<Commodity[]>('/reference/commodities'), staleTime: 300_000 });
  const ports = useQuery({ queryKey: ['ports'], queryFn: () => api.get<Port[]>('/reference/ports'), staleTime: 300_000 });

  const params = new URLSearchParams(rangeParams(range));
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (commodityId) params.set('commodityId', commodityId);
  if (portId) params.set('portId', portId);
  if (contractNo.trim()) params.set('contractNo', contractNo.trim());
  if (minQuantity) params.set('minQuantity', minQuantity);
  if (maxQuantity) params.set('maxQuantity', maxQuantity);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);

  const key = params.toString();
  const jobs = useQuery({
    queryKey: ['jobs', key],
    queryFn: () => api.get<InspectionJob[]>(`/jobs?${key}`),
  });

  const isInspector = user?.role === 'inspector';
  const totalVolume = (jobs.data ?? []).reduce((s, j) => s + (j.quantityValue ?? 0), 0);
  const reset = () => {
    setRange({ from: '', to: '' });
    setStatus('');
    setType('');
    setCommodityId('');
    setPortId('');
    setContractNo('');
    setMinQuantity('');
    setMaxQuantity('');
    setSearch('');
  };
  const filtered = Boolean(range.from || range.to || status || type || commodityId || portId || contractNo || minQuantity || maxQuantity || search);

  return (
    <div className="stack">
      <PageHead
        title={isInspector ? t('jobs.myTitle') : t('jobs.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={
          <>
            <ExportButton section="jobs" params={key} />
            {canManage(user?.role) && <Button onClick={() => navigate('/jobs/new')}>+ {t('jobs.new')}</Button>}
          </>
        }
      />

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={commodityId} onChange={(e) => setCommodityId(e.target.value)}>
              <option value="">{t('jobs.commodity')}: {t('common.all')}</option>
              {commodities.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {localize(c.name, i18n.language)}
                </option>
              ))}
            </Select>
            <Select value={portId} onChange={(e) => setPortId(e.target.value)}>
              <option value="">{t('jobs.port')}: {t('common.all')}</option>
              {ports.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {flag(p.country)} {p.name}
                </option>
              ))}
            </Select>
            <Button variant="secondary" onClick={() => setMore((v) => !v)}>
              {more ? t('filters.less') : t('filters.more')}
            </Button>
            {filtered && (
              <Button variant="ghost" onClick={reset}>
                {t('filters.reset')}
              </Button>
            )}
          </div>

          {more && (
            <div className="filter-row">
              <Input
                placeholder={t('jobs.contractNo')}
                value={contractNo}
                onChange={(e) => setContractNo(e.target.value)}
              />
              <Select value={type} onChange={(e) => setType(e.target.value as ServiceType | '')}>
                <option value="">{t('jobs.type')}: {t('common.all')}</option>
                {SERVICE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {serviceLabel(s)}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                min="0"
                placeholder={t('jobs.volumeFrom')}
                value={minQuantity}
                onChange={(e) => setMinQuantity(e.target.value)}
              />
              <Input
                type="number"
                min="0"
                placeholder={t('jobs.volumeTo')}
                value={maxQuantity}
                onChange={(e) => setMaxQuantity(e.target.value)}
              />
            </div>
          )}
        </div>
      </Card>

      <Card
        title={`${t('jobs.found', { count: jobs.data?.length ?? 0 })}`}
        actions={totalVolume > 0 ? <span className="muted">{t('jobs.totalVolume', { value: totalVolume.toLocaleString(i18n.language) })}</span> : undefined}
      >
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
                {isHq && !branchId && <th>{t('common.branch')}</th>}
                <th>{t('jobs.client')}</th>
                <th>{t('jobs.commodity')}</th>
                <th>{t('jobs.volume')}</th>
                <th>{t('jobs.port')}</th>
                <th>{t('jobs.contractNo')}</th>
                <th>{t('jobs.scheduled')}</th>
                {!isInspector && <th>{t('jobs.inspector')}</th>}
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id} className="link-row" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td className="mono">
                    <Link to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>
                      {j.jobNumber}
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>{serviceLabel(j.type)}</div>
                  </td>
                  {isHq && !branchId && <td>{j.branchCode}</td>}
                  <td>{j.clientName}</td>
                  <td>
                    {j.commodityName ? localize(j.commodityName, i18n.language) : j.commodity ?? '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {j.quantityValue != null ? `${j.quantityValue.toLocaleString(i18n.language)} ${j.quantityUnit}` : j.quantity ?? '—'}
                  </td>
                  <td>
                    {j.portName ? (
                      <>
                        {flag(j.portCountry ?? '')} {j.portName}
                      </>
                    ) : (
                      j.location
                    )}
                    {j.vesselOrObject ? <div className="muted" style={{ fontSize: 12 }}>{j.vesselOrObject}</div> : null}
                  </td>
                  <td className="mono">{j.contractNo ?? '—'}</td>
                  <td>{fmt(j.scheduledAt)}</td>
                  {!isInspector && <td>{j.assignedInspectorName ?? <span className="muted">{t('jobs.unassigned')}</span>}</td>}
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

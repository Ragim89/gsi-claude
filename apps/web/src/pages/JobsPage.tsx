import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  Commodity,
  InspectionJob,
  JOB_PRIORITIES,
  JOB_STATUSES,
  JobPriority,
  JobStatus,
  Page,
  Port,
  SERVICE_TYPES,
  ServiceType,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { Pagination } from '../components/Pagination';
import { PriorityBadge } from '../components/JobBits';
import { ErrorBox, Loading, PageHead, StatusBadge, useFormatDate, useServiceLabel } from '../components/common';

const PAGE_SIZE = 50;
type Sort = 'jobNumber' | 'requestedDate' | 'scheduledAt' | 'priority' | 'status' | 'updatedAt';

/**
 * The operations screen. Dense on purpose: this is the table people keep open all day, so it
 * shows what they act on — how urgent, who is on it, where it stands, when it is due — and
 * loads one page at a time rather than the whole year.
 */
export function JobsPage() {
  const { t, i18n } = useTranslation();
  const { user, isHq, can } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const { branchId, current } = useBranch();
  const [urlParams, setUrlParams] = useSearchParams();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [priority, setPriority] = useState<JobPriority | ''>('');
  const [type, setType] = useState<ServiceType | ''>('');
  const [commodityId, setCommodityId] = useState('');
  const [portId, setPortId] = useState('');
  const [contractNo, setContractNo] = useState('');
  const [minQuantity, setMinQuantity] = useState('');
  const [maxQuantity, setMaxQuantity] = useState('');
  const [search, setSearch] = useState('');
  const [more, setMore] = useState(false);
  const [sort, setSort] = useState<Sort>('scheduledAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // "My jobs" is a filter, not a second screen — and it survives a reload in the URL.
  const mine = urlParams.get('mine') === 'true';
  const setMine = (value: boolean) => setUrlParams(value ? { mine: 'true' } : {}, { replace: true });

  const commodities = useQuery({ queryKey: ['commodities'], queryFn: () => api.get<Commodity[]>('/reference/commodities'), staleTime: 300_000 });
  const ports = useQuery({ queryKey: ['ports'], queryFn: () => api.get<Port[]>('/reference/ports'), staleTime: 300_000 });

  const params = new URLSearchParams(rangeParams(range));
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (type) params.set('type', type);
  if (commodityId) params.set('commodityId', commodityId);
  if (portId) params.set('portId', portId);
  if (contractNo.trim()) params.set('contractNo', contractNo.trim());
  if (minQuantity) params.set('minQuantity', minQuantity);
  if (maxQuantity) params.set('maxQuantity', maxQuantity);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);
  if (mine) params.set('mine', 'true');
  const exportParams = params.toString();

  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const key = params.toString();

  // Any change to what is being asked for starts from the first page again.
  useEffect(() => setOffset(0), [status, priority, type, commodityId, portId, contractNo, search, branchId, mine, range.from, range.to, sort, dir]);

  const jobs = useQuery({
    queryKey: ['jobs', key],
    queryFn: () => api.get<Page<InspectionJob>>(`/jobs?${key}`),
    placeholderData: (previous) => previous,
  });

  const rows = jobs.data?.rows ?? [];
  const isInspector = user?.scope === 'own';
  const reset = () => {
    setRange({ from: '', to: '' });
    setStatus('');
    setPriority('');
    setType('');
    setCommodityId('');
    setPortId('');
    setContractNo('');
    setMinQuantity('');
    setMaxQuantity('');
    setSearch('');
  };
  const filtered = Boolean(
    range.from || range.to || status || priority || type || commodityId || portId || contractNo ||
    minQuantity || maxQuantity || search,
  );

  /** Clicking a column header sorts by it, and again reverses it. */
  const sortable = (column: Sort, label: string) => (
    <th
      className="sortable"
      onClick={() => {
        if (sort === column) setDir(dir === 'asc' ? 'desc' : 'asc');
        else {
          setSort(column);
          setDir('desc');
        }
      }}
    >
      {label}
      {sort === column ? <span className="sort-arrow">{dir === 'asc' ? '↑' : '↓'}</span> : null}
    </th>
  );

  return (
    <div className="stack">
      <PageHead
        title={mine || isInspector ? t('jobs.myTitle') : t('jobs.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={
          <>
            {can('export.run') && <ExportButton section="jobs" params={exportParams} />}
            {can('job.create') && <Button onClick={() => navigate('/jobs/new')}>+ {t('jobs.new')}</Button>}
          </>
        }
      />

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="chips">
            <button type="button" className={`chip${!mine ? ' chip--on' : ''}`} onClick={() => setMine(false)}>
              {t('jobs.allJobs')}
            </button>
            <button type="button" className={`chip${mine ? ' chip--on' : ''}`} onClick={() => setMine(true)}>
              {t('jobs.mine')}
            </button>
          </div>

          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('jobs.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value as JobStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={priority} onChange={(e) => setPriority(e.target.value as JobPriority | '')}>
              <option value="">{t('jobs.priority')}: {t('common.all')}</option>
              {JOB_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
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
              <Select value={portId} onChange={(e) => setPortId(e.target.value)}>
                <option value="">{t('jobs.port')}: {t('common.all')}</option>
                {ports.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {flag(p.country)} {p.name}
                  </option>
                ))}
              </Select>
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

      <Card title={t('jobs.found', { count: jobs.data?.total ?? 0 })}>
        <ErrorBox error={jobs.error} />
        {jobs.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('jobs.empty')}</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  {sortable('jobNumber', t('jobs.number'))}
                  {isHq && !branchId && <th>{t('common.branch')}</th>}
                  <th>{t('jobs.client')}</th>
                  <th>{t('jobs.commodity')}</th>
                  <th>{t('jobs.location')}</th>
                  {sortable('scheduledAt', t('jobs.scheduled'))}
                  {!isInspector && <th>{t('jobs.lead')}</th>}
                  {sortable('priority', t('jobs.priority'))}
                  {sortable('status', t('jobs.status'))}
                  {sortable('updatedAt', t('jobs.updated'))}
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => (
                  <tr key={j.id} className="link-row" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td className="mono">
                      <Link to={`/jobs/${j.id}`} onClick={(e) => e.stopPropagation()}>
                        {j.jobNumber}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>{serviceLabel(j.type)}</div>
                    </td>
                    {isHq && !branchId && <td>{j.branchCode}</td>}
                    <td>
                      {j.clientName}
                      {j.clientReference ? <div className="muted" style={{ fontSize: 12 }}>{j.clientReference}</div> : null}
                    </td>
                    <td>{j.commodityName ? localize(j.commodityName, i18n.language) : j.commodity ?? '—'}</td>
                    <td>
                      {j.portName ? (
                        <>
                          {flag(j.portCountry ?? '')} {j.portName}
                        </>
                      ) : (
                        j.location || '—'
                      )}
                      {j.vesselOrObject ? <div className="muted" style={{ fontSize: 12 }}>{j.vesselOrObject}</div> : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {fmt(j.scheduledAt)}
                      {j.overdue ? <div className="import-msg import-msg--error">{t('jobs.overdue')}</div> : null}
                    </td>
                    {!isInspector && (
                      <td>
                        {j.assignedInspectorName ?? <span className="muted">{t('jobs.unassigned')}</span>}
                        {(j.assignees?.length ?? 0) > 1 ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            +{(j.assignees?.length ?? 1) - 1}
                          </div>
                        ) : null}
                      </td>
                    )}
                    <td>
                      <PriorityBadge priority={j.priority} />
                    </td>
                    <td>
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmt(j.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination total={jobs.data?.total ?? 0} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  Client,
  Commodity,
  Laboratory,
  Page,
  SAMPLE_STATUSES,
  SAMPLE_TYPES,
  Sample,
  SampleStatus,
  SampleType,
  User,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { Pagination } from '../components/Pagination';
import { SampleStatusBadge, SealBadge } from '../components/SampleBits';
import { ErrorBox, Loading, PageHead, useFormatDate, useMediaQuery } from '../components/common';

const PAGE_SIZE = 50;
type Sort = 'sampleNumber' | 'sampledAt' | 'status' | 'updatedAt';

/**
 * The samples screen, and a field worker's morning list.
 *
 * The quick filters are the questions people actually ask of samples — what did I take today,
 * what is waiting to be registered, what is still in transit — rather than a second screen for
 * each of them.
 */
type Quick = 'all' | 'today' | 'awaiting_registration' | 'awaiting_dispatch' | 'in_transit' | 'rejected';

export function SamplesPage() {
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const { branchId, current } = useBranch();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [urlParams, setUrlParams] = useSearchParams();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [status, setStatus] = useState<SampleStatus | ''>('');
  const [sampleType, setSampleType] = useState<SampleType | ''>('');
  const [laboratoryId, setLaboratoryId] = useState('');
  const [clientId, setClientId] = useState('');
  const [samplerId, setSamplerId] = useState('');
  const [commodityId, setCommodityId] = useState('');
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('sampledAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const isField = user?.scope === 'own';
  const mine = urlParams.get('mine') === 'true' || (isField && !urlParams.has('mine'));
  const quick = (urlParams.get('view') as Quick) || 'all';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(urlParams);
    next.set(key, value);
    setUrlParams(next, { replace: true });
  };

  const labs = useQuery({
    queryKey: ['laboratories'],
    queryFn: () => api.get<Laboratory[]>('/samples/laboratories'),
    staleTime: 300_000,
  });

  // Only loaded once the extra filters are opened; nobody pays for a list they never see.
  const clients = useQuery({
    queryKey: ['clients', 'filter'],
    queryFn: () => api.get<Page<Client>>('/clients?limit=200'),
    staleTime: 300_000,
    enabled: more && can('client.read'),
  });
  const commodities = useQuery({
    queryKey: ['commodities'],
    queryFn: () => api.get<Commodity[]>('/reference/commodities'),
    staleTime: 300_000,
    enabled: more,
  });
  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    staleTime: 300_000,
    enabled: more && can('user.read'),
  });

  const filtered = Boolean(
    range.from || range.to || status || sampleType || laboratoryId || clientId || samplerId || commodityId || search,
  );
  const reset = () => {
    setRange({ from: '', to: '' });
    setStatus('');
    setSampleType('');
    setLaboratoryId('');
    setClientId('');
    setSamplerId('');
    setCommodityId('');
    setSearch('');
  };

  const params = new URLSearchParams(rangeParams(range));
  if (status) params.set('status', status);
  if (sampleType) params.set('sampleType', sampleType);
  if (laboratoryId) params.set('laboratoryId', laboratoryId);
  if (clientId) params.set('clientId', clientId);
  if (samplerId) params.set('samplerId', samplerId);
  if (commodityId) params.set('commodityId', commodityId);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);
  if (mine) params.set('mine', 'true');

  // The quick views are filters over the same endpoint, not separate screens.
  if (quick === 'today') params.set('from', new Date().toISOString().slice(0, 10));
  if (quick === 'awaiting_registration') params.set('status', 'collected');
  if (quick === 'awaiting_dispatch') params.set('status', 'sealed');
  if (quick === 'in_transit') params.set('status', 'dispatched');
  if (quick === 'rejected') params.set('status', 'rejected_by_lab');

  const exportParams = params.toString();
  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const key = params.toString();

  useEffect(
    () => setOffset(0),
    [status, sampleType, laboratoryId, clientId, samplerId, commodityId, search, branchId, mine, quick,
     range.from, range.to, sort, dir],
  );

  const list = useQuery({
    queryKey: ['samples', key],
    queryFn: () => api.get<Page<Sample>>(`/samples?${key}`),
    placeholderData: (previous) => previous,
  });

  const rows = list.data?.rows ?? [];
  const commodityOf = (s: Sample) =>
    s.commodityName ? localize(s.commodityName, i18n.language) : (s.commodity ?? '—');

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

  const views: Quick[] = ['all', 'today', 'awaiting_registration', 'awaiting_dispatch', 'in_transit', 'rejected'];

  return (
    <div className="stack">
      <PageHead
        title={mine ? t('samples.myTitle') : t('samples.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={can('export.run') ? <ExportButton section="samples" params={exportParams} /> : undefined}
      />

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="chips">
            <button
              type="button"
              className={`chip${!mine ? ' chip--on' : ''}`}
              onClick={() => setParam('mine', 'false')}
            >
              {t('samples.all')}
            </button>
            <button
              type="button"
              className={`chip${mine ? ' chip--on' : ''}`}
              onClick={() => setParam('mine', 'true')}
            >
              {t('samples.mine')}
            </button>
          </div>

          <div className="chips">
            {views.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip${quick === v ? ' chip--on' : ''}`}
                onClick={() => setParam('view', v)}
              >
                {t(`samples.view.${v}`)}
              </button>
            ))}
          </div>

          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('samples.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value as SampleStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {SAMPLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`sampleStatus.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={sampleType} onChange={(e) => setSampleType(e.target.value as SampleType | '')}>
              <option value="">{t('sample.type')}: {t('common.all')}</option>
              {SAMPLE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {t(`sampleType.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={laboratoryId} onChange={(e) => setLaboratoryId(e.target.value)}>
              <option value="">{t('sample.destination')}: {t('common.all')}</option>
              {(labs.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
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
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">{t('jobs.client')}: {t('common.all')}</option>
                {(clients.data?.rows ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Select value={commodityId} onChange={(e) => setCommodityId(e.target.value)}>
                <option value="">{t('jobs.commodity')}: {t('common.all')}</option>
                {(commodities.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {localize(c.name, i18n.language)}
                  </option>
                ))}
              </Select>
              <Select value={samplerId} onChange={(e) => setSamplerId(e.target.value)}>
                <option value="">{t('sample.sampledBy')}: {t('common.all')}</option>
                {(people.data ?? [])
                  .filter((u) => u.isActive)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
              </Select>
            </div>
          )}
        </div>
      </Card>

      <Card title={t('samples.found', { count: list.data?.total ?? 0 })}>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('samples.empty')}</EmptyState>
        ) : (
          <>
            {narrow ? (
              <div className="stack">
                {rows.map((s) => (
                  <Link key={s.id} to={`/samples/${s.id}`} className="ins-card">
                    <div className="ins-card__head">
                      <span className="mono">{s.sampleNumber}</span>
                      <SampleStatusBadge status={s.status} />
                    </div>
                    <div className="ins-card__title">{commodityOf(s)}</div>
                    <div className="muted">
                      {t(`sampleType.${s.sampleType}`)}
                      {s.quantity != null ? ` · ${s.quantity} ${s.unit ?? ''}` : ''}
                    </div>
                    <div className="ins-card__meta">
                      <SealBadge number={s.sealNumber} state={s.sealState} />
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {s.clientName} · {fmt(s.sampledAt)}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    {sortable('sampleNumber', t('samples.number'))}
                    <th>{t('inspections.job')}</th>
                    <th>{t('jobs.client')}</th>
                    <th>{t('jobs.commodity')}</th>
                    <th>{t('inspections.title')}</th>
                    {sortable('sampledAt', t('sample.sampledAt'))}
                    <th>{t('sample.seal')}</th>
                    <th>{t('sample.destination')}</th>
                    <th>{t('sample.custodian')}</th>
                    {sortable('status', t('jobs.status'))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="link-row" onClick={() => navigate(`/samples/${s.id}`)}>
                      <td className="mono">
                        <Link to={`/samples/${s.id}`} onClick={(e) => e.stopPropagation()}>
                          {s.sampleNumber}
                        </Link>
                        <div className="muted" style={{ fontSize: 12 }}>{t(`sampleType.${s.sampleType}`)}</div>
                      </td>
                      <td className="mono">
                        <Link to={`/jobs/${s.jobId}`} onClick={(e) => e.stopPropagation()}>
                          {s.jobNumber}
                        </Link>
                      </td>
                      <td>{s.clientName}</td>
                      <td>
                        {commodityOf(s)}
                        {s.quantity != null ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {s.quantity} {s.unit ?? ''}
                          </div>
                        ) : null}
                      </td>
                      <td className="mono">
                        {s.inspectionId ? (
                          <Link to={`/inspections/${s.inspectionId}`} onClick={(e) => e.stopPropagation()}>
                            {s.inspectionNumber}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.sampledAt)}</td>
                      <td>
                        <SealBadge number={s.sealNumber} state={s.sealState} />
                      </td>
                      <td>{s.destinationLaboratoryName ?? '—'}</td>
                      <td>
                        {s.currentCustodianName ?? s.currentLocation ?? <span className="muted">—</span>}
                      </td>
                      <td>
                        <SampleStatusBadge status={s.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination total={list.data?.total ?? 0} limit={PAGE_SIZE} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

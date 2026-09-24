import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  INSPECTION_STATUSES,
  Inspection,
  InspectionStatus,
  Page,
  SERVICE_TYPES,
  ServiceType,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { Pagination } from '../components/Pagination';
import { ChecklistProgress, InspectionStatusBadge } from '../components/InspectionBits';
import { ErrorBox, Loading, PageHead, useFormatDate, useMediaQuery, useServiceLabel } from '../components/common';

const PAGE_SIZE = 50;
type Sort = 'inspectionNumber' | 'scheduledStart' | 'status' | 'updatedAt';

/**
 * The inspections screen — and, for a field inspector, the first thing they open in the
 * morning. On a phone the table becomes a stack of cards, because ten columns on a quay is
 * nobody's idea of a working tool.
 */
export function InspectionsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const { branchId, current } = useBranch();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [urlParams, setUrlParams] = useSearchParams();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [status, setStatus] = useState<InspectionStatus | ''>('');
  const [type, setType] = useState<ServiceType | ''>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('scheduledStart');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // A field role sees their own work by default; the filter still survives a reload.
  const isField = user?.scope === 'own';
  const mine = urlParams.get('mine') === 'true' || (isField && !urlParams.has('mine'));
  const active = urlParams.get('active') === 'true';
  const setFlag = (key: 'mine' | 'active', value: boolean) => {
    const next = new URLSearchParams(urlParams);
    if (value) next.set(key, 'true');
    else next.set(key, 'false');
    setUrlParams(next, { replace: true });
  };

  const params = new URLSearchParams(rangeParams(range));
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);
  if (mine) params.set('mine', 'true');
  if (active) params.set('active', 'true');
  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const key = params.toString();

  useEffect(() => setOffset(0), [status, type, search, branchId, mine, active, range.from, range.to, sort, dir]);

  const list = useQuery({
    queryKey: ['inspections', key],
    queryFn: () => api.get<Page<Inspection>>(`/inspections?${key}`),
    placeholderData: (previous) => previous,
  });

  const rows = list.data?.rows ?? [];
  const filtered = Boolean(range.from || range.to || status || type || search);
  const reset = () => {
    setRange({ from: '', to: '' });
    setStatus('');
    setType('');
    setSearch('');
  };

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
        title={mine ? t('inspections.myTitle') : t('inspections.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
      />

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="chips">
            <button type="button" className={`chip${!mine ? ' chip--on' : ''}`} onClick={() => setFlag('mine', false)}>
              {t('inspections.all')}
            </button>
            <button type="button" className={`chip${mine ? ' chip--on' : ''}`} onClick={() => setFlag('mine', true)}>
              {t('inspections.mine')}
            </button>
            <button
              type="button"
              className={`chip${active ? ' chip--on' : ''}`}
              onClick={() => setFlag('active', !active)}
            >
              {t('inspections.activeOnly')}
            </button>
          </div>

          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('inspections.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value as InspectionStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {INSPECTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`inspectionStatus.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={type} onChange={(e) => setType(e.target.value as ServiceType | '')}>
              <option value="">{t('jobs.type')}: {t('common.all')}</option>
              {SERVICE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {serviceLabel(s)}
                </option>
              ))}
            </Select>
            {filtered && (
              <button type="button" className="chip" onClick={reset}>
                {t('filters.reset')}
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card title={t('inspections.found', { count: list.data?.total ?? 0 })}>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('inspections.empty')}</EmptyState>
        ) : (
          <>
            {narrow ? (
              <div className="stack">
                {rows.map((x) => (
                  <Link key={x.id} to={`/inspections/${x.id}`} className="ins-card">
                    <div className="ins-card__head">
                      <span className="mono">{x.inspectionNumber}</span>
                      <InspectionStatusBadge status={x.status} />
                    </div>
                    <div className="ins-card__title">{x.clientName}</div>
                    <div className="muted">
                      {serviceLabel(x.type)}
                      {x.location ? ` · ${x.location}` : ''}
                    </div>
                    <div className="ins-card__meta">
                      <span>{fmt(x.scheduledStart)}</span>
                      {x.overdue ? <span className="import-msg import-msg--error">{t('jobs.overdue')}</span> : null}
                    </div>
                    <ChecklistProgress
                      done={x.checklistDone ?? 0}
                      total={x.checklistTotal ?? 0}
                      required={x.requiredRemaining ?? 0}
                    />
                  </Link>
                ))}
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    {sortable('inspectionNumber', t('inspections.number'))}
                    <th>{t('inspections.job')}</th>
                    <th>{t('jobs.client')}</th>
                    <th>{t('jobs.location')}</th>
                    {sortable('scheduledStart', t('inspections.scheduled'))}
                    <th>{t('jobs.lead')}</th>
                    <th>{t('checklist.title')}</th>
                    {sortable('status', t('jobs.status'))}
                    {sortable('updatedAt', t('jobs.updated'))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={x.id} className="link-row" onClick={() => navigate(`/inspections/${x.id}`)}>
                      <td className="mono">
                        <Link to={`/inspections/${x.id}`} onClick={(e) => e.stopPropagation()}>
                          {x.inspectionNumber}
                        </Link>
                        <div className="muted" style={{ fontSize: 12 }}>{serviceLabel(x.type)}</div>
                      </td>
                      <td className="mono">
                        <Link to={`/jobs/${x.jobId}`} onClick={(e) => e.stopPropagation()}>
                          {x.jobNumber}
                        </Link>
                      </td>
                      <td>{x.clientName}</td>
                      <td>{[x.location, x.city].filter(Boolean).join(', ') || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fmt(x.scheduledStart)}
                        {x.overdue ? <div className="import-msg import-msg--error">{t('jobs.overdue')}</div> : null}
                      </td>
                      <td>{x.leadInspectorName ?? <span className="muted">{t('jobs.unassigned')}</span>}</td>
                      <td style={{ minWidth: 140 }}>
                        <ChecklistProgress
                          done={x.checklistDone ?? 0}
                          total={x.checklistTotal ?? 0}
                          required={x.requiredRemaining ?? 0}
                        />
                      </td>
                      <td>
                        <InspectionStatusBadge status={x.status} />
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmt(x.updatedAt)}</td>
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

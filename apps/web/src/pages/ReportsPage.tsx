import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  Client,
  Page,
  REPORT_STATUSES,
  REPORT_TYPES,
  ReportDocument,
  ReportStatus,
  ReportType,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { Pagination } from '../components/Pagination';
import { DocumentStatusBadge } from '../components/ReportBits';
import { ErrorBox, Loading, PageHead, useFormatDate, useMediaQuery } from '../components/common';

const PAGE_SIZE = 50;
type Sort = 'reportNumber' | 'issuedAt' | 'status' | 'createdAt';

/**
 * The document register: everything the group has issued or is still writing.
 *
 * The quick views are the questions people ask of documents — what is waiting for me to check,
 * what is approved but not yet sent, what went out this month — rather than a screen each.
 */
type Quick = 'all' | 'drafts' | 'review' | 'approved' | 'issued' | 'mine';

const VIEWS: Quick[] = ['all', 'drafts', 'review', 'approved', 'issued', 'mine'];

export function ReportsPage() {
  const { t } = useTranslation();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const { branchId, current } = useBranch();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [urlParams, setUrlParams] = useSearchParams();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [reportType, setReportType] = useState<ReportType | ''>('');
  const [status, setStatus] = useState<ReportStatus | ''>('');
  const [language, setLanguage] = useState('');
  const [clientId, setClientId] = useState('');
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('createdAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const quick = (urlParams.get('view') as Quick) || 'all';
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(urlParams);
    next.set(key, value);
    setUrlParams(next, { replace: true });
  };

  const clients = useQuery({
    queryKey: ['clients', 'filter'],
    queryFn: () => api.get<Page<Client>>('/clients?limit=200'),
    staleTime: 300_000,
    enabled: more && can('client.read'),
  });

  const filtered = Boolean(range.from || range.to || reportType || status || language || clientId || search);
  const reset = () => {
    setRange({ from: '', to: '' });
    setReportType('');
    setStatus('');
    setLanguage('');
    setClientId('');
    setSearch('');
  };

  const params = new URLSearchParams(rangeParams(range));
  if (reportType) params.set('reportType', reportType);
  if (status) params.set('status', status);
  if (language) params.set('language', language);
  if (clientId) params.set('clientId', clientId);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);

  if (quick === 'drafts') params.set('status', 'draft');
  if (quick === 'review') params.set('status', 'under_review');
  if (quick === 'approved') params.set('status', 'approved');
  if (quick === 'issued') params.set('status', 'issued');

  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const key = params.toString();

  useEffect(
    () => setOffset(0),
    [reportType, status, language, clientId, search, branchId, quick, range.from, range.to, sort, dir],
  );

  const list = useQuery({
    queryKey: ['reports', key],
    queryFn: () => api.get<Page<ReportDocument>>(`/reports?${key}`),
    placeholderData: (previous) => previous,
  });

  const rows = (list.data?.rows ?? []).filter((r) => (quick === 'mine' ? r.preparedBy === user?.id : true));

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
        title={t('reports.registerTitle')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : t('reports.registerSub')}
        actions={
          can('report.create') ? (
            <Button onClick={() => navigate('/reports/new')}>+ {t('reports.new')}</Button>
          ) : undefined
        }
      />

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="chips">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip${quick === v ? ' chip--on' : ''}`}
                onClick={() => setParam('view', v)}
              >
                {t(`reports.view.${v}`)}
              </button>
            ))}
          </div>

          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('reports.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType | '')}>
              <option value="">{t('reports.type')}: {t('common.all')}</option>
              {REPORT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`reportType.${x}`)}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {REPORT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`reportStatus.${s}`)}
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
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">{t('reports.language')}: {t('common.all')}</option>
                <option value="en">English</option>
                <option value="tr">Türkçe</option>
                <option value="ru">Русский</option>
              </Select>
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">{t('jobs.client')}: {t('common.all')}</option>
                {(clients.data?.rows ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </Card>

      <Card title={t('reports.found', { count: list.data?.total ?? 0 })}>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('reports.empty')}</EmptyState>
        ) : (
          <>
            {narrow ? (
              <div className="stack">
                {rows.map((r) => (
                  <Link key={r.id} to={`/reports/${r.id}`} className="ins-card">
                    <div className="ins-card__head">
                      <span className="mono">{r.reportNumber}</span>
                      <DocumentStatusBadge status={r.status} />
                    </div>
                    <div className="ins-card__title">{t(`reportType.${r.reportType}`)}</div>
                    <div className="muted">
                      {r.clientName} · {r.jobNumber}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t('reports.version')} {r.version} · {r.language?.toUpperCase()} ·{' '}
                      {r.issuedAt ? fmt(r.issuedAt, false) : t('reports.notIssued')}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    {sortable('reportNumber', t('reports.number'))}
                    <th>{t('reports.type')}</th>
                    <th>{t('jobs.client')}</th>
                    <th>{t('reports.job')}</th>
                    <th>{t('reports.version')}</th>
                    <th>{t('reports.language')}</th>
                    <th>{t('reports.preparedBy')}</th>
                    {sortable('issuedAt', t('reports.issued'))}
                    {sortable('status', t('jobs.status'))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="link-row" onClick={() => navigate(`/reports/${r.id}`)}>
                      <td className="mono">
                        <Link to={`/reports/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          {r.reportNumber}
                        </Link>
                      </td>
                      <td>{t(`reportType.${r.reportType}`)}</td>
                      <td>{r.clientName ?? '—'}</td>
                      <td className="mono">
                        <Link to={`/jobs/${r.jobId}`} onClick={(e) => e.stopPropagation()}>
                          {r.jobNumber}
                        </Link>
                      </td>
                      <td className="num">
                        {r.version}
                        {(r.versionCount ?? 1) > 1 ? (
                          <Badge tone="neutral">{r.versionCount}</Badge>
                        ) : null}
                      </td>
                      <td>{r.language?.toUpperCase()}</td>
                      <td>{r.preparedByName ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{r.issuedAt ? fmt(r.issuedAt, false) : '—'}</td>
                      <td>
                        <DocumentStatusBadge status={r.status} />
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

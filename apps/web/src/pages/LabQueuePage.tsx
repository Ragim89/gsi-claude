import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  Commodity,
  JOB_PRIORITIES,
  JobPriority,
  LabDashboard,
  LabTest,
  Laboratory,
  Page,
  TEST_REQUEST_STATUSES,
  TestRequest,
  TestRequestStatus,
  User,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { Pagination } from '../components/Pagination';
import { EvaluationBadge, ResultValue, TestStatusBadge, useTestName } from '../components/LabBits';
import { ErrorBox, Loading, PageHead, useFormatDate, useMediaQuery } from '../components/common';

const PAGE_SIZE = 50;
type Sort = 'requestedAt' | 'dueAt' | 'priority' | 'status' | 'updatedAt';

/**
 * The laboratory work queue, which is the screen the laboratory lives on all day.
 *
 * The tiles across the top are the same rows counted by status, so clicking one filters the
 * list beneath rather than opening a different screen with a different idea of the truth.
 */
type Quick = 'all' | 'unassigned' | 'in_progress' | 'awaiting_review' | 'awaiting_approval' | 'awaiting_release'
  | 'overdue' | 'out_of_spec';

const QUICK_VIEWS: Quick[] = [
  'all', 'unassigned', 'in_progress', 'awaiting_review', 'awaiting_approval', 'awaiting_release',
  'overdue', 'out_of_spec',
];

/** Each tile is a count and the view that shows exactly those rows. */
const TILES: Array<{ key: keyof LabDashboard; view: Quick }> = [
  { key: 'unassigned', view: 'unassigned' },
  { key: 'inProgress', view: 'in_progress' },
  { key: 'awaitingReview', view: 'awaiting_review' },
  { key: 'awaitingApproval', view: 'awaiting_approval' },
  { key: 'awaitingRelease', view: 'awaiting_release' },
  { key: 'overdue', view: 'overdue' },
  { key: 'outOfSpec', view: 'out_of_spec' },
];

export function LabQueuePage() {
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const nameOf = useTestName();
  const { branchId, current } = useBranch();
  const narrow = useMediaQuery('(max-width: 720px)');
  const [urlParams, setUrlParams] = useSearchParams();

  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [status, setStatus] = useState<TestRequestStatus | ''>('');
  const [priority, setPriority] = useState<JobPriority | ''>('');
  const [laboratoryId, setLaboratoryId] = useState('');
  const [labTestId, setLabTestId] = useState('');
  const [analystId, setAnalystId] = useState('');
  const [commodityId, setCommodityId] = useState('');
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('requestedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // An analyst opens their own bench; a laboratory manager opens the whole queue.
  const canEnter = can('lab.result.enter');
  const mine = urlParams.get('mine') === 'true' || (canEnter && !can('lab.test.assign') && !urlParams.has('mine'));
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
  const tests = useQuery({
    queryKey: ['lab-tests'],
    queryFn: () => api.get<LabTest[]>('/lab/tests'),
    staleTime: 300_000,
    enabled: can('lab.method.read'),
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
    range.from || range.to || status || priority || laboratoryId || labTestId || analystId || commodityId || search,
  );
  const reset = () => {
    setRange({ from: '', to: '' });
    setStatus('');
    setPriority('');
    setLaboratoryId('');
    setLabTestId('');
    setAnalystId('');
    setCommodityId('');
    setSearch('');
  };

  const params = new URLSearchParams(rangeParams(range));
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (laboratoryId) params.set('laboratoryId', laboratoryId);
  if (labTestId) params.set('labTestId', labTestId);
  if (analystId) params.set('analystId', analystId);
  if (commodityId) params.set('commodityId', commodityId);
  if (search.trim()) params.set('search', search.trim());
  if (branchId) params.set('branchId', branchId);
  if (mine) params.set('mine', 'true');

  // The quick views are filters over the same endpoint, not separate screens.
  if (quick === 'unassigned') params.set('unassigned', 'true');
  if (quick === 'in_progress') params.set('status', 'in_progress');
  // Both piles are `under_review`; the technical review is what tells them apart.
  if (quick === 'awaiting_review') {
    params.set('status', 'under_review');
    params.set('reviewed', 'false');
  }
  if (quick === 'awaiting_approval') {
    params.set('status', 'under_review');
    params.set('reviewed', 'true');
  }
  if (quick === 'awaiting_release') params.set('status', 'approved');
  if (quick === 'overdue') params.set('overdue', 'true');
  if (quick === 'out_of_spec') params.set('outOfSpec', 'true');

  const exportParams = params.toString();
  params.set('sort', sort);
  params.set('dir', dir);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));
  const key = params.toString();

  useEffect(
    () => setOffset(0),
    [status, priority, laboratoryId, labTestId, analystId, commodityId, search, branchId, mine, quick,
     range.from, range.to, sort, dir],
  );

  // The tiles answer with the same office, laboratory and bench the list is looking at:
  // a count nobody can reproduce by clicking it is worse than no count.
  const scope = new URLSearchParams();
  if (laboratoryId) scope.set('laboratoryId', laboratoryId);
  if (branchId) scope.set('branchId', branchId);
  if (mine) scope.set('mine', 'true');
  const scopeKey = scope.toString();

  const dashboard = useQuery({
    queryKey: ['lab-dashboard', scopeKey],
    queryFn: () => api.get<LabDashboard>(`/lab/dashboard?${scopeKey}`),
  });

  const list = useQuery({
    queryKey: ['lab-requests', key],
    queryFn: () => api.get<Page<TestRequest>>(`/lab/requests?${key}`),
    placeholderData: (previous) => previous,
  });

  const rows = list.data?.rows ?? [];

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
        title={mine ? t('lab.myTitle') : t('lab.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : t('lab.sub')}
        actions={can('export.run') ? <ExportButton section="lab_requests" params={exportParams} /> : undefined}
      />

      {/* Real counts from the same rows the list shows — nothing here is an estimate. */}
      <div className="kpi-row">
        {TILES.map((tile) => (
          <button
            key={tile.key}
            type="button"
            className={`stat stat--button${quick === tile.view ? ' stat--on' : ''}`}
            onClick={() => setParam('view', quick === tile.view ? 'all' : tile.view)}
          >
            <span className="stat__label">{t(`lab.metric.${tile.key}`)}</span>
            <span className="stat__value">{dashboard.data ? dashboard.data[tile.key] : '—'}</span>
          </button>
        ))}
      </div>

      <Card>
        <div className="stack" style={{ gap: 12 }}>
          {canEnter && (
            <div className="chips">
              <button
                type="button"
                className={`chip${!mine ? ' chip--on' : ''}`}
                onClick={() => setParam('mine', 'false')}
              >
                {t('lab.allWork')}
              </button>
              <button
                type="button"
                className={`chip${mine ? ' chip--on' : ''}`}
                onClick={() => setParam('mine', 'true')}
              >
                {t('lab.mine')}
              </button>
            </div>
          )}

          <div className="chips">
            {QUICK_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                className={`chip${quick === v ? ' chip--on' : ''}`}
                onClick={() => setParam('view', v)}
              >
                {t(`lab.view.${v}`)}
              </button>
            ))}
          </div>

          <DateRangeFilter value={range} onChange={setRange} />

          <div className="filter-row">
            <Input placeholder={t('lab.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <Select value={status} onChange={(e) => setStatus(e.target.value as TestRequestStatus | '')}>
              <option value="">{t('jobs.status')}: {t('common.all')}</option>
              {TEST_REQUEST_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`testStatus.${s}`)}
                </option>
              ))}
            </Select>
            <Select value={labTestId} onChange={(e) => setLabTestId(e.target.value)}>
              <option value="">{t('lab.test')}: {t('common.all')}</option>
              {(tests.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {localize(x.name, i18n.language)}
                </option>
              ))}
            </Select>
            <Select value={laboratoryId} onChange={(e) => setLaboratoryId(e.target.value)}>
              <option value="">{t('lab.laboratory')}: {t('common.all')}</option>
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
                {(commodities.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {localize(c.name, i18n.language)}
                  </option>
                ))}
              </Select>
              <Select value={analystId} onChange={(e) => setAnalystId(e.target.value)}>
                <option value="">{t('lab.analyst')}: {t('common.all')}</option>
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

      <Card title={t('lab.found', { count: list.data?.total ?? 0 })}>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('lab.empty')}</EmptyState>
        ) : (
          <>
            {narrow ? (
              <div className="stack">
                {rows.map((r) => (
                  <Link key={r.id} to={`/lab/requests/${r.id}`} className="ins-card">
                    <div className="ins-card__head">
                      <span className="mono">{r.sampleNumber}</span>
                      <TestStatusBadge status={r.status} />
                    </div>
                    <div className="ins-card__title">{nameOf(r.testName, r.testCode)}</div>
                    <div className="muted">
                      {r.methodCode} v{r.methodVersion} · {r.clientName}
                    </div>
                    <div className="ins-card__meta">
                      <ResultValue result={r.result} />
                      {r.result ? <EvaluationBadge evaluation={r.result.evaluation} /> : null}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.assignedAnalystName ?? t('lab.unassignedShort')}
                      {r.dueAt ? ` · ${t('lab.due')}: ${fmt(r.dueAt)}` : ''}
                      {r.overdue ? ` · ${t('lab.overdue')}` : ''}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>{t('samples.number')}</th>
                    <th>{t('lab.test')}</th>
                    <th>{t('lab.method')}</th>
                    <th>{t('jobs.client')}</th>
                    <th>{t('lab.analyst')}</th>
                    <th>{t('lab.value')}</th>
                    <th>{t('lab.specification')}</th>
                    {sortable('dueAt', t('lab.due'))}
                    {sortable('priority', t('jobs.priority'))}
                    {sortable('status', t('jobs.status'))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="link-row" onClick={() => navigate(`/lab/requests/${r.id}`)}>
                      <td className="mono">
                        <Link to={`/samples/${r.sampleId}`} onClick={(e) => e.stopPropagation()}>
                          {r.sampleNumber}
                        </Link>
                        <div className="muted" style={{ fontSize: 12 }}>{r.jobNumber}</div>
                      </td>
                      <td>
                        <Link to={`/lab/requests/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          {nameOf(r.testName, r.testCode)}
                        </Link>
                      </td>
                      <td className="mono">
                        {r.methodCode}
                        <span className="muted"> v{r.methodVersion}</span>
                      </td>
                      <td>{r.clientName}</td>
                      <td>{r.assignedAnalystName ?? <span className="muted">{t('lab.unassignedShort')}</span>}</td>
                      <td>
                        <ResultValue result={r.result} />
                      </td>
                      <td>{r.result ? <EvaluationBadge evaluation={r.result.evaluation} /> : <span className="muted">—</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fmt(r.dueAt)}
                        {r.overdue ? <div className="muted overdue">{t('lab.overdue')}</div> : null}
                      </td>
                      <td>{t(`priority.${r.priority}`)}</td>
                      <td>
                        <TestStatusBadge status={r.status} />
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

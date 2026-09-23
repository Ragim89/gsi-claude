import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  Asset,
  AssetCategory,
  AssetStatus,
  AssetSummary,
  Branch,
  DepreciationRunResult,
} from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, Columns, LineChart, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

export const ASSET_TONE: Record<AssetStatus, BadgeTone> = {
  in_use: 'success',
  in_repair: 'warning',
  idle: 'neutral',
  disposed: 'neutral',
  written_off: 'danger',
};

/** Company assets: what we own, what it is worth now, what depreciation costs each month. */
export function AssetsPage() {
  const { t, i18n } = useTranslation();
  const { user, isHq } = useAuth();
  const { branchId, current } = useBranch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [category, setCategory] = useState<AssetCategory | ''>('');
  const [status, setStatus] = useState<AssetStatus | ''>('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canWrite = user?.role === 'finance_controller' || user?.role === 'admin';

  const scope = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');
  const listParams = new URLSearchParams();
  if (branchId) listParams.set('branchId', branchId);
  if (category) listParams.set('category', category);
  if (status) listParams.set('status', status);
  if (search.trim()) listParams.set('search', search.trim());

  const summary = useQuery({
    queryKey: ['asset-summary', scope],
    queryFn: () => api.get<AssetSummary>(`/assets/summary?${scope}`),
  });
  const assets = useQuery({
    queryKey: ['assets', listParams.toString()],
    queryFn: () => api.get<Asset[]>(`/assets?${listParams}`),
  });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches'), enabled: isHq });

  const [form, setForm] = useState({
    inventoryNo: '',
    name: '',
    category: 'inspection_equipment' as AssetCategory,
    serialNo: '',
    location: '',
    acquisitionDate: new Date().toISOString().slice(0, 10),
    acquisitionCost: '',
    usefulLifeMonths: '60',
    salvageValue: '',
    branchId: '',
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['assets'] });
    qc.invalidateQueries({ queryKey: ['asset-summary'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Asset>('/assets', {
        inventoryNo: form.inventoryNo.trim(),
        name: form.name.trim(),
        category: form.category,
        serialNo: form.serialNo.trim() || null,
        location: form.location.trim() || null,
        acquisitionDate: form.acquisitionDate,
        acquisitionCost: Number(form.acquisitionCost),
        usefulLifeMonths: form.usefulLifeMonths ? Number(form.usefulLifeMonths) : null,
        salvageValue: form.salvageValue ? Number(form.salvageValue) : 0,
        ...(isHq && form.branchId ? { branchId: form.branchId } : {}),
      }),
    onSuccess: (asset) => {
      invalidate();
      setCreating(false);
      navigate(`/assets/${asset.id}`);
    },
  });

  const run = useMutation({
    mutationFn: () => api.post<DepreciationRunResult>('/assets/depreciation/run', {}),
    onSuccess: (r) => {
      invalidate();
      setNotice(t('assets.runDone', { count: r.assetsProcessed, period: r.period.slice(0, 7) }));
    },
  });

  const s = summary.data;
  const base = useMemo(() => {
    const currency = s?.baseCurrency ?? 'EUR';
    return (v: number) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  }, [s?.baseCurrency, i18n.language]);
  const local = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);

  const catLabel = (key: string) => t(`assetCategories.${key}`);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <div className="stack">
      <PageHead
        title={t('assets.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={
          <>
            <DateRangeFilter value={range} onChange={setRange} />
            <ExportButton section="assets" params={branchId ? `branchId=${branchId}` : ''} />
            {canWrite && (
              <Button variant="secondary" loading={run.isPending} onClick={() => run.mutate()}>
                {t('assets.runDepreciation')}
              </Button>
            )}
            {canWrite && !creating && <Button onClick={() => setCreating(true)}>+ {t('assets.new')}</Button>}
          </>
        }
      />

      {notice && <div className="gsi-alert gsi-alert--success">{notice}</div>}
      <ErrorBox error={summary.error ?? run.error} />

      {summary.isLoading || !s ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-row">
            <StatTile
              label={t('assets.netBookValue')}
              value={base(s.totals.netBookValueBase)}
              hint={t('assets.ofCost', { amount: base(s.totals.acquisitionCostBase) })}
            />
            <StatTile label={t('assets.count')} value={String(s.totals.count)} hint={t('assets.inUse', { count: s.totals.inUse })} />
            <StatTile label={t('assets.accumulated')} value={base(s.totals.accumulatedBase)} />
            <StatTile
              label={t('assets.monthlyCharge')}
              value={base(s.totals.monthlyDepreciationBase)}
              hint={t('assets.periodCharge', { amount: base(s.totals.periodDepreciationBase) })}
            />
            <StatTile
              label={t('assets.fullyDepreciated')}
              value={String(s.totals.fullyDepreciated)}
              tone={s.totals.fullyDepreciated > 0 ? 'negative' : undefined}
              hint={s.totals.disposed > 0 ? t('assets.disposedCount', { count: s.totals.disposed }) : undefined}
            />
          </div>

          <div className="chart-grid">
            <ChartFrame
              title={t('assets.nbvTrend')}
              subtitle={t('assets.nbvTrendSub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('dashboard.month')}</th>
                      <th>{t('assets.netBookValue')}</th>
                      <th>{t('assets.depreciation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.monthly.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td>{base(m.netBookValueBase)}</td>
                        <td>{base(m.depreciationBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <LineChart
                labels={s.monthly.map((m) => m.month)}
                format={base}
                series={[
                  {
                    key: 'nbv',
                    label: t('assets.netBookValue'),
                    color: 'var(--gsi-viz-series1)',
                    values: s.monthly.map((m) => m.netBookValueBase),
                  },
                ]}
              />
            </ChartFrame>

            <ChartFrame
              title={t('assets.depreciationByMonth')}
              subtitle={t('assets.depreciationByMonthSub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('dashboard.month')}</th>
                      <th>{t('assets.depreciation')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.monthly.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td>{base(m.depreciationBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <Columns labels={s.monthly.map((m) => m.month)} values={s.monthly.map((m) => m.depreciationBase)} format={base} />
            </ChartFrame>

            <ChartFrame
              title={t('assets.byCategory')}
              subtitle={t('assets.byCategorySub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('assets.category')}</th>
                      <th>{t('assets.cost')}</th>
                      <th>{t('assets.netBookValue')}</th>
                      <th>{t('assets.countShort')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byCategory.map((c) => (
                      <tr key={c.key}>
                        <td>{catLabel(c.key)}</td>
                        <td>{base(c.amountBase)}</td>
                        <td>{base(c.netBookValueBase)}</td>
                        <td>{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.byCategory.map((c) => ({
                  key: c.key,
                  label: `${catLabel(c.key)} · ${c.count}`,
                  value: c.netBookValueBase,
                }))}
                format={base}
              />
            </ChartFrame>

            {!branchId && s.byBranch.length > 1 && (
              <ChartFrame
                title={t('assets.byBranch')}
                subtitle={t('assets.byBranchSub')}
                table={
                  <Table>
                    <thead>
                      <tr>
                        <th>{t('common.branch')}</th>
                        <th>{t('assets.netBookValue')}</th>
                        <th>{t('assets.countShort')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byBranch.map((b) => (
                        <tr key={b.branchId}>
                          <td>{b.code}</td>
                          <td>{base(b.amountBase)}</td>
                          <td>{b.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                }
              >
                <BarList
                  rows={s.byBranch.map((b) => ({
                    key: b.branchId,
                    label: `${flag(b.country)} ${b.code} · ${b.count}`,
                    value: b.amountBase,
                  }))}
                  format={base}
                />
              </ChartFrame>
            )}
          </div>

          {s.endingSoon.length > 0 && (
            <Card title={t('assets.endingSoon')} actions={<span className="muted">{t('assets.endingSoonHint')}</span>}>
              <Table>
                <thead>
                  <tr>
                    <th>{t('assets.inventoryNo')}</th>
                    <th>{t('assets.name')}</th>
                    <th>{t('assets.remaining')}</th>
                    <th>{t('assets.netBookValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.endingSoon.map((a) => (
                    <tr key={a.id} className="link-row" onClick={() => navigate(`/assets/${a.id}`)}>
                      <td className="mono">{a.inventoryNo}</td>
                      <td>{a.name}</td>
                      <td>
                        <Badge tone={a.remainingMonths <= 2 ? 'danger' : 'warning'}>
                          {t('assets.months', { count: a.remainingMonths })}
                        </Badge>
                      </td>
                      <td>{base(a.netBookValueBase)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}

      {creating && (
        <Card title={t('assets.new')}>
          <form onSubmit={onSubmit}>
            <ErrorBox error={create.error} />
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label={`${t('assets.inventoryNo')} *`}>
                <Input required value={form.inventoryNo} onChange={(e) => setForm((f) => ({ ...f, inventoryNo: e.target.value }))} />
              </Field>
              <Field label={`${t('assets.name')} *`}>
                <Input required minLength={2} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label={t('assets.category')}>
                <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as AssetCategory }))}>
                  {ASSET_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {catLabel(c)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('assets.serialNo')}>
                <Input value={form.serialNo} onChange={(e) => setForm((f) => ({ ...f, serialNo: e.target.value }))} />
              </Field>
              <Field label={t('assets.location')}>
                <Input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
              </Field>
              <Field label={`${t('assets.acquisitionDate')} *`}>
                <Input
                  required
                  type="date"
                  value={form.acquisitionDate}
                  onChange={(e) => setForm((f) => ({ ...f, acquisitionDate: e.target.value }))}
                />
              </Field>
              <Field label={`${t('assets.cost')} *`} hint={t('expenses.localHint')}>
                <Input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.acquisitionCost}
                  onChange={(e) => setForm((f) => ({ ...f, acquisitionCost: e.target.value }))}
                />
              </Field>
              <Field label={t('assets.usefulLife')} hint={t('assets.usefulLifeHint')}>
                <Input
                  type="number"
                  min="1"
                  value={form.usefulLifeMonths}
                  onChange={(e) => setForm((f) => ({ ...f, usefulLifeMonths: e.target.value }))}
                />
              </Field>
              <Field label={t('assets.salvage')} hint={t('assets.salvageHint')}>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.salvageValue}
                  onChange={(e) => setForm((f) => ({ ...f, salvageValue: e.target.value }))}
                />
              </Field>
              {isHq && (
                <Field label={t('common.branch')}>
                  <Select value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}>
                    <option value="">—</option>
                    {branches.data?.map((b) => (
                      <option key={b.id} value={b.id}>
                        {flag(b.country)} {b.code} — {b.city}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('common.create')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card
        title={t('assets.register')}
        actions={
          <>
            <Input placeholder={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
            <Select value={category} onChange={(e) => setCategory(e.target.value as AssetCategory | '')} style={{ width: 200 }}>
              <option value="">
                {t('assets.category')}: {t('common.all')}
              </option>
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {catLabel(c)}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value as AssetStatus | '')} style={{ width: 170 }}>
              <option value="">
                {t('jobs.status')}: {t('common.all')}
              </option>
              {ASSET_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {t(`assetStatus.${st}`)}
                </option>
              ))}
            </Select>
          </>
        }
      >
        <ErrorBox error={assets.error} />
        {assets.isLoading ? (
          <Loading />
        ) : !assets.data?.length ? (
          <EmptyState>{t('assets.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('assets.inventoryNo')}</th>
                {!branchId && <th>{t('common.branch')}</th>}
                <th>{t('assets.name')}</th>
                <th>{t('assets.category')}</th>
                <th>{t('assets.acquisitionDate')}</th>
                <th>{t('assets.cost')}</th>
                <th>{t('assets.accumulated')}</th>
                <th>{t('assets.netBookValue')}</th>
                <th>{t('assets.remaining')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {assets.data.map((a) => (
                <tr key={a.id} className="link-row" onClick={() => navigate(`/assets/${a.id}`)}>
                  <td className="mono">
                    <Link to={`/assets/${a.id}`} onClick={(e) => e.stopPropagation()}>
                      {a.inventoryNo}
                    </Link>
                  </td>
                  {!branchId && <td>{a.branchCode}</td>}
                  <td>
                    {a.name}
                    {a.serialNo ? <div className="muted" style={{ fontSize: 12 }}>{a.serialNo}</div> : null}
                  </td>
                  <td>{catLabel(a.category)}</td>
                  <td>{fmt(a.acquisitionDate, false)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(a.acquisitionCost, a.currency)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(a.accumulated, a.currency)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(a.netBookValue ?? 0, a.currency)}</td>
                  <td>{a.remainingMonths == null ? '—' : t('assets.months', { count: a.remainingMonths })}</td>
                  <td>
                    <Badge tone={ASSET_TONE[a.status]}>{t(`assetStatus.${a.status}`)}</Badge>
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

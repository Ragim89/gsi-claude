import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Card, Select, Table } from '@gsi/ui-kit/react';
import { api } from '../api';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, StatTile } from '../components/charts';
import { ErrorBox, Loading, PageHead } from '../components/common';

interface ComparisonRow {
  branchId: string;
  code: string;
  country: string;
  city: string;
  currency: string;
  isHq: boolean;
  revenueBase: number;
  expenseBase: number;
  receivableBase: number;
  overdueBase: number;
  jobCount: number;
  reportCount: number;
  inspectorCount: number;
  avgCycleDays: number | null;
}

interface Comparison {
  baseCurrency: string;
  period: { from: string; to: string };
  branches: ComparisonRow[];
}

const PERIODS = [
  { key: '3m', months: 3 },
  { key: '6m', months: 6 },
  { key: '12m', months: 12 },
];

function periodFrom(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - (months - 1));
  return d.toISOString().slice(0, 10);
}

type SortKey = 'revenueBase' | 'profit' | 'margin' | 'jobCount' | 'revenuePerInspector' | 'overdueBase';

/** All entities side by side: the group view HQ needs to compare, not just aggregate. */
export function BranchesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { setBranchId } = useBranch();
  const [period, setPeriod] = useState('12m');
  const [sort, setSort] = useState<SortKey>('revenueBase');

  const months = PERIODS.find((p) => p.key === period)?.months ?? 12;
  const from = periodFrom(months);
  const q = useQuery({
    queryKey: ['branch-comparison', from],
    queryFn: () => api.get<Comparison>(`/branches/comparison/summary?from=${from}`),
  });

  const money = useMemo(() => {
    const currency = q.data?.baseCurrency ?? 'EUR';
    return (v: number) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  }, [q.data?.baseCurrency, i18n.language]);

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;

  const rows = q.data.branches.map((b) => ({
    ...b,
    profit: Math.round((b.revenueBase - b.expenseBase) * 100) / 100,
    margin: b.revenueBase > 0 ? Math.round(((b.revenueBase - b.expenseBase) / b.revenueBase) * 100) : null,
    revenuePerInspector: b.inspectorCount > 0 ? Math.round(b.revenueBase / b.inspectorCount) : 0,
  }));
  const sorted = [...rows].sort((a, b) => (Number(b[sort] ?? 0) - Number(a[sort] ?? 0)));
  const group = {
    revenue: rows.reduce((s, r) => s + r.revenueBase, 0),
    profit: rows.reduce((s, r) => s + r.profit, 0),
    jobs: rows.reduce((s, r) => s + r.jobCount, 0),
    overdue: rows.reduce((s, r) => s + r.overdueBase, 0),
  };
  const best = [...rows].sort((a, b) => (b.margin ?? -1) - (a.margin ?? -1))[0];

  /** Opening a branch from here also sets it as the active filter everywhere else. */
  const openBranch = (id: string) => {
    setBranchId(id);
    navigate(`/branches/${id}`);
  };

  return (
    <div className="stack">
      <PageHead
        title={t('branches.title')}
        sub={`${t('dashboard.period', { from: q.data.period.from, to: q.data.period.to })} · ${t('dashboard.inCurrency', { currency: q.data.baseCurrency })}`}
        actions={
          <Select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 170 }}>
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {t(`dashboard.periods.${p.key}`)}
              </option>
            ))}
          </Select>
        }
      />

      <div className="kpi-row">
        <StatTile label={t('branches.entities')} value={String(rows.length)} hint={t('branches.entitiesHint')} />
        <StatTile label={t('dashboard.revenue')} value={money(group.revenue)} />
        <StatTile label={t('dashboard.profit')} value={money(group.profit)} tone={group.profit >= 0 ? 'positive' : 'negative'} />
        <StatTile label={t('jobs.title')} value={String(group.jobs)} />
        <StatTile
          label={t('branches.bestMargin')}
          value={best ? `${flag(best.country)} ${best.code}` : '—'}
          hint={best?.margin !== null && best ? `${best.margin}%` : undefined}
        />
      </div>

      <div className="chart-grid">
        <ChartFrame
          title={t('branches.revenueCompare')}
          subtitle={t('branches.revenueCompareSub')}
          table={comparisonTable(sorted, money, t)}
        >
          <BarList
            rows={sorted.map((b) => ({ key: b.branchId, label: `${flag(b.country)} ${b.code} — ${b.city}`, value: b.revenueBase }))}
            format={money}
          />
        </ChartFrame>

        <ChartFrame
          title={t('branches.profitCompare')}
          subtitle={t('branches.profitCompareSub')}
          table={comparisonTable(sorted, money, t)}
        >
          <BarList
            rows={[...rows]
              .sort((a, b) => b.profit - a.profit)
              .map((b) => ({ key: b.branchId, label: `${flag(b.country)} ${b.code} · ${b.margin ?? '—'}%`, value: Math.max(0, b.profit) }))}
            format={money}
          />
        </ChartFrame>

        <ChartFrame
          title={t('branches.perInspector')}
          subtitle={t('branches.perInspectorSub')}
          table={comparisonTable(sorted, money, t)}
        >
          <BarList
            rows={[...rows]
              .sort((a, b) => b.revenuePerInspector - a.revenuePerInspector)
              .map((b) => ({
                key: b.branchId,
                label: `${flag(b.country)} ${b.code} · ${b.inspectorCount} ${t('branches.inspectorsShort')}`,
                value: b.revenuePerInspector,
              }))}
            format={money}
          />
        </ChartFrame>

        <ChartFrame title={t('branches.overdueCompare')} subtitle={t('branches.overdueCompareSub')} table={comparisonTable(sorted, money, t)}>
          <BarList
            rows={[...rows]
              .sort((a, b) => b.overdueBase - a.overdueBase)
              .map((b) => ({ key: b.branchId, label: `${flag(b.country)} ${b.code}`, value: b.overdueBase }))}
            format={money}
            ramp={['var(--gsi-viz-seq5)', 'var(--gsi-viz-seq4)', 'var(--gsi-viz-seq3)', 'var(--gsi-viz-seq2)', 'var(--gsi-viz-seq1)']}
          />
        </ChartFrame>
      </div>

      <Card
        title={t('branches.table')}
        actions={
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ width: 220 }}>
            <option value="revenueBase">{t('branches.sortBy')}: {t('dashboard.revenue')}</option>
            <option value="profit">{t('branches.sortBy')}: {t('dashboard.profit')}</option>
            <option value="margin">{t('branches.sortBy')}: {t('dashboard.margin2')}</option>
            <option value="jobCount">{t('branches.sortBy')}: {t('jobs.title')}</option>
            <option value="revenuePerInspector">{t('branches.sortBy')}: {t('branches.perInspectorShort')}</option>
            <option value="overdueBase">{t('branches.sortBy')}: {t('invoices.overdue')}</option>
          </Select>
        }
      >
        <Table>
          <thead>
            <tr>
              <th>{t('common.branch')}</th>
              <th>{t('dashboard.revenue')}</th>
              <th>{t('dashboard.expenses')}</th>
              <th>{t('dashboard.profit')}</th>
              <th>{t('dashboard.margin2')}</th>
              <th>{t('jobs.title')}</th>
              <th>{t('dashboard.reportsIssued')}</th>
              <th>{t('dashboard.avgCycle')}</th>
              <th>{t('branches.perInspectorShort')}</th>
              <th>{t('invoices.overdue')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((b) => (
              <tr key={b.branchId} className="link-row" onClick={() => openBranch(b.branchId)}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Link to={`/branches/${b.branchId}`} onClick={(e) => e.stopPropagation()}>
                    {flag(b.country)} <strong>{b.code}</strong>
                  </Link>{' '}
                  <span className="muted">{b.city}</span>
                  {b.isHq ? <> <Badge tone="accent">HQ</Badge></> : null}
                </td>
                <td>{money(b.revenueBase)}</td>
                <td>{money(b.expenseBase)}</td>
                <td className={b.profit >= 0 ? '' : 'negative'}>{money(b.profit)}</td>
                <td>{b.margin === null ? '—' : `${b.margin}%`}</td>
                <td>{b.jobCount}</td>
                <td>{b.reportCount}</td>
                <td>{b.avgCycleDays === null ? '—' : t('dashboard.days2', { days: Math.round(b.avgCycleDays * 10) / 10 })}</td>
                <td>{money(b.revenuePerInspector)}</td>
                <td className={b.overdueBase > 0 ? 'negative' : ''}>{money(b.overdueBase)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function comparisonTable(
  rows: (ComparisonRow & { profit: number; margin: number | null })[],
  money: (v: number) => string,
  t: (k: string) => string,
) {
  return (
    <Table>
      <thead>
        <tr>
          <th>{t('common.branch')}</th>
          <th>{t('dashboard.revenue')}</th>
          <th>{t('dashboard.profit')}</th>
          <th>{t('dashboard.margin2')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.branchId}>
            <td>
              {b.code} — {b.city}
            </td>
            <td>{money(b.revenueBase)}</td>
            <td>{money(b.profit)}</td>
            <td>{b.margin === null ? '—' : `${b.margin}%`}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Card, Select, Table } from '@gsi/ui-kit/react';
import {
  FinanceDashboard,
  Inspection,
  InspectionJob,
  Invoice,
  Page,
  ReportDocument,
  Sample,
  localize,
  SERVICE_TYPE_LABELS,
  ServiceType,
} from '@gsi/shared-types';
import { api, subscribeFinance } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, FlowColumns, LineChart, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { KpiDrilldownDrawer } from '../components/KpiDrilldownDrawer';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';
import { DashboardHero } from '../components/DashboardHero';
import { KpiCard } from '../components/KpiCard';
import { RecentActivityCard } from '../components/RecentActivityCard';
import { UpcomingTasksCard } from '../components/UpcomingTasksCard';
import { QuickActionsCard } from '../components/QuickActionsCard';
import { RecentJobsCard } from '../components/RecentJobsCard';
import { IconBanknote, IconBriefcase, IconClipboardCheck, IconDocument, IconFlask } from '../components/icons';

type HomeDrill = 'jobs' | 'inspections' | 'samples' | 'reports' | 'revenue';

/** Real-time group finance dashboard (docs/03-finance-dashboard.md). */
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { isHq, can } = useAuth();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [live, setLive] = useState<{ at: string; count: number } | null>(null);
  const [drill, setDrill] = useState<HomeDrill | null>(null);

  const { branchId, current } = useBranch();
  const query = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');

  const q = useQuery({
    queryKey: ['dashboard', query],
    queryFn: () => api.get<FinanceDashboard>(`/finance/dashboard?${query}`),
  });

  // Two lightweight counts the finance payload does not carry, read from the same list
  // endpoints the Inspections/Samples screens already use (limit=1, we only need `.total`) —
  // not a second analytics mechanism, just the existing REST list APIs with the same date range.
  const canInspections = can('inspection.read');
  const canSamples = can('sample.read');
  const inspectionsCountQ = useQuery({
    queryKey: ['dashboard', 'inspections-count', query],
    queryFn: () => api.get<Page<Inspection>>(`/inspections?${query}&active=true&limit=1`),
    enabled: canInspections,
  });
  const samplesCountQ = useQuery({
    queryKey: ['dashboard', 'samples-count', query],
    queryFn: () => api.get<Page<Sample>>(`/samples?${query}&limit=1`),
    enabled: canSamples,
  });

  // Drilldowns for the top KPI row — same period+branch scope, same permission-gated list
  // endpoints the Jobs/Inspections/Samples/Reports/Invoices screens already use.
  const canReports = can('report.read');
  const drillJobsQ = useQuery({
    queryKey: ['dashboard', 'jobs-drill', query],
    queryFn: () => api.get<Page<InspectionJob>>(`/jobs?${query}&limit=200`),
    enabled: drill === 'jobs',
  });
  const drillInspectionsQ = useQuery({
    queryKey: ['dashboard', 'inspections-drill', query],
    queryFn: () => api.get<Page<Inspection>>(`/inspections?${query}&limit=200`),
    enabled: drill === 'inspections',
  });
  const drillSamplesQ = useQuery({
    queryKey: ['dashboard', 'samples-drill', query],
    queryFn: () => api.get<Page<Sample>>(`/samples?${query}&limit=200`),
    enabled: drill === 'samples',
  });
  const drillReportsQ = useQuery({
    queryKey: ['dashboard', 'reports-drill', query],
    queryFn: () => api.get<Page<ReportDocument>>(`/reports?${query}&limit=200`),
    enabled: drill === 'reports',
  });
  // GET /finance/invoices has no from/to filter (unlike jobs/inspections/samples/reports) —
  // branch-scoped only, then filtered client-side to invoices issued in this period.
  const drillRevenueQ = useQuery({
    queryKey: ['dashboard', 'revenue-drill', branchId],
    queryFn: () => api.get<Invoice[]>(`/finance/invoices${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: drill === 'revenue',
  });

  // Event-driven refresh: the API pushes a message whenever a posting lands (no polling).
  useEffect(() => {
    return subscribeFinance(() => {
      setLive((prev) => ({ at: new Date().toISOString(), count: (prev?.count ?? 0) + 1 }));
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    });
  }, [qc]);

  const money = useMemo(() => {
    const currency = q.data?.baseCurrency ?? 'EUR';
    return (v: number) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  }, [q.data?.baseCurrency, i18n.language]);

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const serviceLabel = (key: string) =>
    key === 'unassigned' ? t('dashboard.unassigned') : localize(SERVICE_TYPE_LABELS[key as ServiceType], i18n.language);

  const canFinance = can('finance.read');
  // Every figure below is real, already-available data — the same numbers the ops-KPI card and
  // the Inspections/Samples/Reports screens show. No fabricated deltas or comparison periods.
  const summaryParts = [
    t('dashboardHome.summaryJobs', { count: d.kpis.jobsInPeriod }),
    canInspections && inspectionsCountQ.data ? t('dashboardHome.summaryInspections', { count: inspectionsCountQ.data.total }) : null,
    t('dashboardHome.summaryReports', { count: d.kpis.reportsInPeriod }),
  ].filter(Boolean);
  const revenueTrend = d.monthly.map((m) => m.revenueBase);

  return (
    <div className="stack">
      <DashboardHero
        summary={summaryParts.join(' · ')}
        period={t('dashboard.period', { from: d.period.from, to: d.period.to })}
      />

      <div className="kpi-row kpi-row--home">
        <KpiCard
          accent="blue"
          icon={<IconBriefcase />}
          label={t('dashboardHome.kpiJobs')}
          value={String(d.kpis.jobsInPeriod)}
          onClick={() => setDrill('jobs')}
        />
        {canInspections && (
          <KpiCard
            accent="cyan"
            icon={<IconClipboardCheck />}
            label={t('dashboardHome.kpiInspections')}
            value={inspectionsCountQ.isLoading ? '…' : String(inspectionsCountQ.data?.total ?? 0)}
            onClick={() => setDrill('inspections')}
          />
        )}
        {canSamples && (
          <KpiCard
            accent="green"
            icon={<IconFlask />}
            label={t('dashboardHome.kpiSamples')}
            value={samplesCountQ.isLoading ? '…' : String(samplesCountQ.data?.total ?? 0)}
            onClick={() => setDrill('samples')}
          />
        )}
        {canReports && (
          <KpiCard
            accent="purple"
            icon={<IconDocument />}
            label={t('dashboardHome.kpiReports')}
            value={String(d.kpis.reportsInPeriod)}
            onClick={() => setDrill('reports')}
          />
        )}
        {canFinance && (
          <KpiCard
            accent="amber"
            icon={<IconBanknote />}
            label={t('dashboardHome.kpiRevenue')}
            value={money(d.totals.revenueBase)}
            trend={revenueTrend}
            onClick={() => setDrill('revenue')}
          />
        )}
      </div>

      <KpiDrilldownDrawer
        open={drill !== null}
        onClose={() => setDrill(null)}
        title={drill ? t(`dashboardHome.drill.${drill}`) : ''}
        loading={
          (drill === 'jobs' && drillJobsQ.isLoading) ||
          (drill === 'inspections' && drillInspectionsQ.isLoading) ||
          (drill === 'samples' && drillSamplesQ.isLoading) ||
          (drill === 'reports' && drillReportsQ.isLoading) ||
          (drill === 'revenue' && drillRevenueQ.isLoading)
        }
        error={
          drill === 'jobs' ? drillJobsQ.error
          : drill === 'inspections' ? drillInspectionsQ.error
          : drill === 'samples' ? drillSamplesQ.error
          : drill === 'reports' ? drillReportsQ.error
          : drill === 'revenue' ? drillRevenueQ.error
          : undefined
        }
        empty={
          (drill === 'jobs' && !drillJobsQ.data?.rows.length) ||
          (drill === 'inspections' && !drillInspectionsQ.data?.rows.length) ||
          (drill === 'samples' && !drillSamplesQ.data?.rows.length) ||
          (drill === 'reports' && !drillReportsQ.data?.rows.length) ||
          (drill === 'revenue' && !revenueInPeriod(drillRevenueQ.data, d.period).length)
        }
      >
        {drill === 'jobs' && (
          <Table>
            <thead><tr><th>{t('jobs.number')}</th><th>{t('jobs.client')}</th><th>{t('jobs.status')}</th></tr></thead>
            <tbody>
              {(drillJobsQ.data?.rows ?? []).map((j) => (
                <tr key={j.id} className="link-row" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td className="mono">{j.jobNumber}</td><td>{j.clientName}</td><td>{t(`status.${j.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {drill === 'inspections' && (
          <Table>
            <thead><tr><th>{t('inspections.number')}</th><th>{t('jobs.client')}</th><th>{t('jobs.status')}</th></tr></thead>
            <tbody>
              {(drillInspectionsQ.data?.rows ?? []).map((x) => (
                <tr key={x.id} className="link-row" onClick={() => navigate(`/inspections/${x.id}`)}>
                  <td className="mono">{x.inspectionNumber}</td><td>{x.clientName}</td><td>{t(`status.${x.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {drill === 'samples' && (
          <Table>
            <thead><tr><th>{t('samples.number')}</th><th>{t('jobs.client')}</th><th>{t('jobs.status')}</th></tr></thead>
            <tbody>
              {(drillSamplesQ.data?.rows ?? []).map((x) => (
                <tr key={x.id} className="link-row" onClick={() => navigate(`/samples/${x.id}`)}>
                  <td className="mono">{x.sampleNumber}</td><td>{x.clientName}</td><td>{t(`status.${x.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {drill === 'reports' && (
          <Table>
            <thead><tr><th>{t('reports.number')}</th><th>{t('jobs.client')}</th><th>{t('invoices.issued')}</th></tr></thead>
            <tbody>
              {(drillReportsQ.data?.rows ?? []).map((r) => (
                <tr key={r.id} className="link-row" onClick={() => navigate(`/reports/${r.id}`)}>
                  <td className="mono">{r.reportNumber}</td><td>{r.clientName}</td><td>{fmt(r.issuedAt, false)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {drill === 'revenue' && (
          <Table>
            <thead><tr><th>{t('invoices.number')}</th><th>{t('jobs.client')}</th><th>{t('invoices.total')}</th><th>{t('invoices.issued')}</th></tr></thead>
            <tbody>
              {revenueInPeriod(drillRevenueQ.data, d.period).map((inv) => (
                <tr key={inv.id} className="link-row" onClick={() => navigate(`/finance/invoices/${inv.id}`)}>
                  <td className="mono">{inv.invoiceNumber}</td><td>{inv.clientName}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {new Intl.NumberFormat(i18n.language, { style: 'currency', currency: inv.currency, maximumFractionDigits: 2 }).format(inv.amountTotal)}
                  </td>
                  <td>{fmt(inv.issueDate, false)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </KpiDrilldownDrawer>

      <div className="dash-grid">
        <RecentActivityCard />
        <UpcomingTasksCard />
        <QuickActionsCard />
      </div>

      <RecentJobsCard />

      <PageHead
        title={
          branchId && current
            ? `${flag(current.country)} ${t('dashboard.branchOf', { branch: `${current.code} — ${current.city}` })}`
            : isHq
              ? t('dashboard.groupTitle')
              : t('dashboard.branchTitle')
        }
        sub={
          <>
            {t('dashboard.period', { from: d.period.from, to: d.period.to })} · {t('dashboard.inCurrency', { currency: d.baseCurrency })}
            {live ? <> · <Badge tone="success">{t('dashboard.live', { count: live.count })}</Badge></> : null}
          </>
        }
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />

      <div className="kpi-row">
        <StatTile label={t('dashboard.capitalization')} value={money(d.totals.capitalizationBase)} hint={t('dashboard.capitalizationHint')} />
        <StatTile label={t('dashboard.revenue')} value={money(d.totals.revenueBase)} />
        <StatTile
          label={t('dashboard.profit')}
          value={money(d.totals.profitBase)}
          tone={d.totals.profitBase >= 0 ? 'positive' : 'negative'}
          hint={d.totals.marginPct !== null ? t('dashboard.margin', { pct: d.totals.marginPct }) : undefined}
        />
        <StatTile label={t('dashboard.cash')} value={money(d.totals.cashBase)} />
        <StatTile
          label={t('dashboard.receivable')}
          value={money(d.totals.receivableBase)}
          tone={d.totals.overdueBase > 0 ? 'negative' : undefined}
          hint={t('dashboard.overdue', { amount: money(d.totals.overdueBase) })}
        />
        <StatTile label={t('dashboard.payable')} value={money(d.totals.payableBase)} />
        <StatTile label={t('dashboard.unallocatedCash')} value={money(d.totals.unallocatedCashBase)} />
      </div>

      <div className="chart-grid">
        <ChartFrame
          title={t('dashboard.pnl')}
          subtitle={t('dashboard.pnlSub')}
          legend={[
            { label: t('dashboard.revenue'), color: 'var(--gsi-viz-series1)' },
            { label: t('dashboard.expenses'), color: 'var(--gsi-viz-series2)' },
            { label: t('dashboard.profit'), color: 'var(--gsi-viz-series3)' },
          ]}
          table={
            <Table>
              <thead>
                <tr>
                  <th>{t('dashboard.month')}</th>
                  <th>{t('dashboard.revenue')}</th>
                  <th>{t('dashboard.expenses')}</th>
                  <th>{t('dashboard.profit')}</th>
                </tr>
              </thead>
              <tbody>
                {d.monthly.map((m) => (
                  <tr key={m.month}>
                    <td>{m.month}</td>
                    <td>{money(m.revenueBase)}</td>
                    <td>{money(m.expenseBase)}</td>
                    <td>{money(m.profitBase)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          }
        >
          <LineChart
            labels={d.monthly.map((m) => m.month)}
            format={money}
            series={[
              { key: 'revenue', label: t('dashboard.revenue'), color: 'var(--gsi-viz-series1)', values: d.monthly.map((m) => m.revenueBase) },
              { key: 'expense', label: t('dashboard.expenses'), color: 'var(--gsi-viz-series2)', values: d.monthly.map((m) => m.expenseBase) },
              { key: 'profit', label: t('dashboard.profit'), color: 'var(--gsi-viz-series3)', values: d.monthly.map((m) => m.profitBase) },
            ]}
          />
        </ChartFrame>

        <ChartFrame
          title={t('dashboard.cashFlow')}
          subtitle={t('dashboard.cashFlowSub')}
          legend={[
            { label: t('dashboard.inflow'), color: 'var(--gsi-viz-series3)' },
            { label: t('dashboard.outflow'), color: 'var(--gsi-viz-series2)' },
          ]}
          table={
            <Table>
              <thead>
                <tr>
                  <th>{t('dashboard.month')}</th>
                  <th>{t('dashboard.inflow')}</th>
                  <th>{t('dashboard.outflow')}</th>
                  <th>{t('dashboard.net')}</th>
                </tr>
              </thead>
              <tbody>
                {d.cashFlow.map((c) => (
                  <tr key={c.month}>
                    <td>{c.month}</td>
                    <td>{money(c.inflowBase)}</td>
                    <td>{money(c.outflowBase)}</td>
                    <td>{money(c.netBase)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          }
        >
          <FlowColumns
            labels={d.cashFlow.map((c) => c.month)}
            inflow={d.cashFlow.map((c) => c.inflowBase)}
            outflow={d.cashFlow.map((c) => c.outflowBase)}
            format={money}
          />
        </ChartFrame>

        <ChartFrame
          title={t('dashboard.revenueByService')}
          table={breakdownTable(d.revenueByService.map((s) => ({ ...s, key: serviceLabel(s.key) })), money, t('dashboard.service'))}
        >
          <BarList
            rows={d.revenueByService.map((s) => ({ key: s.key, label: serviceLabel(s.key), value: s.amountBase }))}
            format={money}
          />
        </ChartFrame>

        <ChartFrame title={t('dashboard.expensesByCategory')} table={breakdownTable(d.expensesByCategory, money, t('dashboard.category'))}>
          <BarList
            rows={d.expensesByCategory.map((s) => ({ key: s.key, label: t(`expenseCategories.${s.key}`), value: s.amountBase }))}
            format={money}
          />
        </ChartFrame>

        <ChartFrame title={t('dashboard.topClients')} table={breakdownTable(d.revenueByClient, money, t('jobs.client'))}>
          <BarList rows={d.revenueByClient.map((s) => ({ key: s.key, label: s.key, value: s.amountBase }))} format={money} />
        </ChartFrame>

        <ChartFrame title={t('dashboard.arAging')} subtitle={t('dashboard.arAgingSub')} table={
          <Table>
            <thead>
              <tr>
                <th>{t('dashboard.bucket')}</th>
                <th>{t('dashboard.amount')}</th>
                <th>{t('dashboard.invoices')}</th>
              </tr>
            </thead>
            <tbody>
              {d.arAging.map((b) => (
                <tr key={b.bucket}>
                  <td>{b.bucket}</td>
                  <td>{money(b.amountBase)}</td>
                  <td>{b.invoiceCount}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        }>
          <BarList
            rows={d.arAging.map((b) => ({ key: b.bucket, label: t('dashboard.days', { range: b.bucket }), value: b.amountBase }))}
            format={money}
            ramp={['var(--gsi-viz-seq1)', 'var(--gsi-viz-seq2)', 'var(--gsi-viz-seq4)', 'var(--gsi-viz-seq5)']}
          />
        </ChartFrame>
      </div>

      <Card title={t('dashboard.byBranch')}>
        <Table>
          <thead>
            <tr>
              <th>{t('common.branch')}</th>
              <th>{t('dashboard.revenue')}</th>
              <th>{t('dashboard.expenses')}</th>
              <th>{t('dashboard.profit')}</th>
              <th>{t('dashboard.margin2')}</th>
              <th>{t('dashboard.cash')}</th>
              <th>{t('dashboard.receivable')}</th>
              <th>{t('dashboard.localRevenue')}</th>
              <th>{t('jobs.title')}</th>
            </tr>
          </thead>
          <tbody>
            {d.branches.map((b) => {
              const margin = b.revenueBase > 0 ? Math.round((b.profitBase / b.revenueBase) * 100) : null;
              return (
                <tr key={b.branchId}>
                  <td>
                    <strong>{b.branchCode}</strong> <span className="muted">{b.city}</span>
                  </td>
                  <td>{money(b.revenueBase)}</td>
                  <td>{money(b.expenseBase)}</td>
                  <td className={b.profitBase >= 0 ? '' : 'negative'}>{money(b.profitBase)}</td>
                  <td>{margin === null ? '—' : `${margin}%`}</td>
                  <td>{money(b.cashBase)}</td>
                  <td>{money(b.receivableBase)}</td>
                  <td className="mono">
                    {new Intl.NumberFormat(i18n.language, { style: 'currency', currency: b.currency, maximumFractionDigits: 0 }).format(
                      b.revenueLocal,
                    )}
                  </td>
                  <td>{b.jobCount}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      {d.quotePipeline.length > 0 && (
        <Card title={t('dashboard.quotePipeline')}>
          <Table>
            <thead>
              <tr>
                <th>{t('jobs.status')}</th>
                <th>{t('dashboard.invoices')}</th>
                <th>{t('dashboard.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {d.quotePipeline.map((q) => (
                <tr key={q.status}>
                  <td>{t(`quoteStatus.${q.status}`)}</td>
                  <td>{q.count}</td>
                  <td>{money(q.amountBase)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
            <Link to="/finance/quotes">{t('nav.quotes')}</Link>
          </p>
        </Card>
      )}

      <Card title={t('dashboard.opsKpis')}>
        <div className="kpi-row">
          <StatTile label={t('dashboard.jobsInPeriod')} value={String(d.kpis.jobsInPeriod)} />
          <StatTile label={t('dashboard.jobsApproved')} value={String(d.kpis.jobsApproved)} />
          <StatTile label={t('dashboard.reportsIssued')} value={String(d.kpis.reportsInPeriod)} />
          <StatTile
            label={t('dashboard.avgCycle')}
            value={d.kpis.avgJobToReportDays === null ? '—' : t('dashboard.days2', { days: d.kpis.avgJobToReportDays })}
          />
          <StatTile
            label={t('dashboard.inspectorLoad')}
            value={String(d.kpis.jobsPerInspector)}
            hint={t('dashboard.activeInspectors', { count: d.kpis.activeInspectors })}
          />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          <Link to="/finance/invoices">{t('nav.invoices')}</Link> · <Link to="/finance/expenses">{t('nav.expenses')}</Link>
        </p>
      </Card>
    </div>
  );
}

/** GET /finance/invoices has no from/to filter — issued-in-period is applied here instead,
 *  against the same period the Revenue KPI itself was computed over. */
function revenueInPeriod(invoices: Invoice[] | undefined, period: { from: string; to: string }): Invoice[] {
  if (!invoices) return [];
  return invoices.filter((i) => i.status !== 'draft' && i.issueDate >= period.from && i.issueDate <= period.to);
}

function breakdownTable(
  rows: { key: string; amountBase: number; share: number }[],
  money: (v: number) => string,
  keyLabel: string,
) {
  return (
    <Table>
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th>—</th>
          <th>%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td>{money(r.amountBase)}</td>
            <td>{r.share}%</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

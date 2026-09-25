import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Card, Select, Table } from '@gsi/ui-kit/react';
import { FinanceDashboard, localize, SERVICE_TYPE_LABELS, ServiceType } from '@gsi/shared-types';
import { api, subscribeFinance } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, FlowColumns, LineChart, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ErrorBox, Loading, PageHead } from '../components/common';

/** Real-time group finance dashboard (docs/03-finance-dashboard.md). */
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { isHq } = useAuth();
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [live, setLive] = useState<{ at: string; count: number } | null>(null);

  const { branchId, current } = useBranch();
  const query = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');

  const q = useQuery({
    queryKey: ['dashboard', query],
    queryFn: () => api.get<FinanceDashboard>(`/finance/dashboard?${query}`),
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

  return (
    <div className="stack">
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

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Card, Table } from '@gsi/ui-kit/react';
import { JobsAnalytics, TurnaroundAnalytics, WorkloadAnalytics } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { useBranch } from '../branch';
import { BarList, ChartFrame, Columns, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ErrorBox, Loading, PageHead, useServiceLabel } from '../components/common';

/** PHASE 9 — operational analytics: jobs, turnaround, workload. Same page for everyone;
 *  Row-Level Security is what turns it into "my work" for an own-scope role. */
export function AnalyticsPage() {
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const { branchId } = useBranch();
  const serviceLabel = useServiceLabel();
  const query = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');
  const own = user?.scope === 'own';

  const jobsQ = useQuery({
    queryKey: ['analytics-jobs', query],
    queryFn: () => api.get<JobsAnalytics>(`/analytics/jobs?${query}`),
  });
  const turnaroundQ = useQuery({
    queryKey: ['analytics-turnaround', query],
    queryFn: () => api.get<TurnaroundAnalytics>(`/analytics/turnaround?${query}`),
  });
  const canWorkload = can('analytics.workload');
  const workloadQ = useQuery({
    queryKey: ['analytics-workload', query],
    queryFn: () => api.get<WorkloadAnalytics>(`/analytics/workload?${query}`),
    enabled: canWorkload,
  });

  if (jobsQ.isLoading || turnaroundQ.isLoading) return <Loading />;
  if (!jobsQ.data || !turnaroundQ.data) return <ErrorBox error={jobsQ.error ?? turnaroundQ.error} />;
  const jobs = jobsQ.data;
  const turnaround = turnaroundQ.data;

  const stageLabel = (key: string) => t(`analytics.stages.${key}`);

  return (
    <div className="stack">
      <PageHead
        title={own ? t('analytics.myTitle') : t('analytics.title')}
        sub={t('dashboard.period', { from: jobs.period.from, to: jobs.period.to })}
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />

      <div className="kpi-row">
        <StatTile label={t('analytics.jobsTotal')} value={String(jobs.totals.jobCount)} />
        {turnaround.stages.map((s) => (
          <StatTile
            key={s.key}
            label={stageLabel(s.key)}
            value={s.avgDays === null ? '—' : t('dashboard.days2', { days: s.avgDays })}
            hint={s.sampleSize > 0 ? t('analytics.sampleSize', { count: s.sampleSize }) : t('analytics.noData')}
          />
        ))}
      </div>

      <ChartFrame
        title={t('analytics.jobsByMonth')}
        table={countTable(jobs.monthly.map((m) => ({ key: m.month, count: m.count })), t('dashboard.month'))}
      >
        <Columns
          labels={jobs.monthly.map((m) => m.month)}
          values={jobs.monthly.map((m) => m.count)}
          format={(v) => String(Math.round(v))}
        />
      </ChartFrame>

      <div className="chart-grid">
        <ChartFrame
          title={t('analytics.byStatus')}
          table={countTable(jobs.byStatus.map((s) => ({ key: t(`status.${s.status}`), count: s.count })), t('common.name'))}
        >
          <BarList
            rows={jobs.byStatus.map((s) => ({ key: s.status, label: t(`status.${s.status}`), value: s.count }))}
            format={(v) => String(v)}
          />
        </ChartFrame>
        <ChartFrame
          title={t('analytics.byService')}
          table={countTable(jobs.byService.map((s) => ({ key: serviceLabel(s.key), count: s.count })), t('common.name'))}
        >
          <BarList
            rows={jobs.byService.map((s) => ({ key: s.key, label: serviceLabel(s.key), value: s.count }))}
            format={(v) => String(v)}
          />
        </ChartFrame>
        <ChartFrame
          title={t('analytics.byClient')}
          table={countTable(jobs.byClient.map((s) => ({ key: s.key, count: s.count })), t('common.name'))}
        >
          <BarList rows={jobs.byClient.map((s) => ({ key: s.clientId, label: s.key, value: s.count }))} format={(v) => String(v)} />
        </ChartFrame>
        <ChartFrame
          title={t('analytics.byCountry')}
          table={countTable(jobs.byCountry.map((s) => ({ key: s.country, count: s.count })), t('analytics.byCountry'))}
        >
          <BarList rows={jobs.byCountry.map((s) => ({ key: s.country, label: s.country, value: s.count }))} format={(v) => String(v)} />
        </ChartFrame>
      </div>

      {jobs.byBranch.length > 1 && (
        <Card title={t('dashboard.byBranch')}>
          <Table>
            <thead>
              <tr>
                <th>{t('common.branch')}</th>
                <th>{t('analytics.jobsTotal')}</th>
                <th>%</th>
              </tr>
            </thead>
            <tbody>
              {jobs.byBranch.map((b) => (
                <tr key={b.branchId}>
                  <td>
                    <strong>{b.branchCode}</strong> <span className="muted">{b.city}</span>
                  </td>
                  <td>{b.count}</td>
                  <td>{b.share}%</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <ChartFrame
        title={t('analytics.turnaroundTrend')}
        subtitle={t('analytics.turnaroundTrendSub')}
        table={
          <Table>
            <thead>
              <tr>
                <th>{t('dashboard.month')}</th>
                <th>{t('analytics.avg')}</th>
                <th>{t('analytics.sample')}</th>
              </tr>
            </thead>
            <tbody>
              {turnaround.monthly.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{m.avgDays === null ? '—' : t('dashboard.days2', { days: m.avgDays })}</td>
                  <td>{m.sampleSize}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        }
      >
        <Columns
          labels={turnaround.monthly.map((m) => m.month)}
          values={turnaround.monthly.map((m) => m.avgDays ?? 0)}
          format={(v) => t('dashboard.days2', { days: Math.round(v * 10) / 10 })}
        />
      </ChartFrame>

      <Card title={t('analytics.stagesTitle')}>
        <Table>
          <thead>
            <tr>
              <th>{t('analytics.stage')}</th>
              <th>{t('analytics.avg')}</th>
              <th>{t('analytics.median')}</th>
              <th>{t('analytics.p90')}</th>
              <th>{t('analytics.sample')}</th>
            </tr>
          </thead>
          <tbody>
            {turnaround.stages.map((s) => (
              <tr key={s.key}>
                <td>{stageLabel(s.key)}</td>
                <td>{s.avgDays === null ? '—' : t('dashboard.days2', { days: s.avgDays })}</td>
                <td>{s.medianDays === null ? '—' : t('dashboard.days2', { days: s.medianDays })}</td>
                <td>{s.p90Days === null ? '—' : t('dashboard.days2', { days: s.p90Days })}</td>
                <td>{s.sampleSize}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {canWorkload && workloadQ.data && (
        <>
          <WorkloadTable title={t('analytics.inspectors')} rows={workloadQ.data.inspectors} />
          <WorkloadTable title={t('analytics.samplers')} rows={workloadQ.data.samplers} />
          <WorkloadTable title={t('analytics.labAnalysts')} rows={workloadQ.data.labAnalysts} />
          <WorkloadTable title={t('analytics.reviewers')} rows={workloadQ.data.reviewers} />
          <Card title={t('analytics.laboratories')}>
            <Table>
              <thead>
                <tr>
                  <th>{t('nav.laboratories')}</th>
                  <th>{t('analytics.active')}</th>
                  <th>{t('analytics.completed')}</th>
                </tr>
              </thead>
              <tbody>
                {workloadQ.data.laboratories.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">{t('analytics.empty')}</td>
                  </tr>
                ) : (
                  workloadQ.data.laboratories.map((l) => (
                    <tr key={l.laboratoryId}>
                      <td>{l.name}</td>
                      <td>{l.active}</td>
                      <td>{l.completed}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

function countTable(rows: { key: string; count: number }[], keyLabel: string) {
  return (
    <Table>
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th>—</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td>{r.count}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function WorkloadTable({ title, rows }: { title: string; rows: { userId: string; name: string; branchCode?: string; active: number; completed: number }[] }) {
  const { t } = useTranslation();
  return (
    <Card title={title}>
      <Table>
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('common.branch')}</th>
            <th>{t('analytics.active')}</th>
            <th>{t('analytics.completed')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">{t('analytics.empty')}</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.userId}>
                <td>{r.name}</td>
                <td>{r.branchCode}</td>
                <td>{r.active}</td>
                <td>{r.completed}</td>
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </Card>
  );
}

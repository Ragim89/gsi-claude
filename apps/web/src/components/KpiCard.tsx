import { ReactNode } from 'react';

export type KpiAccent = 'blue' | 'cyan' | 'green' | 'purple' | 'amber';

/**
 * Dashboard Visual Upgrade 2.0 — a bigger, warmer KPI tile than the finance `StatTile`
 * (components/charts.tsx): white surface, one calm accent colour per card family, an icon
 * badge, and an optional sparkline. The sparkline only renders when the caller has at least
 * two real data points — this component never fabricates a trend.
 */
export function KpiCard({
  icon,
  accent,
  label,
  value,
  hint,
  trend,
}: {
  icon: ReactNode;
  accent: KpiAccent;
  label: string;
  value: string;
  hint?: ReactNode;
  /** Real historical values only, oldest first. Omit entirely when there is no comparison data. */
  trend?: number[];
}) {
  return (
    <div className={`kpi-card kpi-card--${accent}`}>
      <div className="kpi-card__badge">{icon}</div>
      <div className="kpi-card__body">
        <div className="kpi-card__label">{label}</div>
        <div className="kpi-card__value">{value}</div>
        {hint ? <div className="kpi-card__hint">{hint}</div> : null}
      </div>
      {trend && trend.length >= 2 ? <Sparkline values={trend} /> : null}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 72;
  const h = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="kpi-card__sparkline" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

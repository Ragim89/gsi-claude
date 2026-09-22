import { ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Small SVG chart set for the finance dashboard.
 *
 * Rules followed (dataviz): the form is picked by the data's job, colours come from the
 * validated viz tokens (never hard-coded here — only var(--gsi-viz-*)), marks are thin with
 * rounded data-ends, gridlines are recessive hairlines, a legend is always present for ≥2
 * series, labels are selective (endpoints / extremes only), text never wears the series
 * colour, and every chart ships a hover tooltip plus a table view of the same numbers.
 * One value axis only — no dual axes anywhere.
 */

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

/** Tooltip coordinates are percentages of the chart box, so they follow the scaled SVG. */
function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; title: string; rows: TooltipRow[] } | null>(null);
  const node = tip ? (
    <div className="chart-tip" style={{ left: `${tip.x}%`, top: `${tip.y}%` }} role="tooltip">
      <div className="chart-tip__title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="chart-tip__row">
          <span className="chart-tip__key">
            {r.color ? <i className="chart-tip__dot" style={{ background: r.color }} /> : null}
            {r.label}
          </span>
          <span className="chart-tip__val">{r.value}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { tip, setTip, node };
}

export function ChartFrame({
  title,
  subtitle,
  legend,
  table,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: { label: string; color: string }[];
  table: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="chart-card">
      <header className="chart-card__head">
        <div>
          <h3 className="chart-card__title">{title}</h3>
          {subtitle ? <div className="chart-card__sub">{subtitle}</div> : null}
        </div>
        <div className="row-actions">
          {legend?.length ? (
            <ul className="chart-legend">
              {legend.map((l) => (
                <li key={l.label}>
                  <i style={{ background: l.color }} /> {l.label}
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" className="chart-toggle" onClick={() => setShowTable((v) => !v)}>
            {showTable ? t('charts.showChart') : t('charts.showTable')}
          </button>
        </div>
      </header>
      {showTable ? <div className="chart-table">{table}</div> : <div className="chart-body">{children}</div>}
    </section>
  );
}

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

/** Trend over time, 2–3 series, one shared value axis. Endpoints are direct-labelled. */
export function LineChart({
  labels,
  series,
  format,
  height = 240,
}: {
  labels: string[];
  series: Series[];
  format: (v: number) => string;
  height?: number;
}) {
  const { setTip, node } = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const w = 720;
  const h = height;
  const pad = { top: 16, right: 76, bottom: 26, left: 56 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;

  const all = series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const ticks = niceTicks(min, max, 4);
  const scaleY = (v: number) => pad.top + innerH - ((v - ticks[0]) / (ticks[ticks.length - 1] - ticks[0])) * innerH;
  const scaleX = (i: number) => pad.left + (labels.length === 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" role="img" aria-labelledby={id}>
        <title id={id}>{series.map((s) => s.label).join(', ')}</title>
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={pad.left} x2={w - pad.right} y1={scaleY(tv)} y2={scaleY(tv)} className="chart-grid" />
            <text x={pad.left - 8} y={scaleY(tv) + 4} className="chart-axis-text" textAnchor="end">
              {compact(tv)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1 ? (
            <text key={l} x={scaleX(i)} y={h - 6} className="chart-axis-text" textAnchor="middle">
              {l.slice(2)}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path
            key={s.key}
            d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${scaleX(i)},${scaleY(v)}`).join(' ')}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {series.map((s) => {
          const i = s.values.length - 1;
          return (
            <g key={`${s.key}-end`}>
              <circle cx={scaleX(i)} cy={scaleY(s.values[i])} r={4.5} fill={s.color} stroke="var(--gsi-color-surface)" strokeWidth={2} />
              <text x={scaleX(i) + 10} y={scaleY(s.values[i]) + 4} className="chart-value-text">
                {compact(s.values[i])}
              </text>
            </g>
          );
        })}
        {/* Hover bands: one hit area per x position, wider than the marks. */}
        {labels.map((l, i) => (
          <rect
            key={`hit-${l}`}
            x={scaleX(i) - innerW / Math.max(1, labels.length) / 2}
            y={pad.top}
            width={innerW / Math.max(1, labels.length)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => {
              setHover(i);
              setTip({
                x: (scaleX(i) / w) * 100,
                y: (pad.top / h) * 100,
                title: l,
                rows: series.map((s) => ({ label: s.label, value: format(s.values[i]), color: s.color })),
              });
            }}
            onMouseLeave={() => {
              setHover(null);
              setTip(null);
            }}
          />
        ))}
        {hover !== null ? (
          <line x1={scaleX(hover)} x2={scaleX(hover)} y1={pad.top} y2={pad.top + innerH} className="chart-crosshair" />
        ) : null}
      </svg>
      {node}
    </div>
  );
}

/** Magnitude ranking: horizontal bars on a single-hue ramp, value at the tip. */
export function BarList({
  rows,
  format,
  ramp,
}: {
  rows: { key: string; label: string; value: number }[];
  format: (v: number) => string;
  ramp?: string[];
}) {
  const { tip, setTip, node } = useTooltip();
  const colors = ramp ?? ['var(--gsi-viz-seq5)', 'var(--gsi-viz-seq4)', 'var(--gsi-viz-seq3)', 'var(--gsi-viz-seq2)', 'var(--gsi-viz-seq1)'];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="chart-wrap">
      <div className="barlist">
        {rows.map((r, i) => (
          <div
            key={r.key}
            className="barlist__row"
            onMouseEnter={() =>
              setTip({
                x: 50,
                y: ((i + 0.5) / rows.length) * 100,
                title: r.label,
                rows: [{ label: '', value: format(r.value) }],
              })
            }
            onMouseLeave={() => setTip(null)}
          >
            <span className="barlist__label" title={r.label}>
              {r.label}
            </span>
            <span className="barlist__track">
              <span
                className="barlist__bar"
                style={{
                  width: `${Math.max(1, (r.value / max) * 100)}%`,
                  background: colors[Math.min(i, colors.length - 1)],
                }}
              />
            </span>
            <span className="barlist__value">{format(r.value)}</span>
          </div>
        ))}
      </div>
      {node}
    </div>
  );
}

/** Money in vs money out per month, around a zero baseline. */
export function FlowColumns({
  labels,
  inflow,
  outflow,
  format,
  height = 220,
}: {
  labels: string[];
  inflow: number[];
  outflow: number[];
  format: (v: number) => string;
  height?: number;
}) {
  const { tip, setTip, node } = useTooltip();
  const w = 720;
  const pad = { top: 16, right: 16, bottom: 26, left: 56 };
  const innerW = w - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...inflow, ...outflow);
  const zero = pad.top + innerH / 2;
  const scale = (v: number) => (v / max) * (innerH / 2);
  const band = innerW / Math.max(1, labels.length);
  const barW = Math.min(18, band * 0.32);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${height}`} className="chart-svg" role="img">
        <line x1={pad.left} x2={w - pad.right} y1={zero} y2={zero} className="chart-grid" />
        {[max / 2, max].map((tv) => (
          <g key={tv}>
            <line x1={pad.left} x2={w - pad.right} y1={zero - scale(tv)} y2={zero - scale(tv)} className="chart-grid" />
            <line x1={pad.left} x2={w - pad.right} y1={zero + scale(tv)} y2={zero + scale(tv)} className="chart-grid" />
            <text x={pad.left - 8} y={zero - scale(tv) + 4} className="chart-axis-text" textAnchor="end">
              {compact(tv)}
            </text>
            <text x={pad.left - 8} y={zero + scale(tv) + 4} className="chart-axis-text" textAnchor="end">
              −{compact(tv)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          const cx = pad.left + band * i + band / 2;
          return (
            <g
              key={l}
              onMouseEnter={() =>
                setTip({
                  x: (cx / w) * 100,
                  y: (pad.top / height) * 100,
                  title: l,
                  rows: [
                    { label: '↑', value: format(inflow[i]), color: 'var(--gsi-viz-series3)' },
                    { label: '↓', value: format(outflow[i]), color: 'var(--gsi-viz-series2)' },
                  ],
                })
              }
              onMouseLeave={() => setTip(null)}
            >
              <rect x={pad.left + band * i} y={pad.top} width={band} height={innerH} fill="transparent" />
              {/* 2px surface gap keeps the two columns of a month visually separate */}
              <rect
                x={cx - barW - 1}
                y={zero - scale(inflow[i])}
                width={barW}
                height={Math.max(1, scale(inflow[i]))}
                fill="var(--gsi-viz-series3)"
                rx={3}
              />
              <rect
                x={cx + 1}
                y={zero}
                width={barW}
                height={Math.max(1, scale(outflow[i]))}
                fill="var(--gsi-viz-series2)"
                rx={3}
              />
              {i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1 ? (
                <text x={cx} y={height - 6} className="chart-axis-text" textAnchor="middle">
                  {l.slice(2)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

/**
 * One measure over time. Single series, so no legend — the title names it; the extreme
 * month is direct-labelled and the rest live in the tooltip and the table view.
 */
export function Columns({
  labels,
  values,
  format,
  color = 'var(--gsi-viz-seq4)',
  height = 220,
}: {
  labels: string[];
  values: number[];
  format: (v: number) => string;
  color?: string;
  height?: number;
}) {
  const { setTip, node } = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const w = 720;
  const pad = { top: 22, right: 16, bottom: 26, left: 56 };
  const innerW = w - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const ticks = niceTicks(0, Math.max(1, ...values), 3);
  const top = ticks[ticks.length - 1];
  const scaleY = (v: number) => pad.top + innerH - (v / top) * innerH;
  const band = innerW / Math.max(1, labels.length);
  const barW = Math.min(24, band * 0.6); // ≤24px marks, the band's leftover stays as air
  const peak = values.indexOf(Math.max(...values));

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${height}`} className="chart-svg" role="img">
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={pad.left} x2={w - pad.right} y1={scaleY(tv)} y2={scaleY(tv)} className="chart-grid" />
            <text x={pad.left - 8} y={scaleY(tv) + 4} className="chart-axis-text" textAnchor="end">
              {compact(tv)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          const cx = pad.left + band * i + band / 2;
          const h = Math.max(1, innerH - (scaleY(values[i]) - pad.top));
          return (
            <g
              key={l}
              onMouseEnter={() => {
                setHover(i);
                setTip({
                  x: (cx / w) * 100,
                  y: (scaleY(values[i]) / height) * 100,
                  title: l,
                  rows: [{ label: '', value: format(values[i]) }],
                });
              }}
              onMouseLeave={() => {
                setHover(null);
                setTip(null);
              }}
            >
              <rect x={pad.left + band * i} y={pad.top} width={band} height={innerH} fill="transparent" />
              <rect
                x={cx - barW / 2}
                y={scaleY(values[i])}
                width={barW}
                height={h}
                rx={4}
                fill={color}
                opacity={hover === null || hover === i ? 1 : 0.55}
              />
              {i === peak ? (
                <text x={cx} y={scaleY(values[i]) - 6} className="chart-value-text" textAnchor="middle">
                  {compact(values[i])}
                </text>
              ) : null}
              {i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1 ? (
                <text x={cx} y={height - 6} className="chart-axis-text" textAnchor="middle">
                  {l.slice(2)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

/** Headline number with an optional secondary line — not a one-bar chart. */
export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value${tone ? ` stat__value--${tone}` : ''}`}>{value}</div>
      {hint ? <div className="stat__hint">{hint}</div> : null}
    </div>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = (span / count) / step;
  const mult = err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const niceStep = step * mult;
  const start = Math.floor(min / niceStep) * niceStep;
  const end = Math.ceil(max / niceStep) * niceStep;
  const out: number[] = [];
  for (let v = start; v <= end + niceStep / 2; v += niceStep) out.push(Math.round(v * 100) / 100);
  return out.length > 1 ? out : [0, 1];
}

/** Axis/endpoint labels: 1.2M / 340k — full values live in the tooltip and table. */
export function compact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

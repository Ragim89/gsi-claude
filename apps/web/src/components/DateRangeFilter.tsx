import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@gsi/ui-kit/react';

export interface Range {
  from: string; // YYYY-MM-DD, '' = open ended
  to: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Presets on top of the calendar, because most questions are about a month or a quarter. */
export function presetRange(key: string): Range {
  const today = new Date();
  const start = (d: Date) => {
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };
  switch (key) {
    case 'month': {
      const d = start(new Date());
      d.setUTCDate(1);
      return { from: iso(d), to: iso(today) };
    }
    case 'quarter': {
      const d = start(new Date());
      d.setUTCMonth(d.getUTCMonth() - 2, 1);
      return { from: iso(d), to: iso(today) };
    }
    case '6m': {
      const d = start(new Date());
      d.setUTCMonth(d.getUTCMonth() - 5, 1);
      return { from: iso(d), to: iso(today) };
    }
    case 'year': {
      const d = start(new Date());
      d.setUTCMonth(d.getUTCMonth() - 11, 1);
      return { from: iso(d), to: iso(today) };
    }
    case 'ytd': {
      const d = start(new Date());
      d.setUTCMonth(0, 1);
      return { from: iso(d), to: iso(today) };
    }
    default:
      return { from: '', to: '' };
  }
}

export const DEFAULT_RANGE = presetRange('year');

/** `from`/`to` as query-string parameters, or '' when the range is open. */
export function rangeParams(range: Range): string {
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  return p.toString();
}

/**
 * Calendar range filter used on every list and dashboard: two native date pickers plus the
 * presets people actually ask for. Native inputs keep the OS calendar, locale and keyboard
 * entry — and cost no extra dependency.
 */
export function DateRangeFilter({
  value,
  onChange,
  presets = ['month', 'quarter', '6m', 'year'],
  label,
}: {
  value: Range;
  onChange: (r: Range) => void;
  presets?: string[];
  label?: string;
}) {
  const { t } = useTranslation();
  const active = useMemo(
    () => presets.find((p) => {
      const r = presetRange(p);
      return r.from === value.from && r.to === value.to;
    }),
    [presets, value],
  );

  return (
    <div className="daterange">
      <span className="daterange__label">{label ?? t('period.label')}</span>
      <Input
        type="date"
        aria-label={t('period.from')}
        value={value.from}
        max={value.to || undefined}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
      />
      <span className="daterange__dash">—</span>
      <Input
        type="date"
        aria-label={t('period.to')}
        value={value.to}
        min={value.from || undefined}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
      />
      <span className="daterange__presets">
        {presets.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={active === p ? 'primary' : 'secondary'}
            onClick={() => onChange(presetRange(p))}
          >
            {t(`period.presets.${p}`)}
          </Button>
        ))}
        {(value.from || value.to) && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ from: '', to: '' })}>
            {t('period.clear')}
          </Button>
        )}
      </span>
    </div>
  );
}

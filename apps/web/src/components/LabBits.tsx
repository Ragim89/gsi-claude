import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone } from '@gsi/ui-kit/react';
import {
  LocalizedText,
  SpecEvaluation,
  SpecificationSnapshot,
  TestRequest,
  TestRequestAction,
  TestRequestHistoryEntry,
  TestRequestStatus,
  TestResult,
  localize,
} from '@gsi/shared-types';
import { useFormatDate } from './common';

const STATUS_TONE: Record<TestRequestStatus, BadgeTone> = {
  requested: 'neutral',
  assigned: 'info',
  in_progress: 'accent',
  result_entered: 'accent',
  under_review: 'warning',
  approved: 'success',
  released: 'success',
  on_hold: 'warning',
  rejected: 'danger',
  cancelled: 'danger',
};

export function TestStatusBadge({ status }: { status: TestRequestStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`testStatus.${status}`)}</Badge>;
}

const EVALUATION_TONE: Record<SpecEvaluation, BadgeTone> = {
  within_spec: 'success',
  out_of_spec: 'danger',
  not_evaluated: 'neutral',
};

/**
 * Out of specification is stated, never softened and never hidden — the number stays what the
 * analyst measured and the badge says what it means against the limits that applied.
 */
export function EvaluationBadge({ evaluation }: { evaluation: SpecEvaluation }) {
  const { t } = useTranslation();
  return <Badge tone={EVALUATION_TONE[evaluation]}>{t(`evaluation.${evaluation}`)}</Badge>;
}

/** Moves a person has to explain before the system will make them. */
export const LAB_ACTIONS_NEEDING_REASON: TestRequestAction[] = ['return', 'amend', 'hold', 'reject', 'cancel'];

/** The limits in words: "max 14.5 %", "11.5–14 %", "min 76 kg/hl". */
export function useSpecText() {
  const { t } = useTranslation();
  return (spec: SpecificationSnapshot | null): string => {
    if (!spec) return '—';
    const unit = spec.unit ? ` ${spec.unit}` : '';
    if (spec.minValue != null && spec.maxValue != null) return `${spec.minValue}–${spec.maxValue}${unit}`;
    if (spec.maxValue != null) return t('lab.maxOf', { value: `${spec.maxValue}${unit}` });
    if (spec.minValue != null) return t('lab.minOf', { value: `${spec.minValue}${unit}` });
    if (spec.qualitativeRequirement) return spec.qualitativeRequirement;
    if (spec.targetValue != null) return t('lab.targetOf', { value: `${spec.targetValue}${unit}` });
    return '—';
  };
}

/**
 * The measured value, printed the way the analyst entered it. A boolean answer reads as the
 * laboratory says it — detected or not detected — rather than as true and false.
 */
export function ResultValue({ result }: { result: TestResult | null | undefined }) {
  const { t } = useTranslation();
  if (!result) return <span className="muted">—</span>;
  if (result.numericValue != null) {
    return (
      <span className="mono">
        {result.numericText ?? result.numericValue}
        {result.unit ? ` ${result.unit}` : ''}
      </span>
    );
  }
  if (result.booleanValue != null) return <span>{t(result.booleanValue ? 'lab.detected' : 'lab.notDetected')}</span>;
  if (result.qualitativeValue) return <span>{result.qualitativeValue}</span>;
  if (result.textValue) return <span>{result.textValue}</span>;
  return <span className="muted">—</span>;
}

export function useTestName() {
  const { i18n } = useTranslation();
  return (name: LocalizedText | undefined, fallback?: string | null) =>
    name ? localize(name, i18n.language) : (fallback ?? '—');
}

/** One line for a queue: what is being measured, on what, and where it has got to. */
export function requestLabel(r: TestRequest, testName: string) {
  return `${r.sampleNumber ?? ''} · ${testName}`;
}

export function LabTimeline({ history }: { history: TestRequestHistoryEntry[] }) {
  const { t } = useTranslation();
  const fmt = useFormatDate();

  return (
    <ol className="timeline">
      {history.map((entry, i) => (
        <li
          key={entry.id}
          className={i === history.length - 1 ? 'timeline__item timeline__item--last' : 'timeline__item'}
        >
          <span className={`timeline__dot timeline__dot--${entry.toStatus}`} />
          <div className="timeline__body">
            <div className="timeline__head">
              <strong>{t(`testStatus.${entry.toStatus}`)}</strong>
              <span className="muted">{fmt(entry.createdAt)}</span>
            </div>
            <div className="muted">
              {entry.changedByName ?? '—'}
              {entry.fromStatus
                ? ` · ${t(`testStatus.${entry.fromStatus}`)} → ${t(`testStatus.${entry.toStatus}`)}`
                : ''}
            </div>
            {entry.reason ? <div className="timeline__reason">{entry.reason}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The bar of laboratory actions; on a phone it sticks to the bottom of the screen. */
export function LabActionBar({
  actions,
  busy,
  onRun,
}: {
  actions: TestRequestAction[];
  busy: boolean;
  onRun(action: TestRequestAction): void;
}) {
  const { t } = useTranslation();
  if (!actions.length) return null;
  return (
    <div className="action-bar">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`action-bar__btn${
            ['start', 'submit', 'review', 'approve', 'release'].includes(action) ? ' action-bar__btn--primary' : ''
          }`}
          disabled={busy}
          onClick={() => onRun(action)}
        >
          {t(`testAction.${action}`)}
        </button>
      ))}
    </div>
  );
}

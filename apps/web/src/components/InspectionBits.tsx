import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone } from '@gsi/ui-kit/react';
import type {
  FindingSeverity,
  InspectionAction,
  InspectionStatus,
  InspectionStatusHistoryEntry,
} from '@gsi/shared-types';
import { useFormatDate } from './common';

const STATUS_TONE: Record<InspectionStatus, BadgeTone> = {
  draft: 'neutral',
  scheduled: 'info',
  in_progress: 'accent',
  completed: 'success',
  under_review: 'warning',
  approved: 'success',
  on_hold: 'warning',
  cancelled: 'danger',
};

export function InspectionStatusBadge({ status }: { status: InspectionStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`inspectionStatus.${status}`)}</Badge>;
}

const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  info: 'neutral',
  minor: 'info',
  major: 'warning',
  critical: 'danger',
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  const { t } = useTranslation();
  return <Badge tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Badge>;
}

/** Moves that a person has to explain before the system will make them. */
export const INSPECTION_ACTIONS_NEEDING_REASON: InspectionAction[] = ['hold', 'cancel', 'return', 'reopen'];

/**
 * What happened to an inspection, in order. Every line was written by the workflow engine
 * when the status actually changed — nothing here is reconstructed for display.
 */
export function InspectionTimeline({ history }: { history: InspectionStatusHistoryEntry[] }) {
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
              <strong>{t(`inspectionStatus.${entry.toStatus}`)}</strong>
              <span className="muted">{fmt(entry.createdAt)}</span>
            </div>
            <div className="muted">
              {entry.changedByName ?? '—'}
              {entry.fromStatus
                ? ` · ${t(`inspectionStatus.${entry.fromStatus}`)} → ${t(`inspectionStatus.${entry.toStatus}`)}`
                : ''}
            </div>
            {entry.reason ? <div className="timeline__reason">{entry.reason}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The bar of status actions. On a phone it sticks to the bottom of the screen, because an
 * inspector holding a handrail should not have to scroll to finish an inspection.
 */
export function ActionBar({
  actions,
  busy,
  onRun,
}: {
  actions: InspectionAction[];
  busy: boolean;
  onRun(action: InspectionAction): void;
}) {
  const { t } = useTranslation();
  if (!actions.length) return null;
  return (
    <div className="action-bar">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`action-bar__btn${['start', 'complete', 'approve'].includes(action) ? ' action-bar__btn--primary' : ''}`}
          disabled={busy}
          onClick={() => onRun(action)}
        >
          {t(`inspectionAction.${action}`)}
        </button>
      ))}
    </div>
  );
}

/** Answered / required, in the one place the field screen and the list both read from. */
export function ChecklistProgress({ done, total, required }: { done: number; total: number; required: number }) {
  const { t } = useTranslation();
  if (!total) return <span className="muted">{t('checklist.empty')}</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="progress">
        <div className="progress__bar" style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <span className="muted" style={{ fontSize: 12 }}>
        {t('checklist.progress', { done, total })}
        {required > 0 ? ` · ${t('inspection.requiredRemaining', { count: required })}` : ''}
      </span>
    </div>
  );
}

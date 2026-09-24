import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone } from '@gsi/ui-kit/react';
import type { JobAction, JobPriority, JobStatusHistoryEntry } from '@gsi/shared-types';
import { useFormatDate } from './common';

const PRIORITY_TONE: Record<JobPriority, BadgeTone> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

/** Urgency at a glance; normal is deliberately quiet so the loud ones stand out. */
export function PriorityBadge({ priority }: { priority: JobPriority }) {
  const { t } = useTranslation();
  if (priority === 'normal') return <span className="muted">{t('priority.normal')}</span>;
  return <Badge tone={PRIORITY_TONE[priority]}>{t(`priority.${priority}`)}</Badge>;
}

/**
 * What happened to a job, in order. Real entries only — every line here was written by the
 * workflow engine when the status actually changed.
 */
export function StatusTimeline({ history }: { history: JobStatusHistoryEntry[] }) {
  const { t } = useTranslation();
  const fmt = useFormatDate();

  return (
    <ol className="timeline">
      {history.map((entry, i) => (
        <li key={entry.id} className={i === history.length - 1 ? 'timeline__item timeline__item--last' : 'timeline__item'}>
          <span className={`timeline__dot timeline__dot--${entry.toStatus}`} />
          <div className="timeline__body">
            <div className="timeline__head">
              <strong>{t(`status.${entry.toStatus}`)}</strong>
              <span className="muted">{fmt(entry.createdAt)}</span>
            </div>
            <div className="muted">
              {entry.changedByName ?? '—'}
              {entry.fromStatus ? ` · ${t(`status.${entry.fromStatus}`)} → ${t(`status.${entry.toStatus}`)}` : ''}
            </div>
            {entry.reason ? <div className="timeline__reason">{entry.reason}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The label a button gets for an action; the API decides whether it is allowed. */
export function actionLabel(t: (key: string) => string, action: JobAction): string {
  return t(`jobAction.${action}`);
}

/** Moves that a person has to explain before the system will make them. */
export const ACTIONS_NEEDING_REASON: JobAction[] = ['hold', 'cancel', 'return'];


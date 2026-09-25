import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone } from '@gsi/ui-kit/react';
import type { ReportAction, ReportHistoryEntry, ReportStatus } from '@gsi/shared-types';
import { useFormatDate } from './common';

const STATUS_TONE: Record<ReportStatus, BadgeTone> = {
  draft: 'neutral',
  under_review: 'warning',
  changes_requested: 'warning',
  approved: 'info',
  issued: 'success',
  superseded: 'neutral',
  cancelled: 'danger',
  revoked: 'danger',
};

export function DocumentStatusBadge({ status }: { status: ReportStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`reportStatus.${status}`)}</Badge>;
}

/** Moves a person has to explain before the system will make them. */
export const REPORT_ACTIONS_NEEDING_REASON: ReportAction[] = ['request_changes', 'revise', 'cancel'];

export function ReportTimeline({ history }: { history: ReportHistoryEntry[] }) {
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
              <strong>{t(`reportStatus.${entry.toStatus}`)}</strong>
              <span className="muted">{fmt(entry.createdAt)}</span>
            </div>
            <div className="muted">
              {entry.changedByName ?? '—'}
              {entry.versionNumber ? ` · ${t('reports.version')} ${entry.versionNumber}` : ''}
            </div>
            {entry.reason ? <div className="timeline__reason">{entry.reason}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The bar of document actions; on a phone it sticks to the bottom of the screen. */
export function ReportActionBar({
  actions,
  busy,
  onRun,
}: {
  actions: ReportAction[];
  busy: boolean;
  onRun(action: ReportAction): void;
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
            ['submit', 'review', 'approve', 'issue'].includes(action) ? ' action-bar__btn--primary' : ''
          }`}
          disabled={busy}
          onClick={() => onRun(action)}
        >
          {t(`reportAction.${action}`)}
        </button>
      ))}
    </div>
  );
}

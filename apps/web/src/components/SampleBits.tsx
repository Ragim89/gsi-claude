import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone } from '@gsi/ui-kit/react';
import type {
  SampleAction,
  SampleCustodyEvent,
  SampleStatus,
  SampleStatusHistoryEntry,
  SealCondition,
} from '@gsi/shared-types';
import { useFormatDate } from './common';

const STATUS_TONE: Record<SampleStatus, BadgeTone> = {
  draft: 'neutral',
  collected: 'info',
  registered: 'info',
  sealed: 'accent',
  dispatched: 'accent',
  received_by_lab: 'warning',
  accepted_by_lab: 'success',
  rejected_by_lab: 'danger',
  on_hold: 'warning',
  cancelled: 'danger',
};

export function SampleStatusBadge({ status }: { status: SampleStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`sampleStatus.${status}`)}</Badge>;
}

const SEAL_TONE: Record<SealCondition, BadgeTone> = {
  intact: 'success',
  damaged: 'warning',
  broken: 'danger',
  missing: 'danger',
};

/** A seal is the whole point of the chain, so its state is never buried in small print. */
export function SealBadge({ number, state }: { number: string | null; state: SealCondition | null }) {
  const { t } = useTranslation();
  if (!number) return <span className="muted">{t('sample.noSeal')}</span>;
  return (
    <span className="row-actions">
      <span className="mono">{number}</span>
      {state ? <Badge tone={SEAL_TONE[state]}>{t(`sealCondition.${state}`)}</Badge> : null}
    </span>
  );
}

/** Moves that a person has to explain before the system will make them. */
export const SAMPLE_ACTIONS_NEEDING_REASON: SampleAction[] = ['hold', 'cancel', 'return'];

/** Moves that open a form rather than a confirmation. */
export const SAMPLE_ACTIONS_WITH_FORM: SampleAction[] = ['seal', 'dispatch', 'receive', 'reject'];

export function SampleTimeline({ history }: { history: SampleStatusHistoryEntry[] }) {
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
              <strong>{t(`sampleStatus.${entry.toStatus}`)}</strong>
              <span className="muted">{fmt(entry.createdAt)}</span>
            </div>
            <div className="muted">
              {entry.changedByName ?? '—'}
              {entry.fromStatus
                ? ` · ${t(`sampleStatus.${entry.fromStatus}`)} → ${t(`sampleStatus.${entry.toStatus}`)}`
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
 * The chain of custody, read as a sentence rather than a table: who handed what to whom, where
 * and in what state. A corrected entry stays on the timeline, struck through, with the
 * correction beneath it — that is what append-only has to look like to be worth anything.
 */
export function CustodyTimeline({ events }: { events: SampleCustodyEvent[] }) {
  const { t } = useTranslation();
  const fmt = useFormatDate();

  const who = (e: SampleCustodyEvent) => {
    const from = e.fromUserName ?? e.fromOfficeCode ?? e.fromLocation;
    const to = e.toUserName ?? e.toOfficeCode ?? e.laboratoryName ?? e.toLocation;
    if (from && to) return t('custody.fromTo', { from, to });
    if (to) return t('custody.to', { to });
    if (from) return t('custody.from', { from });
    return null;
  };

  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li
          key={e.id}
          className={[
            'timeline__item',
            i === events.length - 1 ? 'timeline__item--last' : '',
            e.correctedByEventId ? 'timeline__item--amended' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className={`timeline__dot timeline__dot--custody-${e.eventType}`} />
          <div className="timeline__body">
            <div className="timeline__head">
              <strong>{t(`custodyEvent.${e.eventType}`)}</strong>
              <span className="muted">{fmt(e.occurredAt)}</span>
            </div>
            <div className="muted">{who(e)}</div>
            <div className="row-actions" style={{ gap: 8 }}>
              {e.sealState ? <Badge tone={SEAL_TONE[e.sealState]}>{t(`sealCondition.${e.sealState}`)}</Badge> : null}
              {e.condition ? <span className="muted">{t(`sampleCondition.${e.condition}`)}</span> : null}
            </div>
            {e.notes ? <div className="timeline__reason">{e.notes}</div> : null}
            <div className="muted" style={{ fontSize: 12 }}>
              {t('custody.recordedBy', { name: e.recordedByName ?? '—' })}
              {e.correctedByEventId ? ` · ${t('custody.amended')}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The bar of status actions; on a phone it sticks to the bottom of the screen. */
export function SampleActionBar({
  actions,
  busy,
  onRun,
}: {
  actions: SampleAction[];
  busy: boolean;
  onRun(action: SampleAction): void;
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
            ['collect', 'register', 'seal', 'dispatch', 'receive', 'accept'].includes(action)
              ? ' action-bar__btn--primary'
              : ''
          }`}
          disabled={busy}
          onClick={() => onRun(action)}
        >
          {t(`sampleAction.${action}`)}
        </button>
      ))}
    </div>
  );
}

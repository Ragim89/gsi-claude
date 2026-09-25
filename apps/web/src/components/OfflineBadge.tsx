import { useTranslation } from 'react-i18next';
import { useOffline } from '../offline/OfflineProvider';

/**
 * Live status in the topbar: Offline / Queued / Syncing / Synced / Conflict / Failed. An
 * inspector standing in a warehouse with no signal should never have to guess whether today's
 * checklist actually saved.
 */
export function OfflineBadge() {
  const { t } = useTranslation();
  const { status, pendingCount, conflictCount, syncNow } = useOffline();

  if (status === 'synced') return null;

  const label =
    status === 'offline'
      ? t('offline.offline')
      : status === 'syncing'
        ? t('offline.syncing')
        : status === 'conflict'
          ? `${t('offline.conflict')} (${conflictCount})`
          : status === 'failed'
            ? t('offline.failed')
            : t('offline.queued');

  const clickable = status === 'failed' || status === 'queued';

  return (
    <button
      type="button"
      className={`offline-badge offline-badge--${status}`}
      onClick={clickable ? () => syncNow() : undefined}
      disabled={!clickable}
      title={pendingCount > 0 ? (t('offline.pendingCount', { count: pendingCount }) as string) : undefined}
    >
      <span className="offline-badge__dot" aria-hidden="true" />
      {label}
      {pendingCount > 0 && status !== 'conflict' ? ` · ${pendingCount}` : ''}
    </button>
  );
}

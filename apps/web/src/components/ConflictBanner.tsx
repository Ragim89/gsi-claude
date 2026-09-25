import { useTranslation } from 'react-i18next';
import { Alert, Button } from '@gsi/ui-kit/react';

/**
 * Shown instead of the generic error box when a save came back 409: the record changed on the
 * server since this form was filled. There is no silent merge — the person refreshes to see
 * the current version and re-applies their change on top of it.
 */
export function ConflictBanner({ onRefresh }: { onRefresh(): void }) {
  const { t } = useTranslation();
  return (
    <Alert tone="warning">
      <div className="stack" style={{ gap: 8 }}>
        <strong>{t('offline.conflictTitle')}</strong>
        <div>{t('offline.conflictBody')}</div>
        <div>
          <Button size="sm" onClick={onRefresh}>
            {t('offline.refreshAndReview')}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

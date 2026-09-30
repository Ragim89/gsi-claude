import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { ErrorBox, Loading } from './common';

/**
 * One reusable drilldown for every clickable KPI on Dashboard/Finance/Analytics/Operations.
 *
 * The caller passes exactly the same filters/scope its KPI number was computed from, and
 * fetches through the same permission-gated list endpoint the full list page already uses —
 * this is what keeps a drilldown's rows, period and RBAC identical to the tile it was opened
 * from, rather than a second query that could drift from it.
 */
export function KpiDrilldownDrawer({
  open,
  onClose,
  title,
  sub,
  loading,
  error,
  empty,
  children,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  sub?: ReactNode;
  loading?: boolean;
  error?: unknown;
  /** Shown instead of children when there is nothing to list. */
  empty?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="kpi-drawer__overlay" onClick={onClose}>
      <div className="kpi-drawer__panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="kpi-drawer__head">
          <div>
            <strong>{title}</strong>
            {sub ? <div className="muted">{sub}</div> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </Button>
        </div>
        <div className="kpi-drawer__body">
          <ErrorBox error={error} />
          {loading ? (
            <Loading />
          ) : empty ? (
            <div className="muted" style={{ padding: 'var(--gsi-space-4) 0' }}>
              {t('common.noResults')}
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';

/**
 * Page controls for a list that no longer loads everything at once.
 *
 * Shows where you are ("51–100 of 942") rather than only page numbers: with a filtered list
 * the total is the number people actually want to know.
 */
export function Pagination({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange(offset: number): void;
}) {
  const { t } = useTranslation();
  if (total <= limit) return null;

  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  const pages = Math.ceil(total / limit);
  const page = Math.floor(offset / limit) + 1;

  return (
    <div className="pagination">
      <span className="muted">{t('pagination.range', { from, to, total })}</span>
      <span className="row-actions">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onChange(0)}>
          ⏮
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          ←
        </Button>
        <span className="muted">{t('pagination.page', { page, pages })}</span>
        <Button
          variant="secondary"
          size="sm"
          disabled={to >= total}
          onClick={() => onChange(offset + limit)}
        >
          →
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={to >= total}
          onClick={() => onChange((pages - 1) * limit)}
        >
          ⏭
        </Button>
      </span>
    </div>
  );
}

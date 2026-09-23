import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@gsi/ui-kit/react';
import { downloadFile } from '../api';
import { ErrorBox } from './common';

/**
 * Downloads one section as CSV, or every section the user may see as a ZIP.
 *
 * The separator follows the interface language, because that is what the person's Excel most
 * likely expects: semicolon with decimal commas for Russian and Turkish, comma with decimal
 * points for English. Both are offered — a long press is not discoverable, so the second
 * option sits behind a small menu.
 */
export function ExportButton({
  section,
  params = '',
  label,
  variant = 'secondary',
}: {
  /** Section name, or 'all' for the full archive. */
  section: string;
  /** Filters to carry over, already query-encoded (branchId, from, to, …). */
  params?: string;
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);

  const defaultSep = i18n.language === 'en' ? 'comma' : 'semicolon';

  async function run(sep: string) {
    setOpen(false);
    setBusy(true);
    setError(null);
    const today = new Date().toISOString().slice(0, 10);
    const name = section === 'all' ? `gsi-export-${today}.zip` : `gsi-${section}-${today}.csv`;
    try {
      const qs = [params, `sep=${sep}`, `locale=${i18n.language}`].filter(Boolean).join('&');
      await downloadFile(`/export/${section}?${qs}`, name);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="export">
      <span className="row-actions" style={{ gap: 0 }}>
        <Button variant={variant} loading={busy} onClick={() => run(defaultSep)} className="export__main">
          ⤓ {label ?? (section === 'all' ? t('export.all') : t('export.csv'))}
        </Button>
        <Button variant={variant} onClick={() => setOpen((v) => !v)} aria-label={t('export.options')} className="export__more">
          ▾
        </Button>
      </span>
      {open && (
        <span className="export__menu">
          <button type="button" onClick={() => run('semicolon')}>
            {t('export.semicolon')}
          </button>
          <button type="button" onClick={() => run('comma')}>
            {t('export.comma')}
          </button>
        </span>
      )}
      {error ? <ErrorBox error={error} /> : null}
    </span>
  );
}

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, BadgeTone, Button, Card, EmptyState, Table } from '@gsi/ui-kit/react';
import { api, downloadFile } from '../api';
import { ErrorBox, Loading, PageHead } from '../components/common';

/** A problem with one row, as a code plus parameters so it can be shown in any language. */
interface Issue {
  code: string;
  params?: Record<string, string | number>;
}

interface RowResult {
  row: number;
  action: 'create' | 'update' | 'error';
  key: string;
  errors: Issue[];
  warnings: Issue[];
  preview: Record<string, unknown>;
}

interface ImportReport {
  section: string;
  total: number;
  toCreate: number;
  toUpdate: number;
  invalid: number;
  unknownColumns: string[];
  rows: RowResult[];
  created?: number;
  updated?: number;
}

/**
 * Bulk load of data a company already keeps in Excel: assets, open invoices, costs, clients.
 *
 * Deliberately a two-step flow — check, then write. The preview runs the exact same validation
 * as the import itself, so what it shows is what will happen; nothing is written until the
 * person presses the second button.
 */
export function ImportPage() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState('assets');
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);

  const sections = useQuery({
    queryKey: ['import-sections'],
    queryFn: () => api.get<{ sections: string[] }>('/import/sections'),
  });

  const sep = i18n.language === 'en' ? 'comma' : 'semicolon';

  function pick(next: File | null) {
    setFile(next);
    setReport(null);
    setDone(null);
    setError(null);
  }

  function chooseSection(name: string) {
    setSection(name);
    pick(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function send(step: 'preview' | 'commit') {
    if (!file) return;
    setBusy(step);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const path = step === 'preview' ? `/import/${section}/preview` : `/import/${section}`;
      const result = await api.upload<ImportReport>(path, form);
      if (step === 'preview') {
        setReport(result);
      } else {
        setDone(result);
        setReport(null);
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        // Everything downstream of an import changes at once.
        await qc.invalidateQueries();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (sections.isLoading) return <Loading />;
  const available = sections.data?.sections ?? [];

  return (
    <div className="stack">
      <PageHead
        title={t('import.title')}
        sub={t('import.sub')}
        actions={
          <Button
            variant="secondary"
            onClick={() =>
              downloadFile(`/import/${section}/template?sep=${sep}`, `gsi-import-${section}-template.csv`)
            }
          >
            ⤓ {t('import.template')}
          </Button>
        }
      />

      <Card title={t('import.step1')}>
        <div className="chips">
          {available.map((name) => (
            <button
              key={name}
              type="button"
              className={`chip${name === section ? ' chip--on' : ''}`}
              onClick={() => chooseSection(name)}
            >
              {t(`import.sections.${name}`)}
            </button>
          ))}
        </div>
        <p className="muted" style={{ marginTop: 'var(--gsi-space-3)' }}>
          {t(`import.hints.${section}`)}
        </p>
      </Card>

      <Card title={t('import.step2')}>
        <div
          className={`dropzone${dragging ? ' dropzone--over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) pick(dropped);
          }}
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv,text/csv"
            hidden
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          <strong>{file ? file.name : t('import.drop')}</strong>
          <span className="muted">{file ? `${Math.round(file.size / 1024)} KB` : t('import.formats')}</span>
        </div>

        <div className="row-actions" style={{ marginTop: 'var(--gsi-space-4)' }}>
          <Button disabled={!file} loading={busy === 'preview'} onClick={() => send('preview')}>
            {t('import.check')}
          </Button>
          {report && (
            <Button
              variant="primary"
              disabled={report.toCreate + report.toUpdate === 0}
              loading={busy === 'commit'}
              onClick={() => send('commit')}
            >
              {t('import.commit', { count: report.toCreate + report.toUpdate })}
            </Button>
          )}
        </div>
        {error ? <ErrorBox error={error} /> : null}
      </Card>

      {done && (
        <Alert tone="success">
          {t('import.done', { created: done.created ?? 0, updated: done.updated ?? 0, skipped: done.invalid })}
        </Alert>
      )}

      {(report ?? done) && <ReportView report={(report ?? done)!} committed={!report} />}
    </div>
  );
}

/**
 * Turns an issue code into a sentence in the current language. Field names and enum values
 * carried in the parameters are translated too — they arrive as the internal keys.
 */
function useIssueText() {
  const { t } = useTranslation();
  return (i: Issue) => {
    const p: Record<string, string | number> = { ...i.params };
    if (typeof p.field === 'string') p.field = t(`import.fields.${p.field}`, { defaultValue: p.field });
    for (const key of ['value', 'fallback']) {
      const v = p[key];
      if (typeof v === 'string') {
        p[key] = t([`assetCategories.${v}`, `assetStatus.${v}`, `expenseCategories.${v}`, `invoiceStatus.${v}`], {
          defaultValue: v,
        });
      }
    }
    return t(`import.errors.${i.code}`, { defaultValue: i.code, ...p });
  };
}

function ReportView({ report, committed }: { report: ImportReport; committed: boolean }) {
  const { t } = useTranslation();
  const issueText = useIssueText();
  const problems = report.rows.filter((r) => r.errors.length || r.warnings.length);

  return (
    <Card title={committed ? t('import.result') : t('import.step3')}>
      <div className="import-stats">
        <Stat label={t('import.rows')} value={report.total} />
        <Stat label={t('import.willCreate')} value={report.toCreate} tone="success" />
        <Stat label={t('import.willUpdate')} value={report.toUpdate} tone="info" />
        <Stat label={t('import.withErrors')} value={report.invalid} tone={report.invalid ? 'danger' : 'neutral'} />
      </div>

      {report.unknownColumns.length > 0 && (
        <Alert tone="warning">{t('import.unknownColumns', { columns: report.unknownColumns.join(', ') })}</Alert>
      )}

      {problems.length === 0 ? (
        <EmptyState>{t('import.allClean')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th style={{ width: 70 }}>{t('import.row')}</th>
              <th style={{ width: 120 }}>{t('import.action')}</th>
              <th>{t('import.record')}</th>
              <th>{t('import.problems')}</th>
            </tr>
          </thead>
          <tbody>
            {problems.map((r) => (
              <tr key={r.row}>
                <td>{r.row}</td>
                <td>
                  <Badge tone={r.action === 'error' ? 'danger' : r.action === 'update' ? 'info' : 'success'}>
                    {t(`import.actions.${r.action}`)}
                  </Badge>
                </td>
                <td>{r.key || '—'}</td>
                <td>
                  {r.errors.map((e, i) => (
                    <div key={`e${i}`} className="import-msg import-msg--error">
                      {issueText(e)}
                    </div>
                  ))}
                  {r.warnings.map((w, i) => (
                    <div key={`w${i}`} className="import-msg import-msg--warn">
                      {issueText(w)}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {report.rows.length < report.total && (
        <p className="muted">{t('import.truncated', { shown: report.rows.length, total: report.total })}</p>
      )}
    </Card>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: BadgeTone }) {
  return (
    <div className={`import-stat import-stat--${tone}`}>
      <span className="import-stat__value">{value}</span>
      <span className="import-stat__label">{label}</span>
    </div>
  );
}

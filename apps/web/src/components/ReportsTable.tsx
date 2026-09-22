import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge, Button, EmptyState, Table } from '@gsi/ui-kit/react';
import { Report } from '@gsi/shared-types';
import { downloadFile } from '../api';
import { ErrorBox, useFormatDate, useServiceLabel } from './common';

export function ReportsTable({ reports, showJob = true, emptyText }: { reports: Report[]; showJob?: boolean; emptyText: string }) {
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function download(r: Report) {
    setBusy(r.id);
    setError(null);
    try {
      await downloadFile(`/reports/${r.id}/pdf`, `${r.reportNumber}-v${r.version}.pdf`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!reports.length) return <EmptyState>{emptyText}</EmptyState>;

  return (
    <>
      <ErrorBox error={error} />
      <Table>
        <thead>
          <tr>
            <th>{t('reports.number')}</th>
            <th>{t('reports.version')}</th>
            {showJob && <th>{t('reports.job')}</th>}
            {showJob && <th>{t('reports.service')}</th>}
            <th>{t('reports.issued')}</th>
            <th>{t('reports.approvedBy')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td className="mono">
                {r.reportNumber} {r.status !== 'issued' && <Badge tone="danger">{r.status}</Badge>}
              </td>
              <td>{r.version}</td>
              {showJob && (
                <td className="mono">
                  <Link to={`/jobs/${r.jobId}`}>{r.jobNumber}</Link>
                </td>
              )}
              {showJob && <td>{r.serviceType ? serviceLabel(r.serviceType) : '—'}</td>}
              <td>{fmt(r.approvedAt)}</td>
              <td>{r.approvedByName ?? '—'}</td>
              <td style={{ textAlign: 'end' }}>
                <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => download(r)}>
                  ⤓ {t('reports.download')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

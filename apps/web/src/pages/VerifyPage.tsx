import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Logo } from '@gsi/ui-kit/react';
import { ReportVerification } from '@gsi/shared-types';
import { api } from '../api';
import { Loading, useFormatDate, useServiceLabel } from '../components/common';

/** Public page behind the QR code on every issued report — no login required. */
export function VerifyPage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const q = useQuery({
    queryKey: ['verify', token],
    queryFn: () => api.get<ReportVerification>(`/public/verify/${encodeURIComponent(token ?? '')}`),
  });

  const r = q.data;
  return (
    <div className="login">
      <div className="login__panel" style={{ maxWidth: 480 }}>
        <div className="login__brand">
          <Logo variant="wordmark" height={48} />
        </div>
        <Card title={t('verify.title')}>
          {q.isLoading ? (
            <Loading />
          ) : !r || !r.reportNumber ? (
            <Alert>{t('verify.invalid')}</Alert>
          ) : (
            <div className="stack">
              <Alert tone={r.valid ? 'success' : 'danger'}>{r.valid ? t('verify.valid') : t('verify.revoked')}</Alert>
              <dl className="detail-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <dt>{t('reports.number')}</dt>
                  <dd className="mono">{r.reportNumber}</dd>
                </div>
                <div>
                  <dt>{t('reports.issued')}</dt>
                  <dd>{fmt(r.issuedAt, false)}</dd>
                </div>
                <div>
                  <dt>{t('reports.service')}</dt>
                  <dd>{r.serviceType ? serviceLabel(r.serviceType) : '—'}</dd>
                </div>
                <div>
                  <dt>{t('jobs.client')}</dt>
                  <dd>{r.clientName}</dd>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt>{t('common.branch')}</dt>
                  <dd>{r.branch}</dd>
                </div>
              </dl>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

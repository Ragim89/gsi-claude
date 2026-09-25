import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Badge, Card, Logo } from '@gsi/ui-kit/react';
import { DocumentVerification } from '@gsi/shared-types';
import { api } from '../api';
import { Loading, useFormatDate } from '../components/common';

/**
 * The public page behind the QR code on every issued document — no login required.
 *
 * It answers about the copy in the reader's hand: the revision that carries this code. A copy
 * a later revision replaced says so plainly, and a cancelled document says it was cancelled
 * rather than pretending not to exist — a check that hides the awkward cases is not a check.
 *
 * It deliberately does not name the client. Whoever holds the document already knows whose it
 * is; whoever merely found the code should not learn it here.
 */
export function VerifyPage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const fmt = useFormatDate();
  const q = useQuery({
    queryKey: ['verify', token],
    queryFn: () => api.get<DocumentVerification>(`/public/verify/${encodeURIComponent(token ?? '')}`),
  });

  const r = q.data;
  const tone = r?.valid ? 'success' : r?.status === 'superseded' ? 'warning' : 'danger';
  const headline = !r?.reportNumber
    ? t('verify.invalid')
    : r.valid
      ? t('verify.valid')
      : r.status === 'superseded'
        ? t('verify.superseded', { version: r.supersededBy })
        : r.status === 'cancelled' || r.status === 'revoked'
          ? t('verify.cancelled')
          : t('verify.notIssued');

  return (
    <div className="login">
      <div className="login__panel" style={{ maxWidth: 520 }}>
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
              <Alert tone={tone}>{headline}</Alert>
              {r.cancelledReason ? <p className="muted">{r.cancelledReason}</p> : null}
              <dl className="detail-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <dt>{t('reports.number')}</dt>
                  <dd className="mono">{r.reportNumber}</dd>
                </div>
                <div>
                  <dt>{t('reports.type')}</dt>
                  <dd>{r.reportType ? t(`reportType.${r.reportType}`) : '—'}</dd>
                </div>
                <div>
                  <dt>{t('reports.version')}</dt>
                  <dd>
                    {r.version}{' '}
                    {r.status ? <Badge tone={tone}>{t(`reportStatus.${r.status}`)}</Badge> : null}
                  </dd>
                </div>
                <div>
                  <dt>{t('reports.issued')}</dt>
                  <dd>{fmt(r.issuedAt, false)}</dd>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <dt>{t('verify.issuer')}</dt>
                  <dd>{r.issuer ?? '—'}</dd>
                </div>
                {r.checksum ? (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <dt>{t('verify.checksum')}</dt>
                    <dd className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {r.checksum}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="muted" style={{ fontSize: 12 }}>
                {t('verify.note')}
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

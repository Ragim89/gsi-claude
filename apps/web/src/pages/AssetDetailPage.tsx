import { ChangeEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Spinner, Table } from '@gsi/ui-kit/react';
import { Asset, AssetDepreciationEntry } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { Columns } from '../components/charts';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';
import { ASSET_TONE } from './AssetsPage';

type AssetCard = Asset & { history: AssetDepreciationEntry[] };

/** One asset: its card, photo, depreciation schedule so far, and disposal. */
export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const photoInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const canWrite = can('asset.create', 'asset.update');

  const q = useQuery({ queryKey: ['asset', id], queryFn: () => api.get<AssetCard>(`/assets/${id}`) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['asset', id] });
    qc.invalidateQueries({ queryKey: ['assets'] });
    qc.invalidateQueries({ queryKey: ['asset-summary'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const dispose = useMutation({
    mutationFn: (body: { amount?: number | null; note?: string | null; writeOff?: boolean }) =>
      api.post<Asset>(`/assets/${id}/dispose`, body),
    onSuccess: invalidate,
  });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<Asset>(`/assets/${id}/photo`, form);
    },
    onSettled: () => {
      setUploading(false);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/assets/${id}`),
    onSuccess: () => {
      invalidate();
      navigate('/assets');
    },
  });

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    upload.mutate(file);
  }

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const a = q.data;

  const money = (v: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: a.currency, maximumFractionDigits: 2 }).format(v);
  const nbv = a.netBookValue ?? a.acquisitionCost - a.accumulated;
  const progress = a.acquisitionCost > 0 ? Math.min(100, Math.round((a.accumulated / a.acquisitionCost) * 100)) : 0;
  const history = [...a.history].reverse();
  const active = a.status !== 'disposed' && a.status !== 'written_off';

  const detail = (label: string, value: string | number | null | undefined, mono = false) => (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value || value === 0 ? value : '—'}</dd>
    </div>
  );

  return (
    <div className="stack">
      <PageHead
        title={
          <span className="row-actions">
            <span className="mono" style={{ fontSize: 'inherit' }}>{a.inventoryNo}</span>
            <span>{a.name}</span>
            <Badge tone={ASSET_TONE[a.status]}>{t(`assetStatus.${a.status}`)}</Badge>
          </span>
        }
        sub={`${t(`assetCategories.${a.category}`)}${a.branchCode ? ` · ${a.branchCode}` : ''}${a.serialNo ? ` · ${a.serialNo}` : ''}`}
        actions={
          canWrite && (
            <>
              <Button variant="secondary" loading={uploading} onClick={() => photoInput.current?.click()}>
                📷 {t('assets.photo')}
              </Button>
              <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick} />
              {active && (
                <>
                  <Button
                    variant="secondary"
                    disabled={dispose.isPending}
                    onClick={() => {
                      const raw = window.prompt(t('assets.disposePrompt'), '');
                      if (raw === null) return;
                      const amount = Number(raw.replace(',', '.'));
                      dispose.mutate({ amount: Number.isFinite(amount) && amount > 0 ? amount : null });
                    }}
                  >
                    {t('assets.dispose')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={dispose.isPending}
                    onClick={() => window.confirm(t('assets.writeOffConfirm')) && dispose.mutate({ writeOff: true })}
                  >
                    {t('assets.writeOff')}
                  </Button>
                </>
              )}
              {!a.history.length && (
                <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate()}>
                  {t('common.delete')}
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorBox error={dispose.error ?? upload.error ?? remove.error} />

      <div className="two-col">
        <div className="stack">
          <Card title={t('assets.depreciationCard')}>
            <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              <div className="stat">
                <div className="stat__label">{t('assets.cost')}</div>
                <div className="stat__value" style={{ fontSize: 20 }}>{money(a.acquisitionCost)}</div>
              </div>
              <div className="stat">
                <div className="stat__label">{t('assets.accumulated')}</div>
                <div className="stat__value" style={{ fontSize: 20 }}>{money(a.accumulated)}</div>
              </div>
              <div className="stat">
                <div className="stat__label">{t('assets.netBookValue')}</div>
                <div className="stat__value stat__value--positive" style={{ fontSize: 20 }}>{money(nbv)}</div>
              </div>
              <div className="stat">
                <div className="stat__label">{t('assets.monthlyCharge')}</div>
                <div className="stat__value" style={{ fontSize: 20 }}>
                  {a.monthlyDepreciation ? money(a.monthlyDepreciation) : '—'}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                <span className="muted">{t('assets.depreciated', { pct: progress })}</span>
                <span className="muted">
                  {a.remainingMonths == null ? '' : t('assets.remainingMonths', { count: a.remainingMonths })}
                </span>
              </div>
              <div className="progress" style={{ marginTop: 6 }}>
                <div className="progress__bar" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {history.length > 1 && (
              <div style={{ marginTop: 20 }}>
                <Columns
                  labels={history.map((h) => h.period.slice(0, 7))}
                  values={history.map((h) => h.amount)}
                  format={money}
                  height={180}
                />
              </div>
            )}
          </Card>

          <Card title={t('assets.history')}>
            {!history.length ? (
              <EmptyState>{t('assets.noHistory')}</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>{t('dashboard.month')}</th>
                    <th>{t('assets.depreciation')}</th>
                    <th>{t('assets.accumulated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().map((h) => (
                    <tr key={h.id}>
                      <td>{h.period.slice(0, 7)}</td>
                      <td>{money(h.amount)}</td>
                      <td>{money(h.accumulated)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <div className="stack">
          {a.photoUrl ? (
            <Card>
              <img src={a.photoUrl} alt="" style={{ width: '100%', borderRadius: 6, display: 'block' }} />
            </Card>
          ) : null}

          <Card title={t('assets.details')}>
            <dl className="detail-grid" style={{ gridTemplateColumns: '1fr' }}>
              {detail(t('assets.inventoryNo'), a.inventoryNo, true)}
              {detail(t('assets.serialNo'), a.serialNo, true)}
              {detail(t('assets.location'), a.location)}
              {detail(t('assets.responsible'), a.responsibleName)}
              {detail(t('assets.acquisitionDate'), fmt(a.acquisitionDate, false))}
              {detail(t('assets.usefulLife'), a.usefulLifeMonths ? t('assets.months', { count: a.usefulLifeMonths }) : '—')}
              {detail(t('assets.salvage'), money(a.salvageValue))}
              {detail(t('assets.method'), t(`depreciationMethods.${a.method}`))}
              {detail(t('assets.depreciatedThrough'), a.depreciatedThrough ? a.depreciatedThrough.slice(0, 7) : '—')}
              {a.disposedOn ? detail(t('assets.disposedOn'), fmt(a.disposedOn, false)) : null}
              {a.disposalAmount ? detail(t('assets.disposalAmount'), money(a.disposalAmount)) : null}
            </dl>
            {a.notes ? <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</p> : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

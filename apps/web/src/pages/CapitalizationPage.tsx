import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Card, Table } from '@gsi/ui-kit/react';
import { Asset, CapitalizationLine, CapitalizationSnapshot } from '@gsi/shared-types';
import { api } from '../api';
import { useBranch } from '../branch';
import { StatTile } from '../components/charts';
import { KpiDrilldownDrawer } from '../components/KpiDrilldownDrawer';
import { ErrorBox, Loading, PageHead } from '../components/common';

type Line = 'cash' | 'receivable' | 'netAssets' | 'payable' | 'otherLiabilities';

/**
 * Cash + receivables + net assets (after depreciation) − payables − other liabilities.
 *
 * Every figure is read straight from Finance/Payments/Invoices/Expenses/Assets/Ledger — this
 * page adds no numbers of its own, only the breakdown and the drilldowns.
 */
export function CapitalizationPage() {
  const { t, i18n } = useTranslation();
  const { branchId, current } = useBranch();
  const [drill, setDrill] = useState<Line | null>(null);

  const snapshot = useQuery({
    queryKey: ['capitalization', branchId],
    queryFn: () => api.get<CapitalizationSnapshot>(`/finance/capitalization${branchId ? `?branchId=${branchId}` : ''}`),
  });

  const assets = useQuery({
    queryKey: ['assets', 'capitalization-drill', branchId],
    queryFn: () => api.get<Asset[]>(`/assets${branchId ? `?branchId=${branchId}` : ''}`),
    enabled: drill === 'netAssets',
  });

  const s = snapshot.data;
  const base = (v: number) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: s?.baseCurrency ?? 'EUR', maximumFractionDigits: 0 }).format(v);
  const local = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);

  const lineLabel: Record<Line, string> = {
    cash: t('capitalization.cash'),
    receivable: t('capitalization.receivable'),
    netAssets: t('capitalization.netAssets'),
    payable: t('capitalization.payable'),
    otherLiabilities: t('capitalization.otherLiabilities'),
  };

  return (
    <div className="stack">
      <PageHead
        title={t('capitalization.title')}
        sub={branchId && current ? `${current.code} — ${current.city}` : s ? t('dashboard.inCurrency', { currency: s.baseCurrency }) : undefined}
      />
      <ErrorBox error={snapshot.error} />

      {snapshot.isLoading || !s ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-row">
            <StatTile label={lineLabel.cash} value={base(s.cash.amountBase)} tone="positive" onClick={() => setDrill('cash')} />
            <StatTile label={lineLabel.receivable} value={base(s.receivable.amountBase)} onClick={() => setDrill('receivable')} />
            <StatTile label={lineLabel.netAssets} value={base(s.netAssets.amountBase)} onClick={() => setDrill('netAssets')} />
            <StatTile label={lineLabel.payable} value={base(s.payable.amountBase)} tone="negative" onClick={() => setDrill('payable')} />
            <StatTile
              label={lineLabel.otherLiabilities}
              value={s.otherLiabilities.tracked ? base(s.otherLiabilities.amountBase) : t('capitalization.notTracked')}
              hint={!s.otherLiabilities.tracked ? t('capitalization.notTrackedHint') : undefined}
            />
          </div>

          <Card title={t('capitalization.netPosition')}>
            <div className="stat">
              <div className="stat__label">{t('capitalization.netPositionHint')}</div>
              <div className={`stat__value${s.netPositionBase >= 0 ? ' stat__value--positive' : ' stat__value--negative'}`}>
                {base(s.netPositionBase)}
              </div>
            </div>
          </Card>

          <KpiDrilldownDrawer
            open={drill !== null}
            onClose={() => setDrill(null)}
            title={drill ? lineLabel[drill] : ''}
            loading={drill === 'netAssets' ? assets.isLoading : false}
            error={drill === 'netAssets' ? assets.error : undefined}
            empty={
              drill === 'netAssets'
                ? !(assets.data ?? []).length
                : drill !== null && drill !== 'otherLiabilities' && !s[drill].byCurrency.length
            }
          >
            {drill === 'netAssets' ? (
              <Table>
                <thead>
                  <tr>
                    <th>{t('assets.inventoryNo')}</th>
                    <th>{t('assets.name')}</th>
                    <th>{t('assets.cost')}</th>
                    <th>{t('assets.netBookValue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(assets.data ?? []).map((a) => (
                    <tr key={a.id}>
                      <td className="mono">{a.inventoryNo}</td>
                      <td>{a.name}</td>
                      <td>{local(a.acquisitionCost, a.currency)}</td>
                      <td>{local(a.netBookValue ?? 0, a.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : drill === 'otherLiabilities' ? (
              <p className="muted">{t('capitalization.notTrackedHint')}</p>
            ) : drill ? (
              <Table>
                <thead>
                  <tr>
                    <th>{t('common.currency')}</th>
                    <th>{t('expenses.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(s[drill] as CapitalizationLine).byCurrency.map((row) => (
                    <tr key={row.currency}>
                      <td className="mono">{row.currency}</td>
                      <td>{local(row.amount, row.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </KpiDrilldownDrawer>
        </>
      )}
    </div>
  );
}

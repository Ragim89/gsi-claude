import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import { Client, INVOICE_STATUSES, Invoice, InvoiceStatus, InvoiceSummary, Page } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, LineChart, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ExportButton } from '../components/ExportButton';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

export const INVOICE_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: 'neutral',
  issued: 'info',
  partially_paid: 'warning',
  paid: 'success',
  cancelled: 'danger',
};

interface LineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
}

/** Client billing: collection analytics first, the register below. */
export function InvoicesPage() {
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const { branchId, current } = useBranch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [creating, setCreating] = useState(false);

  const canWrite = can('invoice.create', 'invoice.issue');
  // The calendar range and the branch filter scope both the analytics and the register.
  const scope = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');

  const summary = useQuery({
    queryKey: ['invoice-summary', scope],
    queryFn: () => api.get<InvoiceSummary>(`/finance/invoices-summary?${scope}`),
  });
  const invoices = useQuery({
    queryKey: ['invoices', status, onlyOverdue, branchId],
    queryFn: () =>
      api.get<Invoice[]>(
        `/finance/invoices?${status ? `status=${status}&` : ''}${onlyOverdue ? 'overdue=true&' : ''}${branchId ? `branchId=${branchId}` : ''}`,
      ),
  });

  const s = summary.data;
  const base = useMemo(() => {
    const currency = s?.baseCurrency ?? 'EUR';
    return (v: number) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  }, [s?.baseCurrency, i18n.language]);
  const local = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post<Invoice>(`/finance/invoices/${id}/${action}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice-summary'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  return (
    <div className="stack">
      <PageHead
        title={t('invoices.title')}
        sub={
          <>
            {branchId && current ? `${flag(current.country)} ${current.code} — ${current.city} · ` : ''}
            {s ? `${t('dashboard.period', { from: s.period.from, to: s.period.to })} · ${t('dashboard.inCurrency', { currency: s.baseCurrency })}` : ''}
          </>
        }
        actions={
          <>
            <DateRangeFilter value={range} onChange={setRange} />
            <ExportButton section="invoices" params={scope} />
            {canWrite && !creating && <Button onClick={() => setCreating(true)}>+ {t('invoices.new')}</Button>}
          </>
        }
      />

      <ErrorBox error={summary.error ?? act.error} />

      {summary.isLoading || !s ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-row">
            <StatTile
              label={t('invoices.issuedTotal')}
              value={base(s.totals.issuedBase)}
              hint={t('invoices.invoiceCount', { count: s.totals.invoiceCount })}
            />
            <StatTile label={t('invoices.collected')} value={base(s.totals.collectedBase)} tone="positive" />
            <StatTile
              label={t('invoices.collectionRate')}
              value={s.totals.collectionRatePct === null ? '—' : `${s.totals.collectionRatePct}%`}
              hint={s.totals.avgDaysToPay !== null ? t('invoices.avgDaysToPay', { days: s.totals.avgDaysToPay }) : undefined}
            />
            <StatTile label={t('invoices.outstanding')} value={base(s.totals.outstandingBase)} />
            <StatTile
              label={t('invoices.overdue')}
              value={base(s.totals.overdueBase)}
              tone={s.totals.overdueBase > 0 ? 'negative' : undefined}
              hint={s.totals.draftCount > 0 ? t('invoices.drafts', { count: s.totals.draftCount }) : undefined}
            />
          </div>

          <div className="chart-grid">
            <ChartFrame
              title={t('invoices.issuedVsCollected')}
              subtitle={t('invoices.issuedVsCollectedSub')}
              legend={[
                { label: t('invoices.issuedShort'), color: 'var(--gsi-viz-series1)' },
                { label: t('invoices.collectedShort'), color: 'var(--gsi-viz-series3)' },
              ]}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('dashboard.month')}</th>
                      <th>{t('invoices.issuedShort')}</th>
                      <th>{t('invoices.collectedShort')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.monthly.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td>{base(m.issuedBase)}</td>
                        <td>{base(m.collectedBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <LineChart
                labels={s.monthly.map((m) => m.month)}
                format={base}
                series={[
                  { key: 'issued', label: t('invoices.issuedShort'), color: 'var(--gsi-viz-series1)', values: s.monthly.map((m) => m.issuedBase) },
                  { key: 'collected', label: t('invoices.collectedShort'), color: 'var(--gsi-viz-series3)', values: s.monthly.map((m) => m.collectedBase) },
                ]}
              />
            </ChartFrame>

            <ChartFrame
              title={t('dashboard.arAging')}
              subtitle={t('dashboard.arAgingSub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('dashboard.bucket')}</th>
                      <th>{t('expenses.amount')}</th>
                      <th>{t('dashboard.invoices')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.aging.map((b) => (
                      <tr key={b.bucket}>
                        <td>{b.bucket}</td>
                        <td>{base(b.amountBase)}</td>
                        <td>{b.invoiceCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.aging.map((b) => ({
                  key: b.bucket,
                  label: `${t('dashboard.days', { range: b.bucket })} · ${b.invoiceCount}`,
                  value: b.amountBase,
                }))}
                format={base}
                ramp={['var(--gsi-viz-seq1)', 'var(--gsi-viz-seq2)', 'var(--gsi-viz-seq4)', 'var(--gsi-viz-seq5)']}
              />
            </ChartFrame>

            <ChartFrame
              title={t('invoices.byClient')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('jobs.client')}</th>
                      <th>{t('expenses.amount')}</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byClient.map((c) => (
                      <tr key={c.clientId}>
                        <td>{c.key}</td>
                        <td>{base(c.amountBase)}</td>
                        <td>{c.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.byClient.map((c) => ({ key: c.clientId, label: `${c.key} · ${c.share}%`, value: c.amountBase }))}
                format={base}
              />
            </ChartFrame>

            <ChartFrame
              title={t('invoices.byStatus')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('jobs.status')}</th>
                      <th>{t('expenses.amount')}</th>
                      <th>{t('dashboard.invoices')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byStatus.map((r) => (
                      <tr key={r.status}>
                        <td>{t(`invoiceStatus.${r.status}`)}</td>
                        <td>{base(r.amountBase)}</td>
                        <td>{r.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.byStatus.map((r) => ({
                  key: r.status,
                  label: `${t(`invoiceStatus.${r.status}`)} · ${r.count}`,
                  value: r.amountBase,
                }))}
                format={base}
              />
            </ChartFrame>
          </div>

          {s.topOverdue.length > 0 && (
            <Card title={t('invoices.toChase')} actions={<Badge tone="danger">{base(s.totals.overdueBase)}</Badge>}>
              <Table>
                <thead>
                  <tr>
                    <th>{t('invoices.number')}</th>
                    <th>{t('jobs.client')}</th>
                    <th>{t('invoices.amountDue')}</th>
                    <th>{t('invoices.overdueBy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.topOverdue.map((o) => (
                    <tr key={o.id} className="link-row" onClick={() => navigate(`/finance/invoices/${o.id}`)}>
                      <td className="mono">
                        <Link to={`/finance/invoices/${o.id}`} onClick={(e) => e.stopPropagation()}>
                          {o.invoiceNumber}
                        </Link>
                      </td>
                      <td>{o.clientName}</td>
                      <td>
                        {local(o.amountDue, o.currency)} <span className="muted">· {base(o.amountDueBase)}</span>
                      </td>
                      <td>
                        <Badge tone={o.daysOverdue > 60 ? 'danger' : 'warning'}>
                          {t('invoices.overdueDays', { days: o.daysOverdue })}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}

      {creating && <InvoiceForm onDone={() => setCreating(false)} />}

      <Card
        title={t('invoices.register')}
        actions={
          <>
            <Button size="sm" variant={onlyOverdue ? 'primary' : 'secondary'} onClick={() => setOnlyOverdue((v) => !v)}>
              {t('invoices.onlyOverdue')}
            </Button>
            <Select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')} style={{ width: 200 }}>
              <option value="">
                {t('jobs.status')}: {t('common.all')}
              </option>
              {INVOICE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {t(`invoiceStatus.${st}`)}
                </option>
              ))}
            </Select>
          </>
        }
      >
        <ErrorBox error={invoices.error} />
        {invoices.isLoading ? (
          <Loading />
        ) : !invoices.data?.length ? (
          <EmptyState>{t('invoices.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('invoices.number')}</th>
                {!branchId && <th>{t('common.branch')}</th>}
                <th>{t('jobs.client')}</th>
                <th>{t('invoices.issued')}</th>
                <th>{t('invoices.dueDate')}</th>
                <th>{t('invoices.total')}</th>
                <th>{t('invoices.paid')}</th>
                <th>{t('jobs.status')}</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((inv) => (
                <tr key={inv.id} className="link-row" onClick={() => navigate(`/finance/invoices/${inv.id}`)}>
                  <td className="mono">
                    <Link to={`/finance/invoices/${inv.id}`} onClick={(e) => e.stopPropagation()}>
                      {inv.invoiceNumber}
                    </Link>
                  </td>
                  {!branchId && <td>{inv.branchCode}</td>}
                  <td>{inv.clientName}</td>
                  <td>{fmt(inv.issueDate, false)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {fmt(inv.dueDate, false)}
                    {inv.daysOverdue && inv.daysOverdue > 0 ? (
                      <>
                        {' '}
                        <Badge tone="danger">{t('invoices.overdueDays', { days: inv.daysOverdue })}</Badge>
                      </>
                    ) : null}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(inv.amountTotal, inv.currency)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(inv.amountPaid, inv.currency)}</td>
                  <td>
                    <Badge tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus.${inv.status}`)}</Badge>
                  </td>
                  {canWrite && (
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      {inv.status === 'draft' && (
                        <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: inv.id, action: 'issue' })}>
                          {t('invoices.issue')}
                        </Button>
                      )}
                      {['issued', 'partially_paid'].includes(inv.status) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={act.isPending}
                          onClick={() => {
                            const rest = inv.amountTotal - inv.amountPaid;
                            const raw = window.prompt(t('invoices.payPrompt', { amount: rest }), String(rest));
                            const amount = Number(raw);
                            if (raw && amount > 0) act.mutate({ id: inv.id, action: 'pay', body: { amount } });
                          }}
                        >
                          {t('invoices.pay')}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function InvoiceForm({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [clientId, setClientId] = useState('');
  const [taxRate, setTaxRate] = useState('20');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', quantity: '1', unitPrice: '' }]);

  const clients = useQuery({ queryKey: ['clients', '', null], queryFn: () => api.get<Page<Client>>('/clients?limit=200').then((p) => p.rows) });

  const create = useMutation({
    mutationFn: () =>
      api.post<Invoice>('/finance/invoices', {
        clientId,
        taxRate: Number(taxRate) || 0,
        dueDate: dueDate || null,
        notes: notes || null,
        lines: lines
          .filter((l) => l.description.trim() && Number(l.unitPrice) > 0)
          .map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity) || 1, unitPrice: Number(l.unitPrice) })),
      }),
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice-summary'] });
      onDone();
      navigate(`/finance/invoices/${inv.id}`);
    },
  });

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Card title={t('invoices.new')}>
      <form onSubmit={onSubmit}>
        <ErrorBox error={create.error} />
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label={`${t('jobs.client')} *`}>
            <Select required value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">{t('jobs.selectClient')}</option>
              {clients.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.branchCode ? `(${c.branchCode})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('invoices.taxRate')}>
            <Input type="number" min={0} max={100} step="0.5" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
          </Field>
          <Field label={t('invoices.dueDate')}>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>

        <h4 style={{ margin: '16px 0 8px' }}>{t('invoices.lines')}</h4>
        {lines.map((l, i) => (
          <div key={i} className="invoice-line">
            <Field label={t('invoices.lineDescription')}>
              <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            </Field>
            <Field label={t('invoices.qty')}>
              <Input type="number" min="0" step="0.001" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            </Field>
            <Field label={t('invoices.unitPrice')}>
              <Input type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
            </Field>
            <Button type="button" variant="ghost" size="sm" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls))}>
              ✕
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { description: '', quantity: '1', unitPrice: '' }])}>
          + {t('invoices.addLine')}
        </Button>

        <div className="span-all" style={{ marginTop: 16 }}>
          <Field label={t('clients.notes')}>
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div className="form-actions">
          <span className="muted" style={{ marginInlineEnd: 'auto' }}>
            {t('invoices.net')}: <strong>{total.toFixed(2)}</strong>
          </span>
          <Button type="button" variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!clientId || total <= 0}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

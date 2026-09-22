import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import { Client, INVOICE_STATUSES, Invoice, InvoiceStatus } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
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

export function InvoicesPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [creating, setCreating] = useState(false);

  const canWrite = user?.role === 'finance_controller' || user?.role === 'admin';
  const invoices = useQuery({
    queryKey: ['invoices', status],
    queryFn: () => api.get<Invoice[]>(`/finance/invoices${status ? `?status=${status}` : ''}`),
  });

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post<Invoice>(`/finance/invoices/${id}/${action}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const money = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  return (
    <div className="stack">
      <PageHead
        title={t('invoices.title')}
        actions={canWrite && !creating && <Button onClick={() => setCreating(true)}>+ {t('invoices.new')}</Button>}
      />
      {creating && <InvoiceForm onDone={() => setCreating(false)} />}

      <div className="filters" style={{ marginBottom: 0 }}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | '')}>
          <option value="">{t('jobs.status')}: {t('common.all')}</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`invoiceStatus.${s}`)}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <ErrorBox error={invoices.error ?? act.error} />
        {invoices.isLoading ? (
          <Loading />
        ) : !invoices.data?.length ? (
          <EmptyState>{t('invoices.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('invoices.number')}</th>
                <th>{t('jobs.client')}</th>
                <th>{t('reports.job')}</th>
                <th>{t('invoices.issued')}</th>
                <th>{t('invoices.due')}</th>
                <th>{t('invoices.total')}</th>
                <th>{t('invoices.paid')}</th>
                <th>{t('jobs.status')}</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {invoices.data.map((inv) => (
                <tr key={inv.id}>
                  <td className="mono">{inv.invoiceNumber}</td>
                  <td>
                    <Link to={`/clients/${inv.clientId}`}>{inv.clientName}</Link>
                  </td>
                  <td className="mono">{inv.jobId ? <Link to={`/jobs/${inv.jobId}`}>{inv.jobNumber}</Link> : '—'}</td>
                  <td>{fmt(inv.issueDate, false)}</td>
                  <td>
                    {fmt(inv.dueDate, false)}
                    {inv.daysOverdue && inv.daysOverdue > 0 ? (
                      <> <Badge tone="danger">{t('invoices.overdueDays', { days: inv.daysOverdue })}</Badge></>
                    ) : null}
                  </td>
                  <td>{money(inv.amountTotal, inv.currency)}</td>
                  <td>{money(inv.amountPaid, inv.currency)}</td>
                  <td>
                    <Badge tone={STATUS_TONE[inv.status]}>{t(`invoiceStatus.${inv.status}`)}</Badge>
                  </td>
                  {canWrite && (
                    <td style={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
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
                      {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.isPending}
                          onClick={() => window.confirm(t('invoices.cancelConfirm')) && act.mutate({ id: inv.id, action: 'cancel' })}
                        >
                          {t('common.cancel')}
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
  const [clientId, setClientId] = useState('');
  const [taxRate, setTaxRate] = useState('20');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', quantity: '1', unitPrice: '' }]);

  const clients = useQuery({ queryKey: ['clients', ''], queryFn: () => api.get<Client[]>('/clients') });

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      onDone();
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
          <Field label={t('invoices.due')}>
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls))}
            >
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

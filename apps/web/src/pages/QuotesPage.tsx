import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import { Client, Page, QUOTE_STATUSES, Quote, QuoteStatus, Service } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { useBranch } from '../branch';
import { StatTile } from '../components/charts';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

export const QUOTE_TONE: Record<QuoteStatus, BadgeTone> = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  rejected: 'danger',
  expired: 'warning',
  cancelled: 'danger',
};

interface LineDraft {
  serviceId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

/** Quotes: the commercial offer that precedes an invoice. */
export function QuotesPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { branchId } = useBranch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const [status, setStatus] = useState<QuoteStatus | ''>('');
  const [creating, setCreating] = useState(false);

  const canWrite = can('quote.create');

  const quotes = useQuery({
    queryKey: ['quotes', status, branchId],
    queryFn: () =>
      api.get<Quote[]>(`/finance/quotes?${status ? `status=${status}&` : ''}${branchId ? `branchId=${branchId}` : ''}`),
  });

  const local = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  const totals = useMemo(() => {
    const rows = quotes.data ?? [];
    const open = rows.filter((q) => q.status === 'draft' || q.status === 'sent');
    const accepted = rows.filter((q) => q.status === 'accepted');
    return {
      openCount: open.length,
      acceptedCount: accepted.length,
      total: rows.length,
    };
  }, [quotes.data]);

  return (
    <div className="stack">
      <PageHead
        title={t('quotes.title')}
        actions={canWrite && !creating ? <Button onClick={() => setCreating(true)}>+ {t('quotes.new')}</Button> : null}
      />

      <ErrorBox error={quotes.error} />

      <div className="kpi-row">
        <StatTile label={t('quotes.open')} value={String(totals.openCount)} />
        <StatTile label={t('quoteStatus.accepted')} value={String(totals.acceptedCount)} tone="positive" />
        <StatTile label={t('quotes.total')} value={String(totals.total)} />
      </div>

      {creating && <QuoteForm onDone={() => setCreating(false)} />}

      <Card
        title={t('quotes.register')}
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value as QuoteStatus | '')} style={{ width: 200 }}>
            <option value="">
              {t('jobs.status')}: {t('common.all')}
            </option>
            {QUOTE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {t(`quoteStatus.${st}`)}
              </option>
            ))}
          </Select>
        }
      >
        {quotes.isLoading ? (
          <Loading />
        ) : !quotes.data?.length ? (
          <EmptyState>{t('quotes.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('quotes.number')}</th>
                <th>{t('jobs.client')}</th>
                <th>{t('invoices.issued')}</th>
                <th>{t('quotes.validUntil')}</th>
                <th>{t('invoices.total')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {quotes.data.map((q) => (
                <tr key={q.id} className="link-row" onClick={() => navigate(`/finance/quotes/${q.id}`)}>
                  <td className="mono">
                    <Link to={`/finance/quotes/${q.id}`} onClick={(e) => e.stopPropagation()}>
                      {q.quoteNumber}
                    </Link>
                  </td>
                  <td>{q.clientName}</td>
                  <td>{fmt(q.issueDate, false)}</td>
                  <td>{fmt(q.validUntil, false)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(q.amountTotal, q.currency)}</td>
                  <td>
                    <Badge tone={QUOTE_TONE[q.status]}>{t(`quoteStatus.${q.status}`)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function QuoteForm({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [clientId, setClientId] = useState('');
  const [taxRate, setTaxRate] = useState('20');
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([{ serviceId: '', description: '', quantity: '1', unitPrice: '' }]);

  const clients = useQuery({ queryKey: ['clients', '', null], queryFn: () => api.get<Page<Client>>('/clients?limit=200').then((p) => p.rows) });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.get<Service[]>('/finance/services') });

  const create = useMutation({
    mutationFn: () =>
      api.post<Quote>('/finance/quotes', {
        clientId,
        taxRate: Number(taxRate) || 0,
        validUntil: validUntil || null,
        notes: notes || null,
        lines: lines
          .filter((l) => l.description.trim() && Number(l.unitPrice) > 0)
          .map((l) => ({
            serviceId: l.serviceId || null,
            description: l.description.trim(),
            quantity: Number(l.quantity) || 1,
            unitPrice: Number(l.unitPrice),
          })),
      }),
    onSuccess: (q) => {
      qc.invalidateQueries({ queryKey: ['quotes'] });
      onDone();
      navigate(`/finance/quotes/${q.id}`);
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
    <Card title={t('quotes.new')}>
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
          <Field label={t('quotes.validUntil')}>
            <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>

        <h4 style={{ margin: '16px 0 8px' }}>{t('invoices.lines')}</h4>
        {lines.map((l, i) => (
          <div key={i} className="invoice-line">
            <Field label={t('quotes.service')}>
              <Select value={l.serviceId} onChange={(e) => setLine(i, { serviceId: e.target.value })}>
                <option value="">{t('common.none')}</option>
                {services.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name.en ?? s.code}
                  </option>
                ))}
              </Select>
            </Field>
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
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setLines((ls) => [...ls, { serviceId: '', description: '', quantity: '1', unitPrice: '' }])}
        >
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

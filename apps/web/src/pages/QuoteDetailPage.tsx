import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Table } from '@gsi/ui-kit/react';
import { Invoice, Quote, QuoteAction } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { Breadcrumbs, ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';
import { QUOTE_TONE } from './QuotesPage';

const REASON_ACTIONS: QuoteAction[] = ['reject', 'revise', 'cancel'];

/** One quote: lines, the actions its status allows, and a way to turn it into an invoice. */
export function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();

  const quote = useQuery({ queryKey: ['quote', id], queryFn: () => api.get<Quote>(`/finance/quotes/${id}`) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['quote', id] });
    qc.invalidateQueries({ queryKey: ['quotes'] });
  };

  const act = useMutation({
    mutationFn: ({ action, reason }: { action: QuoteAction; reason?: string | null }) =>
      api.post<Quote>(`/finance/quotes/${id}/${action}`, reason !== undefined ? { reason } : undefined),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/finance/quotes/${id}`),
    onSuccess: () => {
      invalidate();
      navigate('/finance/quotes');
    },
  });
  const toInvoice = useMutation({
    mutationFn: () => api.post<Invoice>(`/finance/quotes/${id}/create-invoice`),
    onSuccess: (inv) => navigate(`/finance/invoices/${inv.id}`),
  });

  function run(action: QuoteAction) {
    if (REASON_ACTIONS.includes(action)) {
      const reason = window.prompt(t(`quoteAction.reasonFor.${action}`));
      if (!reason?.trim()) return;
      act.mutate({ action, reason });
      return;
    }
    if (action === 'send' && !window.confirm(t('quotes.sendConfirm'))) return;
    act.mutate({ action });
  }

  if (quote.isLoading) return <Loading />;
  if (!quote.data) return <ErrorBox error={quote.error} />;
  const q = quote.data;

  const money = (v: number, currency = q.currency) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  return (
    <div className="stack">
      <Breadcrumbs
        items={[
          { label: t('nav.groups.finance') },
          { label: t('nav.quotes'), to: can('quote.read') ? '/finance/quotes' : undefined },
          { label: q.quoteNumber },
        ]}
      />
      <PageHead
        title={
          <span className="row-actions">
            <span className="mono" style={{ fontSize: 'inherit' }}>{q.quoteNumber}</span>
            <Badge tone={QUOTE_TONE[q.status]}>{t(`quoteStatus.${q.status}`)}</Badge>
          </span>
        }
        sub={
          <>
            <Link to={`/clients/${q.clientId}`}>{q.clientName}</Link>
            {q.jobId ? (
              <>
                {' · '}
                <Link to={`/jobs/${q.jobId}`}>{q.jobNumber}</Link>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            {(q.actions ?? []).map((action) => (
              <Button
                key={action}
                variant={action === 'accept' ? 'primary' : action === 'cancel' || action === 'reject' ? 'danger' : 'secondary'}
                loading={act.isPending}
                onClick={() => run(action)}
              >
                {t(`quoteAction.${action}`)}
              </Button>
            ))}
            {can('invoice.create') && q.status === 'accepted' && (
              <Button variant="accent" loading={toInvoice.isPending} onClick={() => toInvoice.mutate()}>
                {t('quotes.createInvoice')}
              </Button>
            )}
            {can('quote.update') && q.status === 'draft' && (
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate()}
              >
                {t('common.delete')}
              </Button>
            )}
          </>
        }
      />
      <ErrorBox error={act.error ?? remove.error ?? toInvoice.error} />

      <div className="two-col">
        <Card title={t('invoices.lines')}>
          <Table>
            <thead>
              <tr>
                <th>{t('invoices.lineDescription')}</th>
                <th>{t('invoices.qty')}</th>
                <th>{t('invoices.unitPrice')}</th>
                <th style={{ textAlign: 'end' }}>{t('expenses.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {q.lines?.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td>{l.quantity}</td>
                  <td>{money(l.unitPrice)}</td>
                  <td style={{ textAlign: 'end' }}>{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <dl className="detail-grid" style={{ marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div>
              <dt>{t('invoices.net')}</dt>
              <dd>{money(q.amountNet)}</dd>
            </div>
            <div>
              <dt>{t('invoices.taxRate')} {q.taxRate}%</dt>
              <dd>{money(q.taxAmount)}</dd>
            </div>
            <div>
              <dt>{t('invoices.total')}</dt>
              <dd><strong>{money(q.amountTotal)}</strong></dd>
            </div>
          </dl>
          {q.notes ? <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{q.notes}</p> : null}
        </Card>

        <div className="stack">
          <Card title={t('invoices.details')}>
            <dl className="detail-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div>
                <dt>{t('invoices.issued')}</dt>
                <dd>{fmt(q.issueDate, false)}</dd>
              </div>
              <div>
                <dt>{t('quotes.validUntil')}</dt>
                <dd>{q.validUntil ? fmt(q.validUntil, false) : '—'}</dd>
              </div>
              <div>
                <dt>{t('quotes.sentAt')}</dt>
                <dd>{q.sentAt ? fmt(q.sentAt) : '—'}</dd>
              </div>
              {q.decidedAt && (
                <div>
                  <dt>{t('quotes.decidedAt')}</dt>
                  <dd>
                    {fmt(q.decidedAt)}
                    {q.decisionNote ? <div className="muted">{q.decisionNote}</div> : null}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('invoices.currency')}</dt>
                <dd>{q.currency}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

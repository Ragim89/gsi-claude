import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Table } from '@gsi/ui-kit/react';
import { Invoice, InvoicePayment, InvoiceReminder } from '@gsi/shared-types';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { Breadcrumbs, ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';
import { INVOICE_TONE } from './InvoicesPage';

/** One invoice: lines, payment history from the ledger, and the actions for its status. */
export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const canWrite = can('invoice.create', 'invoice.issue');

  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);

  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/finance/invoices/${id}`) });
  const payments = useQuery({
    queryKey: ['invoice-payments', id],
    queryFn: () => api.get<InvoicePayment[]>(`/finance/invoices/${id}/payments`),
  });
  const reminders = useQuery({
    queryKey: ['invoice-reminders', id],
    queryFn: () => api.get<InvoiceReminder[]>(`/finance/invoices/${id}/reminders`),
    enabled: can('finance.read'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoice-payments', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['invoice-summary'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api.post<Invoice>(`/finance/invoices/${id}/${action}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/finance/invoices/${id}`),
    onSuccess: () => {
      invalidate();
      navigate('/finance/invoices');
    },
  });
  const remind = useMutation({
    mutationFn: (note: string | null) => api.post(`/finance/invoices/${id}/reminders`, { note }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoice-reminders', id] }),
  });

  async function print() {
    setPrinting(true);
    setPrintError(null);
    try {
      await downloadFile(`/finance/invoices/${id}/pdf`, `${invoice.data?.invoiceNumber ?? 'invoice'}.pdf`);
    } catch (err) {
      setPrintError(err);
    } finally {
      setPrinting(false);
    }
  }

  if (invoice.isLoading) return <Loading />;
  if (!invoice.data) return <ErrorBox error={invoice.error} />;
  const inv = invoice.data;

  const money = (v: number, currency = inv.currency) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  const due = inv.amountTotal - inv.amountPaid;

  return (
    <div className="stack">
      <Breadcrumbs
        items={[
          { label: t('nav.groups.finance') },
          { label: t('nav.invoices'), to: can('finance.read') ? '/finance/invoices' : undefined },
          { label: inv.invoiceNumber },
        ]}
      />
      <PageHead
        title={
          <span className="row-actions">
            <span className="mono" style={{ fontSize: 'inherit' }}>{inv.invoiceNumber}</span>
            <Badge tone={INVOICE_TONE[inv.status]}>{t(`invoiceStatus.${inv.status}`)}</Badge>
            {inv.daysOverdue && inv.daysOverdue > 0 ? (
              <Badge tone="danger">{t('invoices.overdueDays', { days: inv.daysOverdue })}</Badge>
            ) : null}
          </span>
        }
        sub={
          <>
            <Link to={`/clients/${inv.clientId}`}>{inv.clientName}</Link>
            {inv.jobId ? (
              <>
                {' · '}
                <Link to={`/jobs/${inv.jobId}`}>{inv.jobNumber}</Link>
              </>
            ) : null}
            {inv.branchCode ? ` · ${inv.branchCode}` : ''}
          </>
        }
        actions={
          <>
            <Button variant="secondary" loading={printing} onClick={print}>
              ⤓ {t('invoices.downloadPdf')}
            </Button>
            {can('invoice.remind') && ['issued', 'partially_paid'].includes(inv.status) && (
              <Button
                variant="ghost"
                loading={remind.isPending}
                onClick={() => {
                  const note = window.prompt(t('invoices.remindPrompt'));
                  if (note !== null) remind.mutate(note.trim() || null);
                }}
              >
                {t('invoices.logReminder')}
              </Button>
            )}
            {canWrite && (
              <>
                {inv.status === 'draft' && (
                <Button loading={act.isPending} onClick={() => act.mutate({ action: 'issue' })}>
                  {t('invoices.issue')}
                </Button>
              )}
              {['issued', 'partially_paid'].includes(inv.status) && (
                <Button
                  variant="accent"
                  disabled={act.isPending}
                  onClick={() => {
                    const raw = window.prompt(t('invoices.payPrompt', { amount: due }), String(due));
                    const amount = Number(raw);
                    if (raw && amount > 0) act.mutate({ action: 'pay', body: { amount } });
                  }}
                >
                  {t('invoices.pay')}
                </Button>
              )}
              {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                <Button
                  variant="danger"
                  disabled={act.isPending}
                  onClick={() => window.confirm(t('invoices.cancelConfirm')) && act.mutate({ action: 'cancel' })}
                >
                  {t('invoices.cancelInvoice')}
                </Button>
              )}
              {inv.status === 'draft' && (
                <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate()}>
                  {t('common.delete')}
                </Button>
                )}
              </>
            )}
          </>
        }
      />
      <ErrorBox error={act.error ?? remove.error ?? remind.error ?? printError} />

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
              {inv.lines?.map((l) => (
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
              <dd>{money(inv.amountNet)}</dd>
            </div>
            <div>
              <dt>{t('invoices.taxRate')} {inv.taxRate}%</dt>
              <dd>{money(inv.taxAmount)}</dd>
            </div>
            <div>
              <dt>{t('invoices.total')}</dt>
              <dd>
                <strong>{money(inv.amountTotal)}</strong>
              </dd>
            </div>
            <div>
              <dt>{t('invoices.paid')}</dt>
              <dd>{money(inv.amountPaid)}</dd>
            </div>
            <div>
              <dt>{t('invoices.amountDue')}</dt>
              <dd className={due > 0 ? 'negative' : ''}>{money(due)}</dd>
            </div>
          </dl>
          {inv.notes ? <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{inv.notes}</p> : null}
        </Card>

        <div className="stack">
          <Card title={t('invoices.details')}>
            <dl className="detail-grid" style={{ gridTemplateColumns: '1fr' }}>
              <div>
                <dt>{t('invoices.issued')}</dt>
                <dd>{fmt(inv.issueDate, false)}</dd>
              </div>
              <div>
                <dt>{t('invoices.dueDate')}</dt>
                <dd>{fmt(inv.dueDate, false)}</dd>
              </div>
              <div>
                <dt>{t('invoices.paidAt')}</dt>
                <dd>{inv.paidAt ? fmt(inv.paidAt) : '—'}</dd>
              </div>
              <div>
                <dt>{t('invoices.currency')}</dt>
                <dd>{inv.currency}</dd>
              </div>
            </dl>
          </Card>

          <Card title={t('invoices.payments')}>
            <ErrorBox error={payments.error} />
            {payments.isLoading ? (
              <Loading />
            ) : !payments.data?.length ? (
              <EmptyState>{t('invoices.noPayments')}</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>{t('expenses.date')}</th>
                    <th>{t('expenses.amount')}</th>
                    <th>{t('invoices.registeredBy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.data.map((p, i) => (
                    <tr key={`${p.date}-${i}`}>
                      <td>{fmt(p.date, false)}</td>
                      <td>{money(p.amount, p.currency)}</td>
                      <td className="muted">{p.registeredBy ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {can('finance.read') && (
            <Card title={t('invoices.reminders')}>
              {reminders.isLoading ? (
                <Loading />
              ) : !reminders.data?.length ? (
                <EmptyState>{t('invoices.noReminders')}</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('expenses.date')}</th>
                      <th>{t('invoices.registeredBy')}</th>
                      <th>{t('invoices.reminderNote')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reminders.data.map((r) => (
                      <tr key={r.id}>
                        <td>{fmt(r.createdAt)}</td>
                        <td className="muted">{r.sentByName ?? '—'}</td>
                        <td>{r.note ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

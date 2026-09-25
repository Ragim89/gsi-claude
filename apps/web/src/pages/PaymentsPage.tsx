import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Client, PAYMENT_DIRECTIONS, PAYMENT_METHODS, Page, Payment, PaymentDirection } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { useBranch } from '../branch';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

/** Payments as their own record: what came in, what went out, and what is still unapplied. */
export function PaymentsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { branchId } = useBranch();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [direction, setDirection] = useState<PaymentDirection | ''>('');
  const [creating, setCreating] = useState(false);

  const payments = useQuery({
    queryKey: ['payments', direction, branchId],
    queryFn: () =>
      api.get<Payment[]>(`/finance/payments?${direction ? `direction=${direction}&` : ''}${branchId ? `branchId=${branchId}` : ''}`),
  });

  const money = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  const canCreate = can('payment.create', 'expense.pay');

  return (
    <div className="stack">
      <PageHead
        title={t('payments.title')}
        actions={canCreate && !creating ? <Button onClick={() => setCreating(true)}>+ {t('payments.new')}</Button> : null}
      />

      {creating && <PaymentForm onDone={() => setCreating(false)} />}

      <Card
        title={t('payments.register')}
        actions={
          <Select value={direction} onChange={(e) => setDirection(e.target.value as PaymentDirection | '')} style={{ width: 200 }}>
            <option value="">{t('common.all')}</option>
            {PAYMENT_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`paymentDirection.${d}`)}
              </option>
            ))}
          </Select>
        }
      >
        <ErrorBox error={payments.error} />
        {payments.isLoading ? (
          <Loading />
        ) : !payments.data?.length ? (
          <EmptyState>{t('payments.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('expenses.date')}</th>
                <th>{t('payments.direction')}</th>
                <th>{t('payments.party')}</th>
                <th>{t('payments.method')}</th>
                <th className="num">{t('expenses.amount')}</th>
                <th className="num">{t('payments.unallocated')}</th>
              </tr>
            </thead>
            <tbody>
              {payments.data.map((p) => (
                <tr key={p.id}>
                  <td>{fmt(p.paymentDate, false)}</td>
                  <td>
                    <Badge tone={p.direction === 'inbound' ? 'success' : 'neutral'}>{t(`paymentDirection.${p.direction}`)}</Badge>
                  </td>
                  <td>{p.clientName ?? p.supplier ?? '—'}</td>
                  <td>{t(`paymentMethod.${p.method}`)}</td>
                  <td className="num">{money(p.amount, p.currency)}</td>
                  <td className="num">
                    {(p.unallocatedAmount ?? 0) > 0.01 ? (
                      <Badge tone="warning">{money(p.unallocatedAmount ?? 0, p.currency)}</Badge>
                    ) : (
                      '—'
                    )}
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

function PaymentForm({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [direction, setDirection] = useState<PaymentDirection>('inbound');
  const [branchId, setBranchId] = useState(user?.branchId ?? '');
  const [clientId, setClientId] = useState('');
  const [supplier, setSupplier] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [amount, setAmount] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [expenseId, setExpenseId] = useState('');

  const clients = useQuery({ queryKey: ['clients', '', null], queryFn: () => api.get<Page<Client>>('/clients?limit=200').then((p) => p.rows) });

  const create = useMutation({
    mutationFn: () =>
      api.post<Payment>('/finance/payments', {
        branchId,
        direction,
        clientId: direction === 'inbound' ? clientId || null : null,
        supplier: direction === 'outbound' ? supplier.trim() : null,
        method,
        reference: reference.trim() || null,
        currency,
        amount: Number(amount),
        allocations:
          direction === 'inbound'
            ? invoiceId
              ? [{ invoiceId, amount: Number(amount) }]
              : []
            : expenseId
              ? [{ expenseId, amount: Number(amount) }]
              : [],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onDone();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const valid = amount && Number(amount) > 0 && (direction === 'inbound' ? true : supplier.trim() && expenseId);

  return (
    <Card title={t('payments.new')}>
      <form onSubmit={onSubmit}>
        <ErrorBox error={create.error} />
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label={t('payments.direction')}>
            <Select value={direction} onChange={(e) => setDirection(e.target.value as PaymentDirection)}>
              {PAYMENT_DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {t(`paymentDirection.${d}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`${t('common.branch')} *`}>
            <Input required value={branchId} onChange={(e) => setBranchId(e.target.value)} />
          </Field>
          {direction === 'inbound' ? (
            <Field label={t('jobs.client')}>
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">{t('common.none')}</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={`${t('expenses.supplier')} *`}>
              <Input required value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Field>
          )}
          <Field label={t('payments.method')}>
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`paymentMethod.${m}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('payments.reference')}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label={`${t('invoices.currency')} *`}>
            <Input required value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label={`${t('expenses.amount')} *`}>
            <Input type="number" required min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          {direction === 'inbound' ? (
            <Field label={t('payments.invoiceId')}>
              <Input value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} placeholder={t('payments.invoiceIdHint')} />
            </Field>
          ) : (
            <Field label={`${t('payments.expenseId')} *`}>
              <Input required value={expenseId} onChange={(e) => setExpenseId(e.target.value)} placeholder={t('payments.expenseIdHint')} />
            </Field>
          )}
        </div>
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!valid}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

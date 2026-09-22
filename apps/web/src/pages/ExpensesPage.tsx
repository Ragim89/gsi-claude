import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Branch, EXPENSE_CATEGORIES, Expense, ExpenseCategory } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const { user, isHq } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [creating, setCreating] = useState(false);
  const canWrite = user?.role === 'finance_controller' || user?.role === 'admin';

  const { branchId, current } = useBranch();
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (branchId) params.set('branchId', branchId);
  const expenses = useQuery({
    queryKey: ['expenses', category, branchId],
    queryFn: () => api.get<Expense[]>(`/finance/expenses?${params}`),
  });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches'), enabled: isHq });

  const [form, setForm] = useState({
    category: 'travel' as ExpenseCategory,
    description: '',
    amount: '',
    supplier: '',
    expenseDate: new Date().toISOString().slice(0, 10),
    branchId: '',
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Expense>('/finance/expenses', {
        category: form.category,
        description: form.description.trim(),
        amount: Number(form.amount),
        supplier: form.supplier.trim() || null,
        expenseDate: form.expenseDate,
        ...(isHq && form.branchId ? { branchId: form.branchId } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setCreating(false);
      setForm((f) => ({ ...f, description: '', amount: '', supplier: '' }));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/finance/expenses/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const money = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <div className="stack">
      <PageHead
        title={t('expenses.title')}
        sub={branchId && current ? `${flag(current.country)} ${current.code} — ${current.city}` : undefined}
        actions={canWrite && !creating && <Button onClick={() => setCreating(true)}>+ {t('expenses.new')}</Button>}
      />

      {creating && (
        <Card title={t('expenses.new')}>
          <form onSubmit={onSubmit}>
            <ErrorBox error={create.error} />
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label={t('expenses.category')}>
                <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ExpenseCategory }))}>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`expenseCategories.${c}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`${t('expenses.description')} *`}>
                <Input required minLength={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </Field>
              <Field label={`${t('expenses.amount')} *`}>
                <Input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </Field>
              <Field label={t('expenses.supplier')}>
                <Input value={form.supplier} onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} />
              </Field>
              <Field label={t('expenses.date')}>
                <Input type="date" value={form.expenseDate} onChange={(e) => setForm((f) => ({ ...f, expenseDate: e.target.value }))} />
              </Field>
              {isHq && (
                <Field label={t('common.branch')}>
                  <Select value={form.branchId} onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}>
                    <option value="">—</option>
                    {branches.data?.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} — {b.city}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('common.create')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="filters" style={{ marginBottom: 0 }}>
        <Select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory | '')}>
          <option value="">{t('expenses.category')}: {t('common.all')}</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`expenseCategories.${c}`)}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <ErrorBox error={expenses.error ?? remove.error} />
        {expenses.isLoading ? (
          <Loading />
        ) : !expenses.data?.length ? (
          <EmptyState>{t('expenses.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('expenses.date')}</th>
                {isHq && <th>{t('common.branch')}</th>}
                <th>{t('expenses.category')}</th>
                <th>{t('expenses.description')}</th>
                <th>{t('expenses.supplier')}</th>
                <th>{t('expenses.amount')}</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {expenses.data.map((e) => (
                <tr key={e.id}>
                  <td>{fmt(e.expenseDate, false)}</td>
                  {isHq && <td>{e.branchCode}</td>}
                  <td>{t(`expenseCategories.${e.category}`)}</td>
                  <td>{e.description}</td>
                  <td>{e.supplier ?? '—'}</td>
                  <td>{money(e.amount, e.currency)}</td>
                  {canWrite && (
                    <td style={{ textAlign: 'end' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => window.confirm(t('common.confirmDelete')) && remove.mutate(e.id)}
                      >
                        {t('common.delete')}
                      </Button>
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

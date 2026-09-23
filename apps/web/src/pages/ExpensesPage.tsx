import { FormEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Branch, EXPENSE_CATEGORIES, Expense, ExpenseCategory, ExpenseSummary } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { BarList, ChartFrame, Columns, StatTile } from '../components/charts';
import { DEFAULT_RANGE, DateRangeFilter, Range, rangeParams } from '../components/DateRangeFilter';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

/** Branch costs: analytics first (where the money goes), the register below it. */
export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const { user, isHq } = useAuth();
  const { branchId, current } = useBranch();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [creating, setCreating] = useState(false);
  const canWrite = user?.role === 'finance_controller' || user?.role === 'admin';

  // The calendar range and the branch filter scope both the analytics and the register.
  const scope = [rangeParams(range), branchId ? `branchId=${branchId}` : ''].filter(Boolean).join('&');

  const summary = useQuery({
    queryKey: ['expense-summary', scope],
    queryFn: () => api.get<ExpenseSummary>(`/finance/expenses-summary?${scope}`),
  });
  const expenses = useQuery({
    queryKey: ['expenses', category, scope],
    queryFn: () => api.get<Expense[]>(`/finance/expenses?${scope}${category ? `&category=${category}` : ''}`),
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

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['expenses'] });
    qc.invalidateQueries({ queryKey: ['expense-summary'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

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
      invalidate();
      setCreating(false);
      setForm((f) => ({ ...f, description: '', amount: '', supplier: '' }));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/finance/expenses/${id}`),
    onSuccess: invalidate,
  });

  const s = summary.data;
  const base = useMemo(() => {
    const currency = s?.baseCurrency ?? 'EUR';
    return (v: number) =>
      new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  }, [s?.baseCurrency, i18n.language]);
  const local = (v: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const catLabel = (key: string) => t(`expenseCategories.${key}`);

  return (
    <div className="stack">
      <PageHead
        title={t('expenses.title')}
        sub={
          <>
            {branchId && current ? `${flag(current.country)} ${current.code} — ${current.city} · ` : ''}
            {s ? t('dashboard.period', { from: s.period.from, to: s.period.to }) : ''}
            {s ? ` · ${t('dashboard.inCurrency', { currency: s.baseCurrency })}` : ''}
          </>
        }
        actions={
          <>
            <DateRangeFilter value={range} onChange={setRange} />
            {canWrite && !creating && <Button onClick={() => setCreating(true)}>+ {t('expenses.new')}</Button>}
          </>
        }
      />

      <ErrorBox error={summary.error} />

      {summary.isLoading || !s ? (
        <Loading />
      ) : (
        <>
          <div className="kpi-row">
            <StatTile label={t('expenses.total')} value={base(s.totals.amountBase)} hint={t('expenses.records', { count: s.totals.count })} />
            <StatTile label={t('expenses.perMonth')} value={base(s.totals.avgPerMonthBase)} />
            <StatTile
              label={t('expenses.costRatio')}
              value={s.totals.costRatioPct === null ? '—' : `${s.totals.costRatioPct}%`}
              tone={s.totals.costRatioPct !== null && s.totals.costRatioPct > 80 ? 'negative' : undefined}
              hint={t('expenses.ofRevenue', { amount: base(s.totals.revenueBase) })}
            />
            <StatTile
              label={t('expenses.topCategory')}
              value={s.byCategory[0] ? catLabel(s.byCategory[0].key) : '—'}
              hint={s.byCategory[0] ? `${base(s.byCategory[0].amountBase)} · ${s.byCategory[0].share}%` : undefined}
            />
            <StatTile label={t('expenses.avgExpense')} value={base(s.totals.avgPerExpenseBase)} />
          </div>

          <div className="chart-grid">
            <ChartFrame
              title={t('expenses.monthly')}
              subtitle={t('expenses.monthlySub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('dashboard.month')}</th>
                      <th>{t('expenses.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.monthly.map((m) => (
                      <tr key={m.month}>
                        <td>{m.month}</td>
                        <td>{base(m.amountBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <Columns labels={s.monthly.map((m) => m.month)} values={s.monthly.map((m) => m.amountBase)} format={base} />
            </ChartFrame>

            <ChartFrame
              title={t('dashboard.expensesByCategory')}
              subtitle={t('expenses.categorySub')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('expenses.category')}</th>
                      <th>{t('expenses.amount')}</th>
                      <th>%</th>
                      <th>{t('expenses.count')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byCategory.map((c) => (
                      <tr key={c.key}>
                        <td>{catLabel(c.key)}</td>
                        <td>{base(c.amountBase)}</td>
                        <td>{c.share}%</td>
                        <td>{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.byCategory.map((c) => ({ key: c.key, label: `${catLabel(c.key)} · ${c.share}%`, value: c.amountBase }))}
                format={base}
              />
            </ChartFrame>

            {!branchId && s.byBranch.length > 1 && (
              <ChartFrame
                title={t('expenses.byBranch')}
                subtitle={t('expenses.byBranchSub')}
                table={
                  <Table>
                    <thead>
                      <tr>
                        <th>{t('common.branch')}</th>
                        <th>{t('expenses.amount')}</th>
                        <th>%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.byBranch.map((b) => (
                        <tr key={b.branchId}>
                          <td>{b.code}</td>
                          <td>{base(b.amountBase)}</td>
                          <td>{b.share}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                }
              >
                <BarList
                  rows={s.byBranch.map((b) => ({
                    key: b.branchId,
                    label: `${flag(b.country)} ${b.code} · ${b.share}%`,
                    value: b.amountBase,
                  }))}
                  format={base}
                />
              </ChartFrame>
            )}

            <ChartFrame
              title={t('expenses.topSuppliers')}
              table={
                <Table>
                  <thead>
                    <tr>
                      <th>{t('expenses.supplier')}</th>
                      <th>{t('expenses.amount')}</th>
                      <th>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.bySupplier.map((x) => (
                      <tr key={x.key}>
                        <td>{x.key}</td>
                        <td>{base(x.amountBase)}</td>
                        <td>{x.share}%</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              }
            >
              <BarList
                rows={s.bySupplier.map((x) => ({ key: x.key, label: x.key, value: x.amountBase }))}
                format={base}
              />
            </ChartFrame>
          </div>

          {s.largest && (
            <Card title={t('expenses.largest')}>
              <div className="row-actions" style={{ justifyContent: 'space-between' }}>
                <span>
                  <strong>{base(s.largest.amountBase)}</strong> · {s.largest.description}{' '}
                  <Badge tone="neutral">{catLabel(s.largest.category)}</Badge>
                </span>
                <span className="muted">{fmt(s.largest.date, false)}</span>
              </div>
            </Card>
          )}
        </>
      )}

      {creating && (
        <Card title={t('expenses.new')}>
          <form onSubmit={onSubmit}>
            <ErrorBox error={create.error} />
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label={t('expenses.category')}>
                <Select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ExpenseCategory }))}>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {catLabel(c)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`${t('expenses.description')} *`}>
                <Input required minLength={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              </Field>
              <Field label={`${t('expenses.amount')} *`} hint={t('expenses.localHint')}>
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
                        {flag(b.country)} {b.code} — {b.city}
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

      <Card
        title={t('expenses.register')}
        actions={
          <Select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory | '')} style={{ width: 220 }}>
            <option value="">
              {t('expenses.category')}: {t('common.all')}
            </option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {catLabel(c)}
              </option>
            ))}
          </Select>
        }
      >
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
                {isHq && !branchId && <th>{t('common.branch')}</th>}
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
                  {isHq && !branchId && <td>{e.branchCode}</td>}
                  <td>{catLabel(e.category)}</td>
                  <td>{e.description}</td>
                  <td>{e.supplier ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{local(e.amount, e.currency)}</td>
                  {canWrite && (
                    <td style={{ textAlign: 'end' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => window.confirm(t('expenses.deleteConfirm')) && remove.mutate(e.id)}
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

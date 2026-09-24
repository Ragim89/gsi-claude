import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import { Client, Commodity, LabTest, LabUnit, Page, TestSpecification, localize } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

const EMPTY = {
  labTestId: '',
  commodityId: '',
  clientId: '',
  minValue: '',
  maxValue: '',
  targetValue: '',
  unit: '',
  qualitativeRequirement: '',
  notes: '',
  effectiveFrom: '',
};

/**
 * The limits a result is judged against.
 *
 * A limit can be written for a contract, a client, a commodity, or as a plain default, and the
 * most specific one that applies wins — contract, then client, then commodity, then default.
 * The order is enforced in the database when a request is raised; this screen only shows which
 * of them exist, so nobody has to guess why a result was judged the way it was.
 */
export function LabSpecificationsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const manage = can('lab.specification.manage');

  const [labTestId, setLabTestId] = useState('');
  const [commodityId, setCommodityId] = useState('');
  const [clientId, setClientId] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const tests = useQuery({
    queryKey: ['lab-tests'],
    queryFn: () => api.get<LabTest[]>('/lab/tests'),
    staleTime: 300_000,
  });
  const units = useQuery({
    queryKey: ['lab-units'],
    queryFn: () => api.get<LabUnit[]>('/lab/units'),
    staleTime: 600_000,
  });
  const commodities = useQuery({
    queryKey: ['commodities'],
    queryFn: () => api.get<Commodity[]>('/reference/commodities'),
    staleTime: 300_000,
  });
  const clients = useQuery({
    queryKey: ['clients', 'filter'],
    queryFn: () => api.get<Page<Client>>('/clients?limit=200'),
    staleTime: 300_000,
    enabled: can('client.read'),
  });

  const params = new URLSearchParams();
  if (labTestId) params.set('labTestId', labTestId);
  if (commodityId) params.set('commodityId', commodityId);
  if (clientId) params.set('clientId', clientId);
  const key = params.toString();

  const list = useQuery({
    queryKey: ['lab-specifications', key],
    queryFn: () => api.get<TestSpecification[]>(`/lab/specifications?${key}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<TestSpecification>('/lab/specifications', {
        labTestId: form.labTestId,
        ...blanksToNull({
          commodityId: form.commodityId,
          clientId: form.clientId,
          unit: form.unit,
          qualitativeRequirement: form.qualitativeRequirement,
          notes: form.notes,
          effectiveFrom: form.effectiveFrom,
        }),
        minValue: form.minValue === '' ? null : Number(form.minValue),
        maxValue: form.maxValue === '' ? null : Number(form.maxValue),
        targetValue: form.targetValue === '' ? null : Number(form.targetValue),
      }),
    onSuccess: () => {
      setAdding(false);
      setForm(EMPTY);
      qc.invalidateQueries({ queryKey: ['lab-specifications'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (s: TestSpecification) =>
      api.patch<TestSpecification>(`/lab/specifications/${s.id}`, { isActive: !s.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lab-specifications'] }),
  });

  const rows = list.data ?? [];
  const scopeOf = (s: TestSpecification) =>
    s.contractId ? 'contract' : s.clientId ? 'client' : s.commodityId ? 'commodity' : 'default';

  const limits = (s: TestSpecification) => {
    const unit = s.unit ? ` ${s.unit}` : '';
    if (s.minValue != null && s.maxValue != null) return `${s.minValue}–${s.maxValue}${unit}`;
    if (s.maxValue != null) return t('lab.maxOf', { value: `${s.maxValue}${unit}` });
    if (s.minValue != null) return t('lab.minOf', { value: `${s.minValue}${unit}` });
    if (s.qualitativeRequirement) return s.qualitativeRequirement;
    if (s.targetValue != null) return t('lab.targetOf', { value: `${s.targetValue}${unit}` });
    return '—';
  };

  return (
    <div className="stack">
      <PageHead
        title={t('lab.specifications')}
        sub={t('lab.specificationsSub')}
        actions={
          manage ? (
            <Button variant={adding ? 'ghost' : 'secondary'} onClick={() => setAdding((v) => !v)}>
              {adding ? t('common.cancel') : `+ ${t('lab.newSpecification')}`}
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={list.error ?? create.error ?? toggle.error} />

      {adding && (
        <Card title={t('lab.newSpecification')}>
          <div className="form-grid">
            <Field label={t('lab.test')}>
              <Select value={form.labTestId} onChange={(e) => setForm({ ...form, labTestId: e.target.value })}>
                <option value="">{t('lab.chooseTest')}</option>
                {(tests.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {localize(x.name, i18n.language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.commodity')} hint={t('lab.scopeHint')}>
              <Select value={form.commodityId} onChange={(e) => setForm({ ...form, commodityId: e.target.value })}>
                <option value="">{t('lab.anyCommodity')}</option>
                {(commodities.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {localize(c.name, i18n.language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.client')}>
              <Select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
                <option value="">{t('lab.anyClient')}</option>
                {(clients.data?.rows ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('lab.minValue')}>
              <Input
                inputMode="decimal"
                value={form.minValue}
                onChange={(e) => setForm({ ...form, minValue: e.target.value })}
              />
            </Field>
            <Field label={t('lab.maxValue')}>
              <Input
                inputMode="decimal"
                value={form.maxValue}
                onChange={(e) => setForm({ ...form, maxValue: e.target.value })}
              />
            </Field>
            <Field label={t('lab.targetValue')}>
              <Input
                inputMode="decimal"
                value={form.targetValue}
                onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
              />
            </Field>
            <Field label={t('sample.unit')}>
              <Select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                <option value="">{t('lab.noUnit')}</option>
                {(units.data ?? []).map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.code}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('lab.effectiveFrom')}>
              <Input
                type="date"
                value={form.effectiveFrom}
                onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
              />
            </Field>
            <div className="form-grid__wide">
              <Field label={t('lab.qualitativeRequirement')}>
                <Input
                  value={form.qualitativeRequirement}
                  onChange={(e) => setForm({ ...form, qualitativeRequirement: e.target.value })}
                />
              </Field>
            </div>
            <div className="form-grid__wide">
              <Field label={t('checklist.notes')}>
                <TextArea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
          </div>
          <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              loading={create.isPending}
              disabled={
                !form.labTestId ||
                (form.minValue === '' && form.maxValue === '' && form.targetValue === '' &&
                 !form.qualitativeRequirement.trim())
              }
              onClick={() => create.mutate()}
            >
              {t('lab.newSpecification')}
            </Button>
            <span className="muted">{t('lab.specNeedsALimit')}</span>
          </div>
        </Card>
      )}

      <Card>
        <div className="filter-row">
          <Select value={labTestId} onChange={(e) => setLabTestId(e.target.value)}>
            <option value="">{t('lab.test')}: {t('common.all')}</option>
            {(tests.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {localize(x.name, i18n.language)}
              </option>
            ))}
          </Select>
          <Select value={commodityId} onChange={(e) => setCommodityId(e.target.value)}>
            <option value="">{t('jobs.commodity')}: {t('common.all')}</option>
            {(commodities.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {localize(c.name, i18n.language)}
              </option>
            ))}
          </Select>
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">{t('jobs.client')}: {t('common.all')}</option>
            {(clients.data?.rows ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card title={t('lab.specificationsFound', { count: rows.length })}>
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('lab.noSpecifications')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('lab.test')}</th>
                <th>{t('lab.appliesTo')}</th>
                <th>{t('lab.limits')}</th>
                <th>{t('lab.effectiveFrom')}</th>
                <th>{t('lab.scopeLabel')}</th>
                {manage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.isActive ? '' : 'is-muted-row'}>
                  <td>{s.testName ? localize(s.testName, i18n.language) : s.testCode}</td>
                  <td>
                    {s.contractRef ?? s.clientName ??
                      (s.commodityName ? localize(s.commodityName, i18n.language) : t('lab.everything'))}
                  </td>
                  <td className="mono">{limits(s)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.effectiveFrom, false)}</td>
                  <td>
                    <Badge tone={scopeOf(s) === 'default' ? 'neutral' : 'info'}>
                      {t(`lab.scope.${scopeOf(s)}`)}
                    </Badge>
                  </td>
                  {manage ? (
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => toggle.mutate(s)}>
                        {s.isActive ? t('lab.retire') : t('lab.restore')}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="muted">{t('lab.resolutionOrder')}</p>
      </Card>
    </div>
  );
}

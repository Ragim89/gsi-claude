import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Branch, Client, Page, Price, SERVICE_TYPES, Service, ServiceType } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { ErrorBox, Loading, PageHead, useFormatDate, useServiceLabel } from '../components/common';

/** The service catalogue and its price list — what GSI sells, and what it costs where. */
export function ServicesPricingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { branchId } = useBranch();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string>('');
  const [creatingService, setCreatingService] = useState(false);
  const [creatingPrice, setCreatingPrice] = useState(false);

  const canManageServices = can('service.manage');
  const canManagePrices = can('pricing.manage');

  const services = useQuery({ queryKey: ['services', 'all'], queryFn: () => api.get<Service[]>('/finance/services?activeOnly=false') });
  const prices = useQuery({
    queryKey: ['prices', selected],
    queryFn: () => api.get<Price[]>(`/finance/prices${selected ? `?serviceId=${selected}` : ''}`),
    enabled: can('pricing.read'),
  });

  return (
    <div className="stack">
      <PageHead
        title={t('pricing.title')}
        actions={canManageServices && !creatingService ? <Button onClick={() => setCreatingService(true)}>+ {t('pricing.newService')}</Button> : null}
      />

      {creatingService && <ServiceForm onDone={() => setCreatingService(false)} />}

      <Card title={t('pricing.services')}>
        <ErrorBox error={services.error} />
        {services.isLoading ? (
          <Loading />
        ) : !services.data?.length ? (
          <EmptyState>{t('pricing.noServices')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('pricing.code')}</th>
                <th>{t('pricing.name')}</th>
                <th>{t('jobs.type')}</th>
                <th>{t('pricing.unit')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {services.data.map((s) => (
                <tr
                  key={s.id}
                  className="link-row"
                  onClick={() => setSelected(s.id === selected ? '' : s.id)}
                  style={{ background: s.id === selected ? 'var(--gsi-color-background)' : undefined }}
                >
                  <td className="mono">{s.code}</td>
                  <td>{s.name.en ?? s.code}</td>
                  <td>{s.serviceType ? serviceLabel(s.serviceType) : '—'}</td>
                  <td>{s.unit}</td>
                  <td>{s.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge tone="neutral">{t('common.inactive')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card
        title={t('pricing.prices')}
        actions={canManagePrices && selected && !creatingPrice ? <Button size="sm" onClick={() => setCreatingPrice(true)}>+ {t('pricing.newPrice')}</Button> : null}
      >
        {!selected ? (
          <EmptyState>{t('pricing.selectService')}</EmptyState>
        ) : creatingPrice ? (
          <PriceForm serviceId={selected} onDone={() => setCreatingPrice(false)} />
        ) : prices.isLoading ? (
          <Loading />
        ) : !prices.data?.length ? (
          <EmptyState>{t('pricing.noPrices')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('common.branch')}</th>
                <th>{t('jobs.client')}</th>
                <th>{t('pricing.contract')}</th>
                <th>{t('invoices.unitPrice')}</th>
                <th>{t('pricing.effectiveFrom')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {prices.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.branchId}</td>
                  <td>{p.clientName ?? t('pricing.default')}</td>
                  <td>{p.contractNo ?? '—'}</td>
                  <td>
                    {p.unitPrice.toLocaleString()} {p.currency}
                  </td>
                  <td>{fmt(p.effectiveFrom, false)}</td>
                  <td>{p.isActive ? <Badge tone="success">{t('common.active')}</Badge> : <Badge tone="neutral">{t('common.inactive')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function ServiceForm({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const serviceLabel = useServiceLabel();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [serviceType, setServiceType] = useState<ServiceType | ''>('');
  const [unit, setUnit] = useState('unit');
  // The service's branch-default price — mandatory, versioned/effective-dated, saved through
  // the same pricing engine as any other price (ServicesPricingService.createService).
  const [currency, setCurrency] = useState('');
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [unitPrice, setUnitPrice] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  useEffect(() => {
    if (currencyTouched) return;
    const branch = branches.data?.find((b) => b.id === user?.branchId);
    if (branch) setCurrency(branch.currency);
  }, [branches.data, user?.branchId, currencyTouched]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Service & { defaultPriceId: string }>('/finance/services', {
        code: code.trim(),
        name: { en: name.trim(), ru: name.trim(), tr: name.trim() },
        serviceType: serviceType || null,
        unit,
        currency,
        unitPrice: Number(unitPrice),
        effectiveFrom,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['services'] });
      qc.invalidateQueries({ queryKey: ['prices'] });
      onDone();
    },
  });

  const priceValid = Number(unitPrice) > 0 && currency.trim().length === 3 && Boolean(effectiveFrom);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Card title={t('pricing.newService')}>
      <form onSubmit={onSubmit}>
        <ErrorBox error={create.error} />
        <div className="form-grid" style={{ marginTop: 8 }}>
          <Field label={`${t('pricing.code')} *`}>
            <Input required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label={`${t('pricing.name')} *`}>
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('jobs.type')}>
            <Select value={serviceType} onChange={(e) => setServiceType(e.target.value as ServiceType | '')}>
              <option value="">{t('common.none')}</option>
              {SERVICE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {serviceLabel(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('pricing.unit')}>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
          </Field>
          <Field label={`${t('invoices.unitPrice')} *`} hint={t('pricing.priceHint')}>
            <Input type="number" required min="0.01" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
          </Field>
          <Field label={`${t('invoices.currency')} *`} hint={t('pricing.currencyHint')}>
            <Input
              required
              value={currency}
              onChange={(e) => {
                setCurrencyTouched(true);
                setCurrency(e.target.value.toUpperCase());
              }}
              maxLength={3}
            />
          </Field>
          <Field label={`${t('common.effectiveFrom')} *`}>
            <Input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </Field>
        </div>
        <div className="form-actions">
          <Button type="button" variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!code.trim() || !name.trim() || !priceValid}>
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PriceForm({ serviceId, onDone }: { serviceId: string; onDone(): void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [branchId, setBranchId] = useState(user?.branchId ?? '');
  const [clientId, setClientId] = useState('');
  // Domestic default: the selected branch's own currency (KZ→KZT, RU→RUB, TR→TRY, …), never a
  // hardcoded one — a foreign currency stays possible, but only as an explicit override below.
  const [currency, setCurrency] = useState('');
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [unitPrice, setUnitPrice] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  const clients = useQuery({ queryKey: ['clients', '', null], queryFn: () => api.get<Page<Client>>('/clients?limit=200').then((p) => p.rows) });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  useEffect(() => {
    if (currencyTouched) return;
    const branch = branches.data?.find((b) => b.id === branchId);
    if (branch) setCurrency(branch.currency);
  }, [branchId, branches.data, currencyTouched]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Price>('/finance/prices', {
        serviceId,
        branchId,
        clientId: clientId || null,
        currency,
        unitPrice: Number(unitPrice),
        effectiveFrom,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prices', serviceId] });
      onDone();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={onSubmit}>
      <ErrorBox error={create.error} />
      <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label={`${t('common.branch')} *`}>
          <Select required value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t('common.branch')}</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {flag(b.country)} {b.code} — {b.city} ({b.currency})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('jobs.client')}>
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">{t('pricing.default')}</option>
            {clients.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('invoices.currency')} *`} hint={t('pricing.currencyHint')}>
          <Input
            required
            value={currency}
            onChange={(e) => {
              setCurrencyTouched(true);
              setCurrency(e.target.value.toUpperCase());
            }}
            maxLength={3}
          />
        </Field>
        <Field label={`${t('invoices.unitPrice')} *`}>
          <Input type="number" required min="0" step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
        </Field>
        <Field label={`${t('common.effectiveFrom')} *`}>
          <Input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={create.isPending} disabled={!branchId || !currency || !(Number(unitPrice) > 0)}>
          {t('common.create')}
        </Button>
      </div>
    </form>
  );
}

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import {
  Client,
  ClientContact,
  Commodity,
  Contract,
  InspectionJob,
  JOB_OBJECT_KINDS,
  JOB_PRIORITIES,
  JobObjectKind,
  JobPriority,
  Page,
  Port,
  Price,
  SERVICE_TYPES,
  Service,
  ServiceType,
  User,
  localize,
} from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, fromLocalInput, Loading, PageHead, toLocalInput, useServiceLabel } from '../components/common';

interface JobLineDraft {
  id: string;
  serviceId: string;
  description: string;
  quantity: string;
  /** A manual price override — gated by `pricing.override` (migration 033). */
  overrideEnabled: boolean;
  overrideUnitPrice: string;
  overrideCurrency: string;
}

function newLineDraft(): JobLineDraft {
  return {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `line-${Date.now()}-${Math.random()}`,
    serviceId: '',
    description: '',
    quantity: '1',
    overrideEnabled: false,
    overrideUnitPrice: '',
    overrideCurrency: '',
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatMoney(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

interface FormState {
  clientId: string;
  clientContactId: string;
  contractId: string;
  clientReference: string;
  type: ServiceType | '';
  commodityId: string;
  commodity: string;
  quantityValue: string;
  quantityUnit: string;
  quantity: string;
  location: string;
  city: string;
  portId: string;
  objectKind: JobObjectKind | '';
  vesselOrObject: string;
  containerNo: string;
  transportRef: string;
  contractNo: string;
  requestedDate: string;
  scheduledAt: string; // datetime-local
  priority: JobPriority;
  assignedInspectorId: string;
  instructions: string;
  internalNotes: string;
}

const EMPTY: FormState = {
  clientId: '',
  clientContactId: '',
  contractId: '',
  clientReference: '',
  type: '',
  commodityId: '',
  commodity: '',
  quantityValue: '',
  quantityUnit: 'MT',
  quantity: '',
  location: '',
  city: '',
  portId: '',
  objectKind: '',
  vesselOrObject: '',
  containerNo: '',
  transportRef: '',
  contractNo: '',
  requestedDate: new Date().toISOString().slice(0, 10),
  scheduledAt: '',
  priority: 'normal',
  assignedInspectorId: '',
  instructions: '',
  internalNotes: '',
};

/**
 * Create (/jobs/new) and edit (/jobs/:id/edit) a job.
 *
 * Grouped the way the call goes: who it is for, what we are doing, where, when, who does it.
 * A new job can be saved as a draft with almost nothing filled in — operations often opens
 * one while still on the phone — and confirming it later is what checks it is complete.
 */
export function JobFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [search] = useSearchParams();
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const serviceLabel = useServiceLabel();
  const [form, setForm] = useState<FormState>({ ...EMPTY, clientId: search.get('clientId') ?? '' });
  /** The version the form was loaded with, so a concurrent save is caught, not overwritten. */
  const [version, setVersion] = useState<number | undefined>();
  /** Multi-service line items (migration 029) — only offered when creating a job; each
   *  price is resolved and snapshotted server-side, never trusted from here, unless the
   *  caller overrides it (below) and holds `pricing.override`. */
  const [lines, setLines] = useState<JobLineDraft[]>([]);
  /** The live-resolved price for each line, keyed by its draft id — fed by JobLineRow so the
   *  total-cost summary can be computed up here without re-querying. */
  const [resolvedPrices, setResolvedPrices] = useState<Record<string, Price | null>>({});
  /** "Рассчитать итоговую стоимость" reveals the summary; once shown it stays live. */
  const [showSummary, setShowSummary] = useState(false);

  const existing = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<InspectionJob>(`/jobs/${id}`),
    enabled: isEdit,
  });
  const clients = useQuery({
    queryKey: ['clients', 'picker'],
    queryFn: () => api.get<Page<Client>>('/clients?limit=200').then((p) => p.rows),
  });
  const contacts = useQuery({
    queryKey: ['contacts', form.clientId],
    queryFn: () => api.get<ClientContact[]>(`/clients/${form.clientId}/contacts`),
    enabled: Boolean(form.clientId),
  });
  const contracts = useQuery({
    queryKey: ['contracts', form.clientId],
    queryFn: () => api.get<Page<Contract>>(`/contracts?clientId=${form.clientId}&limit=100`).then((p) => p.rows),
    enabled: Boolean(form.clientId) && can('contract.read'),
  });
  const inspectors = useQuery({
    queryKey: ['users', 'inspector'],
    queryFn: () => api.get<User[]>('/users?role=inspector'),
    enabled: !isEdit && can('job.assign'),
  });
  const commodities = useQuery({ queryKey: ['commodities'], queryFn: () => api.get<Commodity[]>('/reference/commodities'), staleTime: 300_000 });
  const ports = useQuery({ queryKey: ['ports'], queryFn: () => api.get<Port[]>('/reference/ports'), staleTime: 300_000 });
  const canPriceLines = !isEdit && can('pricing.read');
  const canOverridePrice = canPriceLines && can('pricing.override');
  const services = useQuery({
    queryKey: ['services', 'active'],
    queryFn: () => api.get<Service[]>('/finance/services'),
    enabled: canPriceLines,
    staleTime: 300_000,
  });

  useEffect(() => {
    const j = existing.data;
    if (!j) return;
    setVersion(j.version);
    setForm({
      clientId: j.clientId,
      clientContactId: j.clientContactId ?? '',
      contractId: j.contractId ?? '',
      clientReference: j.clientReference ?? '',
      type: j.type,
      commodityId: j.commodityId ?? '',
      commodity: j.commodity ?? '',
      quantityValue: j.quantityValue != null ? String(j.quantityValue) : '',
      quantityUnit: j.quantityUnit || 'MT',
      quantity: j.quantity ?? '',
      location: j.location ?? '',
      city: j.city ?? '',
      portId: j.portId ?? '',
      objectKind: j.objectKind ?? '',
      vesselOrObject: j.vesselOrObject ?? '',
      containerNo: j.containerNo ?? '',
      transportRef: j.transportRef ?? '',
      contractNo: j.contractNo ?? '',
      requestedDate: j.requestedDate ?? '',
      scheduledAt: toLocalInput(j.scheduledAt),
      priority: j.priority,
      assignedInspectorId: j.assignedInspectorId ?? '',
      instructions: j.instructions ?? '',
      internalNotes: j.internalNotes ?? '',
    });
  }, [existing.data]);

  // A contract carries the terms; picking one offers its client's contact by default.
  useEffect(() => {
    if (isEdit || form.clientContactId) return;
    const primary = contacts.data?.find((c) => c.isPrimary);
    if (primary) setForm((f) => (f.clientContactId ? f : { ...f, clientContactId: primary.id }));
  }, [contacts.data, isEdit, form.clientContactId]);

  const save = useMutation({
    mutationFn: async (status?: 'draft' | 'confirmed') => {
      const common = {
        ...blanksToNull({
          location: form.location,
          city: form.city,
          vesselOrObject: form.vesselOrObject,
          objectKind: form.objectKind,
          containerNo: form.containerNo,
          transportRef: form.transportRef,
          commodity: form.commodity,
          quantity: form.quantity,
          instructions: form.instructions,
          internalNotes: form.internalNotes,
          contractNo: form.contractNo,
          contractId: form.contractId,
          clientContactId: form.clientContactId,
          clientReference: form.clientReference,
          commodityId: form.commodityId,
          portId: form.portId,
          requestedDate: form.requestedDate,
        }),
        priority: form.priority,
        quantityValue: form.quantityValue ? Number(form.quantityValue) : null,
        quantityUnit: form.quantityUnit || 'MT',
      };
      const scheduledAt = fromLocalInput(form.scheduledAt);
      if (isEdit) return api.patch<InspectionJob>(`/jobs/${id}`, { ...common, scheduledAt, version });
      const validLines = lines.filter((l) => l.serviceId && Number(l.quantity) > 0);
      return api.post<InspectionJob>('/jobs', {
        ...common,
        scheduledAt,
        status,
        clientId: form.clientId,
        type: form.type,
        assignedInspectorId: form.assignedInspectorId || null,
        ...(validLines.length
          ? {
              lines: validLines.map((l) => ({
                serviceId: l.serviceId,
                description: l.description.trim() || undefined,
                quantity: Number(l.quantity),
                ...(l.overrideEnabled && Number(l.overrideUnitPrice) > 0 && l.overrideCurrency.trim().length === 3
                  ? { unitPrice: Number(l.overrideUnitPrice), currency: l.overrideCurrency.trim().toUpperCase() }
                  : {}),
              })),
            }
          : {}),
      });
    },
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['job', job.id] });
      navigate(`/jobs/${job.id}`);
    },
  });

  if (isEdit && existing.isLoading) return <Loading />;

  const selectedClient = clients.data?.find((c) => c.id === form.clientId);
  const branchInspectors = (inspectors.data ?? []).filter(
    (u) => u.isActive && (!selectedClient || u.branchId === selectedClient.branchId),
  );
  const chosenContract = contracts.data?.find((c) => c.id === form.contractId);
  const contractExpired = chosenContract?.daysToExpiry != null && chosenContract.daysToExpiry < 0;

  /** Recomputed on every render (service/qty/price change all flow through this), so
   *  "Рассчитать итоговую стоимость" only decides when the panel is first shown, not what it
   *  says — see showSummary below. Currencies are never mixed: unpriced lines and lines of a
   *  currency other than the majority are called out instead of summed. */
  const summary = useMemo(() => {
    const rows = lines
      .filter((l) => l.serviceId && Number(l.quantity) > 0)
      .map((l) => {
        const service = services.data?.find((s) => s.id === l.serviceId);
        const resolved = resolvedPrices[l.id];
        const unitPrice = l.overrideEnabled ? Number(l.overrideUnitPrice) : resolved?.unitPrice;
        const currency = l.overrideEnabled ? l.overrideCurrency.trim().toUpperCase() : resolved?.currency;
        const qty = Number(l.quantity);
        const priced = unitPrice != null && !Number.isNaN(unitPrice) && unitPrice > 0 && currency?.length === 3;
        return {
          id: l.id,
          label: service ? localize(service.name, i18n.language) : l.serviceId,
          unit: service?.unit ?? '',
          qty,
          unitPrice: priced ? unitPrice! : null,
          currency: priced ? currency! : null,
          total: priced ? round2(qty * unitPrice!) : null,
        };
      });
    const byCurrency = new Map<string, number>();
    for (const r of rows) {
      if (r.total == null || !r.currency) continue;
      byCurrency.set(r.currency, round2((byCurrency.get(r.currency) ?? 0) + r.total));
    }
    const currencies = [...byCurrency.entries()];
    return {
      rows,
      currencies,
      hasUnpriced: rows.some((r) => r.total == null),
      finalTotal: currencies.length === 1 ? currencies[0] : null,
    };
  }, [lines, resolvedPrices, services.data, i18n.language]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  function submit(e: FormEvent, status?: 'draft' | 'confirmed') {
    e.preventDefault();
    save.mutate(status);
  }

  const ready = Boolean(form.clientId && form.type);

  return (
    <div className="stack">
      <PageHead
        title={isEdit ? t('jobs.editTitle', { number: existing.data?.jobNumber ?? '' }) : t('jobs.new')}
        sub={isEdit ? undefined : t('job.newHint')}
      />

      <form onSubmit={(e) => submit(e, 'confirmed')} className="stack">
        <Card title={t('job.sectionClient')}>
          <div className="form-grid">
            <Field label={t('jobs.client')}>
              <Select
                required
                disabled={isEdit}
                value={form.clientId}
                onChange={(e) => set({ clientId: e.target.value, clientContactId: '', contractId: '' })}
              >
                <option value="">{t('jobs.selectClient')}</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.branchCode ? ` — ${c.branchCode}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('job.contact')}>
              <Select
                value={form.clientContactId}
                disabled={!form.clientId}
                onChange={(e) => set({ clientContactId: e.target.value })}
              >
                <option value="">{t('common.none')}</option>
                {contacts.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                    {c.position ? ` — ${c.position}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {can('contract.read') && (
              <Field
                label={t('job.contract')}
                hint={
                  contractExpired
                    ? t('job.contractExpired')
                    : chosenContract?.paymentTermsDays != null
                      ? t('job.contractTerms', { days: chosenContract.paymentTermsDays })
                      : undefined
                }
              >
                <Select
                  value={form.contractId}
                  disabled={!form.clientId}
                  onChange={(e) => set({ contractId: e.target.value })}
                >
                  <option value="">{t('common.none')}</option>
                  {contracts.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.contractNo}
                      {c.title ? ` — ${c.title}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label={t('jobs.clientReference')} hint={t('job.clientReferenceHint')}>
              <Input value={form.clientReference} onChange={(e) => set({ clientReference: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title={t('job.sectionService')}>
          <div className="form-grid">
            <Field label={t('jobs.type')}>
              <Select required disabled={isEdit} value={form.type} onChange={(e) => set({ type: e.target.value as ServiceType })}>
                <option value="">{t('jobs.selectType')}</option>
                {SERVICE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {serviceLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.commodity')} hint={t('jobs.commodityHint')}>
              <Select value={form.commodityId} onChange={(e) => set({ commodityId: e.target.value })}>
                <option value="">{t('jobs.selectCommodity')}</option>
                {commodities.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {localize(c.name, i18n.language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.volume')}>
              <div className="row-actions">
                <Input
                  inputMode="decimal"
                  value={form.quantityValue}
                  onChange={(e) => set({ quantityValue: e.target.value })}
                />
                <Input
                  style={{ maxWidth: 90 }}
                  value={form.quantityUnit}
                  onChange={(e) => set({ quantityUnit: e.target.value.toUpperCase() })}
                />
              </div>
            </Field>
            <Field label={t('jobs.quantityNote')} hint={t('jobs.quantityNoteHint')}>
              <Input value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} />
            </Field>
          </div>
        </Card>

        {canPriceLines && (
          <Card
            title={t('job.sectionServices')}
            actions={
              <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLineDraft()])}>
                + {t('job.addServiceLine')}
              </Button>
            }
          >
            {lines.length === 0 ? (
              <p className="muted">{t('job.servicesHint')}</p>
            ) : (
              <div className="stack">
                {lines.map((l) => (
                  <JobLineRow
                    key={l.id}
                    line={l}
                    services={services.data ?? []}
                    branchId={selectedClient?.branchId}
                    clientId={form.clientId}
                    contractId={form.contractId}
                    canOverride={canOverridePrice}
                    onChange={(patch) => setLines((ls) => ls.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))}
                    onRemove={() => {
                      setLines((ls) => ls.filter((x) => x.id !== l.id));
                      setResolvedPrices((rp) => {
                        const { [l.id]: _removed, ...rest } = rp;
                        return rest;
                      });
                    }}
                    onResolved={(price) => setResolvedPrices((rp) => (rp[l.id] === price ? rp : { ...rp, [l.id]: price }))}
                  />
                ))}
              </div>
            )}

            {lines.length > 0 && (
              <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-4)' }}>
                <Button type="button" className="calc-total-btn" onClick={() => setShowSummary(true)}>
                  {t('job.calculateTotal')}
                </Button>
              </div>
            )}

            {showSummary && summary.rows.length > 0 && (
              <div className="job-summary">
                <Table>
                  <thead>
                    <tr>
                      <th>{t('invoices.lineDescription')}</th>
                      <th>{t('pricing.unit')}</th>
                      <th>{t('invoices.qty')}</th>
                      <th>{t('invoices.unitPrice')}</th>
                      <th>{t('job.lineTotal')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.label}</td>
                        <td>{r.unit}</td>
                        <td>{r.qty}</td>
                        <td>{r.unitPrice != null && r.currency ? formatMoney(r.unitPrice, r.currency, i18n.language) : t('job.noPriceConfigured')}</td>
                        <td>{r.total != null && r.currency ? formatMoney(r.total, r.currency, i18n.language) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>

                {summary.hasUnpriced && <p className="muted">{t('job.summaryUnpriced')}</p>}

                <div className="job-summary__totals">
                  {summary.currencies.map(([currency, amount]) => (
                    <div key={currency} className="job-summary__total-row">
                      <span>{t('job.subtotal')} ({currency})</span>
                      <strong>{formatMoney(amount, currency, i18n.language)}</strong>
                    </div>
                  ))}
                  {summary.currencies.length > 1 && <p className="muted">{t('job.mixedCurrencyNotice')}</p>}
                  {summary.finalTotal && (
                    <div className="job-summary__total-row job-summary__total-row--final">
                      <span>{t('job.finalTotal')}</span>
                      <strong>{formatMoney(summary.finalTotal[1], summary.finalTotal[0], i18n.language)}</strong>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}

        <Card title={t('job.sectionLocation')}>
          <div className="form-grid">
            <Field label={t('jobs.port')}>
              <Select value={form.portId} onChange={(e) => set({ portId: e.target.value })}>
                <option value="">{t('jobs.selectPort')}</option>
                {ports.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.country}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.location')}>
              <Input value={form.location} onChange={(e) => set({ location: e.target.value })} />
            </Field>
            <Field label={t('job.city')}>
              <Input value={form.city} onChange={(e) => set({ city: e.target.value })} />
            </Field>
            <Field label={t('job.objectKind')}>
              <Select value={form.objectKind} onChange={(e) => set({ objectKind: e.target.value as JobObjectKind })}>
                <option value="">{t('common.none')}</option>
                {JOB_OBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`objectKind.${k}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.vessel')}>
              <Input value={form.vesselOrObject} onChange={(e) => set({ vesselOrObject: e.target.value })} />
            </Field>
            {(form.objectKind === 'container' || form.containerNo) && (
              <Field label={t('job.containerNo')}>
                <Input value={form.containerNo} onChange={(e) => set({ containerNo: e.target.value })} />
              </Field>
            )}
            <Field label={t('job.transportRef')} hint={t('job.transportRefHint')}>
              <Input value={form.transportRef} onChange={(e) => set({ transportRef: e.target.value })} />
            </Field>
            <Field label={t('jobs.contractNo')}>
              <Input value={form.contractNo} onChange={(e) => set({ contractNo: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card title={t('job.sectionSchedule')}>
          <div className="form-grid">
            <Field label={t('job.requestedDate')} hint={t('job.requestedDateHint')}>
              <Input type="date" value={form.requestedDate} onChange={(e) => set({ requestedDate: e.target.value })} />
            </Field>
            <Field label={t('jobs.scheduled')}>
              <Input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) => set({ scheduledAt: e.target.value })}
              />
            </Field>
            <Field label={t('jobs.priority')}>
              <Select value={form.priority} onChange={(e) => set({ priority: e.target.value as JobPriority })}>
                {JOB_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`priority.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {!isEdit && can('job.assign') && (
              <Field label={t('jobs.lead')}>
                <Select value={form.assignedInspectorId} onChange={(e) => set({ assignedInspectorId: e.target.value })}>
                  <option value="">{t('jobs.selectInspector')}</option>
                  {branchInspectors.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </Card>

        <Card title={t('job.sectionInstructions')}>
          <div className="stack">
            <Field label={t('jobs.instructions')} hint={t('job.instructionsHint')}>
              <TextArea rows={4} value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} />
            </Field>
            <Field label={t('job.internalNotes')} hint={t('job.internalNotesHint')}>
              <TextArea rows={3} value={form.internalNotes} onChange={(e) => set({ internalNotes: e.target.value })} />
            </Field>
          </div>
        </Card>

        <ErrorBox error={save.error} />

        <div className="row-actions">
          <Button type="submit" loading={save.isPending} disabled={!ready}>
            {isEdit ? t('common.save') : t('job.createConfirmed')}
          </Button>
          {!isEdit && (
            <Button
              type="button"
              variant="secondary"
              loading={save.isPending}
              disabled={!ready}
              onClick={(e) => submit(e, 'draft')}
            >
              {t('job.saveDraft')}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => navigate(isEdit ? `/jobs/${id}` : '/jobs')}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * One priced service line: service, unit, quantity, unit price + currency, line total. The
 * price is resolved live (contract → client → branch default) — informational only, the
 * server re-resolves it at save time — unless `canOverride` is set and the row's own override
 * toggle is on, in which case these values are sent and used as-is (subject to the server-side
 * `pricing.override` permission check).
 */
function JobLineRow({
  line,
  services,
  branchId,
  clientId,
  contractId,
  canOverride,
  onChange,
  onRemove,
  onResolved,
}: {
  line: JobLineDraft;
  services: Service[];
  branchId?: string;
  clientId?: string;
  contractId?: string;
  canOverride: boolean;
  onChange(patch: Partial<JobLineDraft>): void;
  onRemove(): void;
  onResolved(price: Price | null): void;
}) {
  const { t, i18n } = useTranslation();
  const enabled = Boolean(line.serviceId && branchId && clientId);
  const price = useQuery({
    queryKey: ['price-resolve', line.serviceId, branchId, clientId, contractId],
    queryFn: () =>
      api.get<Price | null>(
        `/finance/prices/resolve?serviceId=${line.serviceId}&branchId=${branchId}&clientId=${clientId}${contractId ? `&contractId=${contractId}` : ''}`,
      ),
    enabled,
  });

  useEffect(() => {
    onResolved(enabled ? (price.data ?? null) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, price.data]);

  const service = services.find((s) => s.id === line.serviceId);
  const qty = Number(line.quantity);
  const effectiveUnitPrice = line.overrideEnabled ? Number(line.overrideUnitPrice) : price.data?.unitPrice;
  const effectiveCurrency = line.overrideEnabled ? line.overrideCurrency.trim().toUpperCase() : price.data?.currency;
  const lineTotal =
    effectiveUnitPrice != null && !Number.isNaN(effectiveUnitPrice) && effectiveUnitPrice > 0 && qty > 0
      ? round2(qty * effectiveUnitPrice)
      : null;

  return (
    <div className="job-line-row">
      <div className="job-line">
        <Field label={t('invoices.lineDescription')}>
          <Select value={line.serviceId} onChange={(e) => onChange({ serviceId: e.target.value })}>
            <option value="">{t('job.selectService')}</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {localize(s.name, i18n.language)} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('pricing.unit')}>
          <div className="muted" style={{ alignSelf: 'end', paddingBottom: 8 }}>{service?.unit ?? '—'}</div>
        </Field>
        <Field label={t('invoices.qty')}>
          <Input type="number" min="0" step="0.001" value={line.quantity} onChange={(e) => onChange({ quantity: e.target.value })} />
        </Field>
        <Field label={t('invoices.unitPrice')}>
          {line.overrideEnabled ? (
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={line.overrideUnitPrice}
              onChange={(e) => onChange({ overrideUnitPrice: e.target.value })}
            />
          ) : !enabled ? (
            <div className="muted" style={{ alignSelf: 'end', paddingBottom: 8 }}>—</div>
          ) : price.isLoading ? (
            <div className="muted" style={{ alignSelf: 'end', paddingBottom: 8 }}>…</div>
          ) : !price.data ? (
            <div className="muted" style={{ alignSelf: 'end', paddingBottom: 8, color: 'var(--gsi-color-danger)' }}>
              {t('job.noPriceConfigured')}
            </div>
          ) : (
            <div style={{ alignSelf: 'end', paddingBottom: 8 }}>{formatMoney(price.data.unitPrice, price.data.currency, i18n.language)}</div>
          )}
        </Field>
        <Field label={t('job.lineTotal')}>
          <div style={{ alignSelf: 'end', paddingBottom: 8, fontWeight: 'var(--gsi-font-weight-medium)' }}>
            {lineTotal != null && effectiveCurrency ? formatMoney(lineTotal, effectiveCurrency, i18n.language) : '—'}
          </div>
        </Field>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          ✕
        </Button>
      </div>
      {canOverride && (
        <label className="job-line-override">
          <input
            type="checkbox"
            checked={line.overrideEnabled}
            onChange={(e) =>
              onChange({
                overrideEnabled: e.target.checked,
                overrideUnitPrice: e.target.checked ? String(price.data?.unitPrice ?? '') : '',
                overrideCurrency: e.target.checked ? (price.data?.currency ?? '') : '',
              })
            }
          />
          {t('job.overridePrice')}
          {line.overrideEnabled && (
            <Input
              className="job-line-override__currency"
              value={line.overrideCurrency}
              onChange={(e) => onChange({ overrideCurrency: e.target.value.toUpperCase() })}
              maxLength={3}
              placeholder={t('invoices.currency')}
            />
          )}
        </label>
      )}
    </div>
  );
}

import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, Field, Input, Select, TextArea } from '@gsi/ui-kit/react';
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
  SERVICE_TYPES,
  ServiceType,
  User,
  localize,
} from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, fromLocalInput, Loading, PageHead, toLocalInput, useServiceLabel } from '../components/common';

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
      return api.post<InspectionJob>('/jobs', {
        ...common,
        scheduledAt,
        status,
        clientId: form.clientId,
        type: form.type,
        assignedInspectorId: form.assignedInspectorId || null,
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

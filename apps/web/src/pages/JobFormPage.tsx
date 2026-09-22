import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, Field, Input, Select, TextArea } from '@gsi/ui-kit/react';
import { Client, InspectionJob, SERVICE_TYPES, ServiceType, User } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { ErrorBox, fromLocalInput, Loading, PageHead, toLocalInput, useServiceLabel } from '../components/common';

interface FormState {
  clientId: string;
  type: ServiceType | '';
  location: string;
  vesselOrObject: string;
  commodity: string;
  quantity: string;
  scheduledAt: string; // datetime-local
  instructions: string;
  assignedInspectorId: string;
}

const EMPTY: FormState = {
  clientId: '',
  type: '',
  location: '',
  vesselOrObject: '',
  commodity: '',
  quantity: '',
  scheduledAt: '',
  instructions: '',
  assignedInspectorId: '',
};

/** Create (/jobs/new) and edit (/jobs/:id/edit) an inspection job. */
export function JobFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [search] = useSearchParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const serviceLabel = useServiceLabel();
  const [form, setForm] = useState<FormState>({ ...EMPTY, clientId: search.get('clientId') ?? '' });

  const existing = useQuery({
    queryKey: ['job', id],
    queryFn: () => api.get<InspectionJob>(`/jobs/${id}`),
    enabled: isEdit,
  });
  const clients = useQuery({ queryKey: ['clients', ''], queryFn: () => api.get<Client[]>('/clients'), enabled: !isEdit });
  const inspectors = useQuery({
    queryKey: ['users', 'inspector'],
    queryFn: () => api.get<User[]>('/users?role=inspector'),
    enabled: !isEdit,
  });

  useEffect(() => {
    const j = existing.data;
    if (!j) return;
    setForm({
      clientId: j.clientId,
      type: j.type,
      location: j.location,
      vesselOrObject: j.vesselOrObject ?? '',
      commodity: j.commodity ?? '',
      quantity: j.quantity ?? '',
      scheduledAt: toLocalInput(j.scheduledAt),
      instructions: j.instructions ?? '',
      assignedInspectorId: j.assignedInspectorId ?? '',
    });
  }, [existing.data]);

  const save = useMutation({
    mutationFn: async () => {
      const common = blanksToNull({
        location: form.location,
        vesselOrObject: form.vesselOrObject,
        commodity: form.commodity,
        quantity: form.quantity,
        instructions: form.instructions,
      });
      const scheduledAt = fromLocalInput(form.scheduledAt);
      if (isEdit) return api.patch<InspectionJob>(`/jobs/${id}`, { ...common, scheduledAt });
      return api.post<InspectionJob>('/jobs', {
        ...common,
        scheduledAt,
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

  // An inspector must belong to the same branch as the client (enforced by the API as well).
  const selectedClient = clients.data?.find((c) => c.id === form.clientId);
  const branchInspectors = (inspectors.data ?? []).filter(
    (u) => u.isActive && (!selectedClient || u.branchId === selectedClient.branchId),
  );

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <>
      <PageHead title={isEdit ? t('jobs.editTitle', { number: existing.data?.jobNumber }) : t('jobs.new')} />
      <Card>
        <form onSubmit={onSubmit}>
          <ErrorBox error={save.error ?? existing.error} />
          <div className="form-grid" style={{ marginTop: 8 }}>
            {!isEdit && (
              <>
                <Field label={`${t('jobs.client')} *`}>
                  <Select required value={form.clientId} onChange={(e) => set('clientId', e.target.value)}>
                    <option value="">{t('jobs.selectClient')}</option>
                    {clients.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} {c.branchCode ? `(${c.branchCode})` : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`${t('jobs.type')} *`}>
                  <Select required value={form.type} onChange={(e) => set('type', e.target.value as ServiceType)}>
                    <option value="">{t('jobs.selectType')}</option>
                    {SERVICE_TYPES.map((s) => (
                      <option key={s} value={s}>
                        {serviceLabel(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('jobs.inspector')}>
                  <Select value={form.assignedInspectorId} onChange={(e) => set('assignedInspectorId', e.target.value)}>
                    <option value="">{t('jobs.unassigned')}</option>
                    {branchInspectors.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.fullName}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <Field label={`${t('jobs.location')} *`}>
              <Input required minLength={2} value={form.location} onChange={(e) => set('location', e.target.value)} />
            </Field>
            <Field label={t('jobs.vessel')}>
              <Input value={form.vesselOrObject} onChange={(e) => set('vesselOrObject', e.target.value)} />
            </Field>
            <Field label={t('jobs.commodity')}>
              <Input value={form.commodity} onChange={(e) => set('commodity', e.target.value)} />
            </Field>
            <Field label={t('jobs.quantity')}>
              <Input value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
            </Field>
            <Field label={t('jobs.scheduled')}>
              <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
            </Field>
            <div className="span-all">
              <Field label={t('jobs.instructions')}>
                <TextArea value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="form-actions">
            <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {isEdit ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

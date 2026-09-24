import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, BadgeTone, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { CONTRACT_STATUSES, Contract, ContractStatus, Page, SERVICE_TYPES, ServiceType } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, useFormatDate, useServiceLabel } from './common';

export const CONTRACT_TONE: Record<ContractStatus, BadgeTone> = {
  draft: 'neutral',
  active: 'success',
  suspended: 'warning',
  expired: 'neutral',
  terminated: 'danger',
};

interface FormState {
  contractNo: string;
  title: string;
  status: ContractStatus;
  signedOn: string;
  validFrom: string;
  validTo: string;
  currency: string;
  valueAmount: string;
  paymentTermsDays: string;
  incoterms: string;
  services: ServiceType[];
  notes: string;
}

const EMPTY: FormState = {
  contractNo: '',
  title: '',
  status: 'draft',
  signedOn: '',
  validFrom: '',
  validTo: '',
  currency: '',
  valueAmount: '',
  paymentTermsDays: '',
  incoterms: '',
  services: [],
  notes: '',
};

/**
 * Contracts a client's work runs under: what they cover, the payment terms invoicing should
 * use, and the signed document itself.
 */
export function ContractsCard({ clientId, currency }: { clientId: string; currency?: string | null }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [uploadFor, setUploadFor] = useState<string | null>(null);

  const canWrite = can('contract.manage');
  const contracts = useQuery({
    queryKey: ['contracts', clientId],
    queryFn: () => api.get<Page<Contract>>(`/contracts?clientId=${clientId}&limit=100`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['contracts'] });
    qc.invalidateQueries({ queryKey: ['clients'] });
  };

  const save = useMutation({
    mutationFn: (state: FormState) => {
      const body = blanksToNull({
        ...state,
        valueAmount: state.valueAmount === '' ? null : Number(state.valueAmount),
        paymentTermsDays: state.paymentTermsDays === '' ? null : Number(state.paymentTermsDays),
        services: state.services,
      } as Record<string, unknown>);
      return editing === 'new'
        ? api.post<Contract>('/contracts', { ...body, clientId })
        : api.patch<Contract>(`/contracts/${editing}`, body);
    },
    onSuccess: () => {
      setEditing(null);
      setForm(EMPTY);
      refresh();
    },
  });

  const upload = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const data = new FormData();
      data.append('file', file);
      return api.upload<Contract>(`/contracts/${id}/file`, data);
    },
    onSettled: () => {
      setUploadFor(null);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/contracts/${id}`),
    onSuccess: refresh,
  });

  function edit(c: Contract) {
    setEditing(c.id);
    setForm({
      contractNo: c.contractNo,
      title: c.title ?? '',
      status: c.status,
      signedOn: c.signedOn ?? '',
      validFrom: c.validFrom ?? '',
      validTo: c.validTo ?? '',
      currency: c.currency ?? '',
      valueAmount: c.valueAmount != null ? String(c.valueAmount) : '',
      paymentTermsDays: c.paymentTermsDays != null ? String(c.paymentTermsDays) : '',
      incoterms: c.incoterms ?? '',
      services: c.services ?? [],
      notes: c.notes ?? '',
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(form);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && uploadFor) upload.mutate({ id: uploadFor, file });
  }

  function toggleService(s: ServiceType) {
    setForm((f) => ({
      ...f,
      services: f.services.includes(s) ? f.services.filter((x) => x !== s) : [...f.services, s],
    }));
  }

  const rows = contracts.data?.rows ?? [];

  return (
    <Card
      title={t('contracts.title')}
      actions={
        canWrite && !editing ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing('new');
              setForm({ ...EMPTY, currency: currency ?? '' });
            }}
          >
            + {t('contracts.new')}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={contracts.error ?? save.error ?? upload.error ?? remove.error} />
      <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" hidden onChange={onFile} />

      {editing && (
        <form className="form-grid" onSubmit={submit} style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Field label={t('contracts.number')}>
            <Input required value={form.contractNo} onChange={(e) => setForm({ ...form, contractNo: e.target.value })} />
          </Field>
          <Field label={t('contracts.subject')}>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label={t('contracts.status')}>
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ContractStatus })}>
              {CONTRACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`contracts.statuses.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('contracts.signedOn')}>
            <Input type="date" value={form.signedOn} onChange={(e) => setForm({ ...form, signedOn: e.target.value })} />
          </Field>
          <Field label={t('contracts.validFrom')}>
            <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </Field>
          <Field label={t('contracts.validTo')}>
            <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          </Field>
          <Field label={t('contracts.currency')}>
            <Input
              maxLength={3}
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label={t('contracts.value')}>
            <Input
              inputMode="decimal"
              value={form.valueAmount}
              onChange={(e) => setForm({ ...form, valueAmount: e.target.value })}
            />
          </Field>
          <Field label={t('contracts.paymentTerms')} hint={t('contracts.paymentTermsHint')}>
            <Input
              inputMode="numeric"
              value={form.paymentTermsDays}
              onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
            />
          </Field>
          <Field label={t('contracts.incoterms')}>
            <Input value={form.incoterms} onChange={(e) => setForm({ ...form, incoterms: e.target.value })} />
          </Field>
          <div className="form-grid__wide">
            <span className="gsi-field__label">{t('contracts.services')}</span>
            <div className="chips">
              {SERVICE_TYPES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${form.services.includes(s) ? ' chip--on' : ''}`}
                  onClick={() => toggleService(s)}
                >
                  {serviceLabel(s)}
                </button>
              ))}
            </div>
          </div>
          <div className="row-actions">
            <Button type="submit" loading={save.isPending}>
              {t('common.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}

      {contracts.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('contracts.empty')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('contracts.number')}</th>
              <th>{t('contracts.status')}</th>
              <th>{t('contracts.validity')}</th>
              <th>{t('contracts.paymentTerms')}</th>
              <th>{t('contracts.document')}</th>
              <th>{t('clients.jobs')}</th>
              {canWrite && <th style={{ width: 150 }}>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.contractNo}</strong>
                  {c.title ? <div className="muted">{c.title}</div> : null}
                </td>
                <td>
                  <Badge tone={CONTRACT_TONE[c.status]}>{t(`contracts.statuses.${c.status}`)}</Badge>
                  {c.daysToExpiry != null && c.daysToExpiry >= 0 && c.daysToExpiry <= 60 && c.status === 'active' && (
                    <div className="import-msg import-msg--warn">{t('contracts.expiresIn', { days: c.daysToExpiry })}</div>
                  )}
                </td>
                <td>
                  {c.validFrom ? fmt(c.validFrom) : '—'} — {c.validTo ? fmt(c.validTo) : '∞'}
                </td>
                <td>{c.paymentTermsDays != null ? t('contracts.days', { days: c.paymentTermsDays }) : '—'}</td>
                <td>
                  {c.fileUrl ? (
                    <a href={c.fileUrl} target="_blank" rel="noreferrer">
                      {c.fileName}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{c.jobCount ?? 0}</td>
                {canWrite && (
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => edit(c)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={upload.isPending && uploadFor === c.id}
                        onClick={() => {
                          setUploadFor(c.id);
                          fileRef.current?.click();
                        }}
                      >
                        {c.fileUrl ? t('contracts.replaceFile') : t('contracts.attach')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(t('contracts.confirmDelete', { number: c.contractNo }))) remove.mutate(c.id);
                        }}
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

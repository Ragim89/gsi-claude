import { FormEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Field, Input, Select, TextArea } from '@gsi/ui-kit/react';
import { Branch, Client } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from './common';

type Fields = {
  name: string;
  gaftaFosfaRef: string;
  taxId: string;
  country: string;
  address: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  branchId: string;
};

function fromClient(c?: Client): Fields {
  return {
    name: c?.name ?? '',
    gaftaFosfaRef: c?.gaftaFosfaRef ?? '',
    taxId: c?.taxId ?? '',
    country: c?.country ?? '',
    address: c?.address ?? '',
    contactName: c?.contactName ?? '',
    contactEmail: c?.contactEmail ?? '',
    contactPhone: c?.contactPhone ?? '',
    notes: c?.notes ?? '',
    branchId: c?.branchId ?? '',
  };
}

/** Create or edit a client. On success, calls onSaved with the stored record. */
export function ClientForm({ client, onSaved, onCancel }: { client?: Client; onSaved(c: Client): void; onCancel(): void }) {
  const { t } = useTranslation();
  const { isHq } = useAuth();
  const [f, setF] = useState<Fields>(fromClient(client));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches'), enabled: isHq && !client });

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { branchId, ...rest } = f;
    const body = blanksToNull({ ...rest, country: rest.country.toUpperCase() });
    try {
      const saved = client
        ? await api.patch<Client>(`/clients/${client.id}`, body)
        : await api.post<Client>('/clients', isHq && branchId ? { ...body, branchId } : body);
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <ErrorBox error={error} />
      <div className="form-grid" style={{ marginTop: 8 }}>
        <Field label={`${t('clients.name')} *`}>
          <Input required minLength={2} value={f.name} onChange={set('name')} />
        </Field>
        {isHq && !client && (
          <Field label={t('common.branch')}>
            <Select value={f.branchId} onChange={set('branchId')}>
              <option value="">—</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.city}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('clients.gafta')}>
          <Input value={f.gaftaFosfaRef} onChange={set('gaftaFosfaRef')} />
        </Field>
        <Field label={t('clients.taxId')}>
          <Input value={f.taxId} onChange={set('taxId')} />
        </Field>
        <Field label={t('clients.country')}>
          <Input maxLength={2} value={f.country} onChange={set('country')} style={{ textTransform: 'uppercase' }} />
        </Field>
        <Field label={t('clients.contactName')}>
          <Input value={f.contactName} onChange={set('contactName')} />
        </Field>
        <Field label={t('clients.contactEmail')}>
          <Input type="email" value={f.contactEmail} onChange={set('contactEmail')} />
        </Field>
        <Field label={t('clients.contactPhone')}>
          <Input type="tel" value={f.contactPhone} onChange={set('contactPhone')} />
        </Field>
        <div className="span-all">
          <Field label={t('clients.address')}>
            <Input value={f.address} onChange={set('address')} />
          </Field>
        </div>
        <div className="span-all">
          <Field label={t('clients.notes')}>
            <TextArea value={f.notes} onChange={set('notes')} />
          </Field>
        </div>
      </div>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={busy}>
          {client ? t('common.save') : t('common.create')}
        </Button>
      </div>
    </form>
  );
}

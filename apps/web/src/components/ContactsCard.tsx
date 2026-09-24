import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Table } from '@gsi/ui-kit/react';
import type { ClientContact } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading } from './common';

interface FormState {
  fullName: string;
  position: string;
  email: string;
  phone: string;
  isPrimary: boolean;
}

const EMPTY: FormState = { fullName: '', position: '', email: '', phone: '', isPrimary: false };

/**
 * The people at a client. An inspection company writes to operations about a nomination, to
 * documentation about a certificate and to accounts about an invoice — so the card keeps them
 * apart and marks the one to write to by default.
 */
export function ContactsCard({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);

  const canWrite = can('client.update');
  const contacts = useQuery({
    queryKey: ['contacts', clientId],
    queryFn: () => api.get<ClientContact[]>(`/clients/${clientId}/contacts`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['contacts', clientId] });
    qc.invalidateQueries({ queryKey: ['clients'] });
  };

  const save = useMutation({
    mutationFn: (state: FormState) => {
      const body = blanksToNull({ ...state });
      return editing === 'new'
        ? api.post<ClientContact>(`/clients/${clientId}/contacts`, body)
        : api.patch<ClientContact>(`/clients/${clientId}/contacts/${editing}`, body);
    },
    onSuccess: () => {
      setEditing(null);
      setForm(EMPTY);
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/clients/${clientId}/contacts/${id}`),
    onSuccess: refresh,
  });

  function edit(contact: ClientContact) {
    setEditing(contact.id);
    setForm({
      fullName: contact.fullName,
      position: contact.position ?? '',
      email: contact.email ?? '',
      phone: contact.phone ?? '',
      isPrimary: contact.isPrimary,
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(form);
  }

  return (
    <Card
      title={t('contacts.title')}
      actions={
        canWrite && !editing ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing('new');
              setForm(EMPTY);
            }}
          >
            + {t('contacts.new')}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={contacts.error ?? save.error ?? remove.error} />

      {editing && (
        <form className="form-grid" onSubmit={submit} style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Field label={t('contacts.fullName')}>
            <Input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
          <Field label={t('contacts.position')}>
            <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} />
          </Field>
          <Field label={t('contacts.email')}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={t('contacts.phone')}>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.isPrimary}
              onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })}
            />
            {t('contacts.makePrimary')}
          </label>
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

      {contacts.isLoading ? (
        <Loading />
      ) : !contacts.data?.length ? (
        <EmptyState>{t('contacts.empty')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('contacts.fullName')}</th>
              <th>{t('contacts.position')}</th>
              <th>{t('contacts.email')}</th>
              <th>{t('contacts.phone')}</th>
              {canWrite && <th style={{ width: 150 }}>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {contacts.data.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.fullName} {c.isPrimary && <Badge tone="accent">{t('contacts.primary')}</Badge>}
                </td>
                <td>{c.position ?? '—'}</td>
                <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</td>
                <td>{c.phone ?? '—'}</td>
                {canWrite && (
                  <td>
                    <div className="row-actions">
                      <Button size="sm" variant="ghost" onClick={() => edit(c)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(t('contacts.confirmDelete', { name: c.fullName }))) remove.mutate(c.id);
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

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import type { Laboratory } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useBranch } from '../branch';
import { ErrorBox, Loading, PageHead } from '../components/common';

const EMPTY = {
  code: '',
  name: '',
  branchId: '',
  city: '',
  address: '',
  contactEmail: '',
  contactPhone: '',
  notes: '',
  isExternal: false,
};

/**
 * Where samples are sent.
 *
 * Nothing invents these: a fresh installation has no laboratories at all, because no field in
 * the database says which offices run one. Without this screen the dispatch step would be a
 * button with nowhere to send anything — which is the one thing a working system must not have.
 */
export function LaboratoriesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { branches } = useBranch();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const labs = useQuery({
    queryKey: ['laboratories', 'all'],
    queryFn: () => api.get<Laboratory[]>('/samples/laboratories?includeInactive=true'),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['laboratories'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Laboratory>('/samples/laboratories', {
        ...blanksToNull({
          code: form.code.trim(),
          name: form.name.trim(),
          branchId: form.branchId,
          city: form.city,
          address: form.address,
          contactEmail: form.contactEmail,
          contactPhone: form.contactPhone,
          notes: form.notes,
        }),
        isExternal: form.isExternal,
      }),
    onSuccess: () => {
      setAdding(false);
      setForm(EMPTY);
      refresh();
    },
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<Laboratory>(`/samples/laboratories/${id}`, { isActive }),
    onSuccess: refresh,
  });

  const rows = labs.data ?? [];
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="stack">
      <PageHead
        title={t('laboratories.title')}
        sub={t('laboratories.sub')}
        actions={
          <Button variant={adding ? 'ghost' : 'primary'} onClick={() => setAdding((v) => !v)}>
            {adding ? t('common.cancel') : `+ ${t('laboratories.new')}`}
          </Button>
        }
      />

      <ErrorBox error={labs.error ?? create.error ?? setActive.error} />

      {adding && (
        <Card title={t('laboratories.new')}>
          <div className="form-grid">
            <Field label={t('laboratories.code')} hint={t('laboratories.codeHint')}>
              <Input value={form.code} onChange={set('code')} autoFocus />
            </Field>
            <Field label={t('laboratories.name')}>
              <Input value={form.name} onChange={set('name')} />
            </Field>
            <Field label={t('laboratories.office')} hint={t('laboratories.officeHint')}>
              <Select
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value, isExternal: !e.target.value })}
              >
                <option value="">{t('laboratories.externalOption')}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.city}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('job.city')}>
              <Input value={form.city} onChange={set('city')} />
            </Field>
            <Field label={t('clients.address')}>
              <Input value={form.address} onChange={set('address')} />
            </Field>
            <Field label={t('clients.contactEmail')}>
              <Input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
            </Field>
            <Field label={t('clients.contactPhone')}>
              <Input value={form.contactPhone} onChange={set('contactPhone')} />
            </Field>
            <div className="form-grid__wide">
              <Field label={t('clients.notes')}>
                <TextArea rows={2} value={form.notes} onChange={set('notes')} />
              </Field>
            </div>
          </div>
          <div style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              disabled={!form.code.trim() || !form.name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.create')}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t('laboratories.found', { count: rows.length })}>
        {labs.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('laboratories.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('laboratories.code')}</th>
                <th>{t('laboratories.name')}</th>
                <th>{t('laboratories.office')}</th>
                <th>{t('job.city')}</th>
                <th>{t('laboratories.contact')}</th>
                <th>{t('jobs.status')}</th>
                <th style={{ width: 130 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className={l.isActive ? undefined : 'is-muted-row'}>
                  <td className="mono">{l.code}</td>
                  <td>{l.name}</td>
                  <td>
                    {l.isExternal ? (
                      <Badge tone="neutral">{t('laboratories.external')}</Badge>
                    ) : (
                      (l.branchCode ?? '—')
                    )}
                  </td>
                  <td>{l.city ?? '—'}</td>
                  <td>
                    {l.contactEmail ?? '—'}
                    {l.contactPhone ? <div className="muted">{l.contactPhone}</div> : null}
                  </td>
                  <td>
                    <Badge tone={l.isActive ? 'success' : 'neutral'}>
                      {t(l.isActive ? 'laboratories.active' : 'laboratories.closed')}
                    </Badge>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={setActive.isPending}
                      onClick={() => setActive.mutate({ id: l.id, isActive: !l.isActive })}
                    >
                      {t(l.isActive ? 'laboratories.close' : 'laboratories.reopen')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="muted" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
          {t('laboratories.closeHint')}
        </p>
      </Card>
    </div>
  );
}

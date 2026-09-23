import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Branch, Role, User } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead } from '../components/common';

const MVP1_ROLES: Role[] = ['inspector', 'supervisor', 'admin'];

/** Admin: users & roles (docs/01-architecture.md, module 11). */
export function UsersPage() {
  const { t } = useTranslation();
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ email: '', fullName: '', role: 'inspector' as Role, branchId: '', password: '', locale: 'en' });

  const users = useQuery({ queryKey: ['users', 'all'], queryFn: () => api.get<User[]>('/users') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  const create = useMutation({
    mutationFn: () => api.post<User>('/users', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setCreating(false);
      setForm((f) => ({ ...f, email: '', fullName: '', password: '' }));
    },
  });
  const toggle = useMutation({
    mutationFn: (u: User) => api.patch<User>(`/users/${u.id}`, { isActive: !u.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <div className="stack">
      <PageHead title={t('users.title')} actions={!creating && <Button onClick={() => setCreating(true)}>+ {t('users.new')}</Button>} />
      {creating && (
        <Card title={t('users.new')}>
          <form onSubmit={onSubmit}>
            <ErrorBox error={create.error} />
            <div className="form-grid" style={{ marginTop: 8 }}>
              <Field label={t('users.fullName')}>
                <Input required minLength={2} value={form.fullName} onChange={set('fullName')} />
              </Field>
              <Field label={t('users.email')}>
                <Input required type="email" value={form.email} onChange={set('email')} />
              </Field>
              <Field label={t('users.role')}>
                <Select value={form.role} onChange={set('role')}>
                  {MVP1_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`roleNames.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('common.branch')}>
                <Select required value={form.branchId} onChange={set('branchId')}>
                  <option value="">—</option>
                  {branches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} — {b.city}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('users.password')}>
                <Input required type="password" minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} />
              </Field>
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
      <Card>
        <ErrorBox error={users.error ?? toggle.error} />
        {users.isLoading ? (
          <Loading />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('users.fullName')}</th>
                <th>{t('users.email')}</th>
                <th>{t('users.role')}</th>
                <th>{t('common.branch')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td>{u.email}</td>
                  <td>{t(`roleNames.${u.role}`)}</td>
                  <td>{u.branchCode}</td>
                  <td style={{ textAlign: 'end' }}>
                    <span className="row-actions" style={{ justifyContent: 'flex-end' }}>
                      <Badge tone={u.isActive ? 'success' : 'neutral'}>{u.isActive ? t('users.active') : t('users.inactive')}</Badge>
                      {u.id !== me?.id && (
                        <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(u)}>
                          {u.isActive ? t('users.deactivate') : t('users.activate')}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

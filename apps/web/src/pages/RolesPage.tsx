import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, Table } from '@gsi/ui-kit/react';
import type { AccessScope, Permission, PermissionDefinition, RoleDefinition } from '@gsi/shared-types';
import { api } from '../api';
import { ErrorBox, Loading, PageHead } from '../components/common';

const SCOPE_TONE: Record<AccessScope, 'accent' | 'info' | 'neutral'> = {
  global: 'accent',
  country: 'info',
  office: 'neutral',
  own: 'neutral',
};

/**
 * What each role may do, and the editor for it.
 *
 * Permissions are data: granting a laboratory manager the right to approve results is a
 * checkbox here, not a release. The list on the left is the group's roles; the right side is
 * the permission catalogue grouped by area.
 */
export function RolesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<Permission> | null>(null);

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDefinition[]>('/admin/roles') });
  const permissions = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.get<PermissionDefinition[]>('/admin/permissions'),
  });

  const role = roles.data?.find((r) => r.code === (selected ?? roles.data?.[0]?.code));
  const current = draft ?? new Set(role?.permissions ?? []);

  const byCategory = useMemo(() => {
    const map = new Map<string, PermissionDefinition[]>();
    for (const p of permissions.data ?? []) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return [...map.entries()];
  }, [permissions.data]);

  const save = useMutation({
    mutationFn: (codes: Permission[]) =>
      api.put<{ code: string }>(`/admin/roles/${role!.code}/permissions`, { permissions: codes }),
    onSuccess: async () => {
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  if (roles.isLoading || permissions.isLoading) return <Loading />;

  function toggle(code: Permission) {
    const next = new Set(current);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setDraft(next);
  }

  const dirty = draft !== null;

  return (
    <div className="stack">
      <PageHead title={t('roles.title')} sub={t('roles.sub')} />
      <ErrorBox error={roles.error ?? permissions.error ?? save.error} />

      <div className="roles-layout">
        <Card title={t('roles.list')}>
          <Table>
            <thead>
              <tr>
                <th>{t('roles.role')}</th>
                <th style={{ width: 110 }}>{t('roles.scope')}</th>
                <th style={{ width: 70 }}>{t('roles.users')}</th>
              </tr>
            </thead>
            <tbody>
              {roles.data!.map((r) => (
                <tr
                  key={r.code}
                  className={r.code === role?.code ? 'is-selected' : undefined}
                  onClick={() => {
                    setSelected(r.code);
                    setDraft(null);
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted">{r.description}</div>
                  </td>
                  <td>
                    <Badge tone={SCOPE_TONE[r.scope]}>{t(`roles.scopes.${r.scope}`)}</Badge>
                  </td>
                  <td>{r.users ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        {role && (
          <Card
            title={`${role.name} — ${t('roles.permissions')}`}
            actions={
              <div className="row-actions">
                {dirty && (
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('common.cancel')}
                  </Button>
                )}
                <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate([...current])}>
                  {t('common.save')}
                </Button>
              </div>
            }
          >
            <p className="muted">{t('roles.effect')}</p>
            {byCategory.map(([category, items]) => (
              <section key={category} className="perm-group">
                <h3>{t(`roles.categories.${category}`, { defaultValue: category })}</h3>
                <div className="perm-grid">
                  {items.map((p) => (
                    <label key={p.code} className="perm">
                      <input type="checkbox" checked={current.has(p.code)} onChange={() => toggle(p.code)} />
                      <span>
                        <code>{p.code}</code>
                        <span className="muted">{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}

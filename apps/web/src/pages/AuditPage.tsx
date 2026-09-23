import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Input, Select, Table } from '@gsi/ui-kit/react';
import type { AuditEntry } from '@gsi/shared-types';
import { api } from '../api';
import { useBranch } from '../branch';
import { DEFAULT_RANGE, DateRangeFilter, Range } from '../components/DateRangeFilter';
import { ErrorBox, Loading, PageHead } from '../components/common';

interface AuditPage {
  rows: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

/** Actions worth filtering by, grouped the way people ask about them. */
const ACTION_GROUPS = ['auth', 'job', 'report', 'client', 'invoice', 'expense', 'asset', 'user', 'role', 'org'];

const TONE = (action: string) => {
  if (action.endsWith('.failed')) return 'danger' as const;
  if (action.startsWith('auth.')) return 'neutral' as const;
  if (action.includes('approve') || action.includes('issue')) return 'success' as const;
  if (action.includes('delete') || action.includes('cancel') || action.includes('archive')) return 'warning' as const;
  return 'info' as const;
};

/**
 * The audit trail: who did what, when, and what the values were before and after.
 *
 * Read-only by construction — the API has no endpoint that edits an entry, and the database
 * role behind it has no permission to either.
 */
export function AuditPage() {
  const { t, i18n } = useTranslation();
  const { branchId } = useBranch();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const limit = 50;
  const params = new URLSearchParams();
  if (branchId) params.set('branchId', branchId);
  if (action) params.set('action', action);
  if (search.trim()) params.set('search', search.trim());
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  params.set('limit', String(limit));
  params.set('offset', String(page * limit));

  const log = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => api.get<AuditPage>(`/admin/audit?${params}`),
  });

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });

  const pages = Math.ceil((log.data?.total ?? 0) / limit);

  return (
    <div className="stack">
      <PageHead title={t('audit.title')} sub={t('audit.sub')} />

      <Card>
        <div className="filter-row">
          <DateRangeFilter value={range} onChange={(r) => { setRange(r); setPage(0); }} />
          <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }}>
            <option value="">{t('audit.allActions')}</option>
            {ACTION_GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`audit.groups.${g}`, { defaultValue: g })}
              </option>
            ))}
          </Select>
          <Input
            placeholder={t('audit.search')}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
      </Card>

      <ErrorBox error={log.error} />

      <Card title={t('audit.entries', { total: log.data?.total ?? 0 })}>
        {log.isLoading ? (
          <Loading />
        ) : !log.data?.rows.length ? (
          <EmptyState>{t('audit.empty')}</EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>{t('audit.when')}</th>
                  <th style={{ width: 200 }}>{t('audit.who')}</th>
                  <th style={{ width: 170 }}>{t('audit.action')}</th>
                  <th>{t('audit.record')}</th>
                  <th style={{ width: 80 }}>{t('audit.branch')}</th>
                </tr>
              </thead>
              <tbody>
                {log.data.rows.map((e) => (
                  <Fragment key={e.id}>
                    <tr
                      onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                      style={{ cursor: e.beforeData || e.afterData || e.metadata ? 'pointer' : 'default' }}
                    >
                      <td className="mono">{fmt(e.occurredAt)}</td>
                      <td>
                        {e.userEmail ?? '—'}
                        {e.userRole ? <div className="muted">{e.userRole}</div> : null}
                      </td>
                      <td>
                        <Badge tone={TONE(e.action)}>{e.action}</Badge>
                      </td>
                      <td>
                        {e.entityLabel ?? '—'}
                        {e.entityType ? <span className="muted"> · {e.entityType}</span> : null}
                      </td>
                      <td>{e.branchCode ?? '—'}</td>
                    </tr>
                    {expanded === e.id && (e.beforeData || e.afterData || e.metadata) && (
                      <tr>
                        <td colSpan={5}>
                          <div className="audit-detail">
                            {e.beforeData && (
                              <div>
                                <h4>{t('audit.before')}</h4>
                                <pre>{JSON.stringify(e.beforeData, null, 2)}</pre>
                              </div>
                            )}
                            {e.afterData && (
                              <div>
                                <h4>{t('audit.after')}</h4>
                                <pre>{JSON.stringify(e.afterData, null, 2)}</pre>
                              </div>
                            )}
                            {e.metadata && (
                              <div>
                                <h4>{t('audit.details')}</h4>
                                <pre>{JSON.stringify(e.metadata, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>

            {pages > 1 && (
              <div className="row-actions" style={{ marginTop: 'var(--gsi-space-3)' }}>
                <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  ←
                </Button>
                <span className="muted">{t('audit.page', { page: page + 1, pages })}</span>
                <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  →
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

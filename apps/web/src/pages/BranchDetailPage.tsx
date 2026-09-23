import { ChangeEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Spinner, Table } from '@gsi/ui-kit/react';
import { Branch, Role } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { flag, useBranch } from '../branch';
import { StatTile } from '../components/charts';
import { ErrorBox, Loading, PageHead } from '../components/common';

interface BranchCard extends Branch {
  team: { id: string; fullName: string; role: Role; email: string; isActive: boolean }[];
  stats: {
    clientCount: number;
    jobCount: number;
    openJobCount: number;
    reportCount: number;
    activeUserCount: number;
  };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

/** One legal entity: hero with photo and head, full requisites, team, workload. */
export function BranchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { user, isHq, can } = useAuth();
  const { setBranchId, branchId } = useBranch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const photoInput = useRef<HTMLInputElement>(null);
  const headInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<'photo' | 'head' | null>(null);

  const q = useQuery({ queryKey: ['branch', id], queryFn: () => api.get<BranchCard>(`/branches/${id}`) });
  const isAdmin = can('branch.manage');

  const upload = useMutation({
    mutationFn: async ({ kind, file }: { kind: 'photo' | 'head'; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<BranchCard>(`/branches/${id}/${kind === 'photo' ? 'photo' : 'head-photo'}`, form);
    },
    onSettled: () => {
      setUploading(null);
      qc.invalidateQueries({ queryKey: ['branch', id] });
      qc.invalidateQueries({ queryKey: ['branches'] });
    },
  });

  const pick = (kind: 'photo' | 'head') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(kind);
    upload.mutate({ kind, file });
  };

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const b = q.data;

  const focus = (path: string) => {
    if (isHq) setBranchId(b.id);
    navigate(path);
  };

  const detail = (label: string, value: string | number | null | undefined, mono = false) => (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value || '—'}</dd>
    </div>
  );

  return (
    <div className="stack">
      <PageHead
        title={
          <span className="row-actions">
            <span>
              {flag(b.country)} {b.code}
            </span>
            <span className="muted" style={{ fontSize: 16 }}>
              {b.city}
            </span>
            {b.isHq ? <Badge tone="accent">HQ</Badge> : null}
            {isHq && branchId === b.id ? <Badge tone="info">{t('branches.active')}</Badge> : null}
          </span>
        }
        sub={b.legalName}
        actions={
          <>
            {isHq && (
              <Button variant="secondary" onClick={() => setBranchId(b.id)}>
                {t('branches.focus')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => focus('/jobs')}>
              {t('nav.jobs')}
            </Button>
            <Button variant="secondary" onClick={() => focus('/clients')}>
              {t('nav.clients')}
            </Button>
            <Button variant="secondary" onClick={() => focus('/finance')}>
              {t('nav.dashboard')}
            </Button>
          </>
        }
      />
      <ErrorBox error={upload.error} />

      {/* Hero: office photo (or a branded placeholder) with the head of the entity on top. */}
      <section className="branch-hero">
        <div className="branch-hero__photo">
          {b.photoUrl ? (
            <img src={b.photoUrl} alt="" />
          ) : (
            <div className="branch-hero__placeholder">
              <span className="branch-hero__flag">{flag(b.country)}</span>
              <span className="branch-hero__code">{b.code}</span>
            </div>
          )}
          {isAdmin && (
            <button type="button" className="branch-hero__upload" onClick={() => photoInput.current?.click()} disabled={uploading === 'photo'}>
              {uploading === 'photo' ? <Spinner size={14} /> : '📷'} {t('branches.changePhoto')}
            </button>
          )}
          <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick('photo')} />
        </div>

        <div className="branch-hero__head">
          <div className="branch-head">
            <div className="branch-head__avatar">
              {b.headPhotoUrl ? (
                <img src={b.headPhotoUrl} alt="" />
              ) : (
                <span>{b.headName ? initials(b.headName) : '—'}</span>
              )}
              {isAdmin && (
                <button type="button" className="branch-head__upload" onClick={() => headInput.current?.click()} disabled={uploading === 'head'} title={t('branches.changeHeadPhoto')}>
                  {uploading === 'head' ? <Spinner size={12} /> : '✎'}
                </button>
              )}
              <input ref={headInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={pick('head')} />
            </div>
            <div>
              <div className="branch-head__label">{t('branches.head')}</div>
              <div className="branch-head__name">{b.headName ?? t('branches.headUnset')}</div>
              <div className="branch-head__title">{b.headTitle ?? ''}</div>
              {b.headEmail ? (
                <a className="branch-head__mail" href={`mailto:${b.headEmail}`}>
                  {b.headEmail}
                </a>
              ) : null}
            </div>
          </div>
          {b.description ? <p className="branch-hero__about">{b.description}</p> : null}
        </div>
      </section>

      <div className="kpi-row">
        <StatTile label={t('clients.title')} value={String(b.stats.clientCount)} />
        <StatTile label={t('jobs.title')} value={String(b.stats.jobCount)} hint={t('branches.openJobs', { count: b.stats.openJobCount })} />
        <StatTile label={t('dashboard.reportsIssued')} value={String(b.stats.reportCount)} />
        <StatTile label={t('branches.team')} value={String(b.stats.activeUserCount)} hint={t('branches.activeUsers')} />
      </div>

      <div className="two-col">
        <div className="stack">
          <Card title={t('branches.legalRequisites')}>
            <dl className="detail-grid">
              {detail(t('branches.legalName'), b.legalName)}
              {detail(t('branches.legalForm'), b.legalForm)}
              {detail(t('branches.registrationNo'), b.registrationNo, true)}
              {detail(t('branches.taxId'), b.taxId, true)}
              {detail(t('branches.vatNumber'), b.vatNumber, true)}
              {detail(t('branches.established'), b.establishedYear)}
              {detail(t('clients.address'), b.address)}
              {detail(t('branches.accreditation'), b.accreditation)}
            </dl>
          </Card>

          <Card title={t('branches.bank')}>
            <dl className="detail-grid">
              {detail(t('branches.bankName'), b.bankName)}
              {detail(t('branches.bankAccount'), b.bankAccount, true)}
              {detail(t('branches.bankSwift'), b.bankSwift, true)}
              {detail(t('branches.currency'), b.currency)}
            </dl>
            <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
              {t('branches.bankHint')}
            </p>
          </Card>

          <Card title={t('branches.operational')}>
            <dl className="detail-grid">
              {detail(t('clients.contactPhone'), b.phone)}
              {detail(t('clients.contactEmail'), b.email)}
              {detail(t('branches.website'), b.website)}
              {detail(t('branches.timezone'), b.timezone)}
              {detail(t('branches.locale'), `${b.locale} (${b.uiLocales.join(', ')})`)}
              {detail(t('branches.template'), b.letterheadTemplateId)}
            </dl>
          </Card>
        </div>

        <Card title={t('branches.team')}>
          {!b.team.length ? (
            <EmptyState>{t('branches.noTeam')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('users.fullName')}</th>
                  <th>{t('users.role')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {b.team.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.fullName}
                      {u.id === b.headUserId ? <> <Badge tone="accent">{t('branches.headShort')}</Badge></> : null}
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.email}
                      </div>
                    </td>
                    <td>{t(`roleNames.${u.role}`)}</td>
                    <td style={{ textAlign: 'end' }}>{u.isActive ? null : <Badge tone="neutral">{t('users.inactive')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
            <Link to="/users">{t('nav.users')}</Link>
            {isAdmin ? ` · ${t('branches.editHint')}` : ''}
          </p>
        </Card>
      </div>
    </div>
  );
}

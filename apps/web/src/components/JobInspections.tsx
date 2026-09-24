import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { Inspection, InspectionJob, Page, SERVICE_TYPES, ServiceType, User } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ChecklistProgress, InspectionStatusBadge } from './InspectionBits';
import { ErrorBox, Loading, fromLocalInput, useFormatDate, useServiceLabel } from './common';

/**
 * The field work booked against one job. A job usually has one inspection; a loading and a
 * discharge survey, or a re-inspection after a finding is fixed, make it several — which is
 * exactly why the checklist no longer lives on the job itself.
 */
export function JobInspections({ job }: { job: InspectionJob }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fmt = useFormatDate();
  const serviceLabel = useServiceLabel();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    type: job.type as ServiceType,
    location: job.location ?? '',
    scheduledStart: '',
    leadInspectorId: job.assignedInspectorId ?? '',
  });

  const list = useQuery({
    queryKey: ['job-inspections', job.id],
    queryFn: () => api.get<Page<Inspection>>(`/inspections?jobId=${job.id}&limit=50`),
  });

  const people = useQuery({
    queryKey: ['users', 'assignable'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: can('inspection.create'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Inspection>('/inspections', {
        jobId: job.id,
        ...blanksToNull({ type: form.type, location: form.location, leadInspectorId: form.leadInspectorId }),
        scheduledStart: fromLocalInput(form.scheduledStart),
      }),
    onSuccess: (created) => {
      setAdding(false);
      qc.invalidateQueries({ queryKey: ['job-inspections', job.id] });
      qc.invalidateQueries({ queryKey: ['inspections'] });
      navigate(`/inspections/${created.id}`);
    },
  });

  const rows = list.data?.rows ?? [];
  const canAdd = can('inspection.create') && !['closed', 'cancelled'].includes(job.status);

  return (
    <Card
      title={t('inspections.title')}
      actions={
        canAdd ? (
          <Button variant={adding ? 'ghost' : 'secondary'} onClick={() => setAdding((v) => !v)}>
            {adding ? t('common.cancel') : `+ ${t('inspections.new')}`}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={list.error ?? create.error} />

      {adding && (
        <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <div className="form-grid">
            <Field label={t('jobs.type')}>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ServiceType })}>
                {SERVICE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {serviceLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('jobs.location')}>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </Field>
            <Field label={t('inspection.scheduledStart')} hint={t('inspections.scheduleHint')}>
              <Input
                type="datetime-local"
                value={form.scheduledStart}
                onChange={(e) => setForm({ ...form, scheduledStart: e.target.value })}
              />
            </Field>
            <Field label={t('jobs.lead')}>
              <Select
                value={form.leadInspectorId}
                onChange={(e) => setForm({ ...form, leadInspectorId: e.target.value })}
              >
                <option value="">{t('job.selectPerson')}</option>
                {(people.data ?? [])
                  .filter((u) => u.branchId === job.branchId && u.isActive)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              {t('inspections.create')}
            </Button>
          </div>
        </div>
      )}

      {list.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('inspections.noneOnJob')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('inspections.number')}</th>
              <th>{t('jobs.type')}</th>
              <th>{t('inspections.scheduled')}</th>
              <th>{t('jobs.lead')}</th>
              <th>{t('checklist.title')}</th>
              <th>{t('inspection.findings')}</th>
              <th>{t('jobs.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id} className="link-row" onClick={() => navigate(`/inspections/${x.id}`)}>
                <td className="mono">
                  <Link to={`/inspections/${x.id}`} onClick={(e) => e.stopPropagation()}>
                    {x.inspectionNumber}
                  </Link>
                </td>
                <td>{serviceLabel(x.type)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmt(x.scheduledStart)}</td>
                <td>{x.leadInspectorName ?? <span className="muted">{t('jobs.unassigned')}</span>}</td>
                <td style={{ minWidth: 140 }}>
                  <ChecklistProgress
                    done={x.checklistDone ?? 0}
                    total={x.checklistTotal ?? 0}
                    required={x.requiredRemaining ?? 0}
                  />
                </td>
                <td className="num">{x.findingCount ?? 0}</td>
                <td>
                  <InspectionStatusBadge status={x.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

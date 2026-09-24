import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { INSTRUMENT_STATUSES, InstrumentStatus, LabInstrument, Laboratory } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

const EMPTY = {
  laboratoryId: '',
  code: '',
  name: '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  calibrationDueAt: '',
};

/**
 * The equipment a result can be attributed to.
 *
 * An overdue calibration is a warning, never a block: refusing to record a measurement that
 * has already been taken would lose the measurement, and the laboratory would still have the
 * overdue instrument. The result carries the fact instead, permanently.
 */
export function LabInstrumentsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const manage = can('lab.instrument.manage');

  const [laboratoryId, setLaboratoryId] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const labs = useQuery({
    queryKey: ['laboratories'],
    queryFn: () => api.get<Laboratory[]>('/samples/laboratories'),
    staleTime: 300_000,
  });
  const list = useQuery({
    queryKey: ['lab-instruments', laboratoryId],
    queryFn: () => api.get<LabInstrument[]>(`/lab/instruments${laboratoryId ? `?laboratoryId=${laboratoryId}` : ''}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<LabInstrument>('/lab/instruments', {
        laboratoryId: form.laboratoryId,
        code: form.code.trim(),
        name: form.name.trim(),
        ...blanksToNull({
          manufacturer: form.manufacturer,
          model: form.model,
          serialNumber: form.serialNumber,
          calibrationDueAt: form.calibrationDueAt,
        }),
      }),
    onSuccess: () => {
      setAdding(false);
      setForm(EMPTY);
      qc.invalidateQueries({ queryKey: ['lab-instruments'] });
    },
  });

  const update = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) =>
      api.patch<LabInstrument>(`/lab/instruments/${v.id}`, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lab-instruments'] }),
  });

  const rows = list.data ?? [];

  return (
    <div className="stack">
      <PageHead
        title={t('lab.instruments')}
        sub={t('lab.instrumentsSub')}
        actions={
          manage ? (
            <Button variant={adding ? 'ghost' : 'secondary'} onClick={() => setAdding((v) => !v)}>
              {adding ? t('common.cancel') : `+ ${t('lab.newInstrument')}`}
            </Button>
          ) : undefined
        }
      />
      <ErrorBox error={list.error ?? create.error ?? update.error} />

      {adding && (
        <Card title={t('lab.newInstrument')}>
          <div className="form-grid">
            <Field label={t('lab.laboratory')}>
              <Select value={form.laboratoryId} onChange={(e) => setForm({ ...form, laboratoryId: e.target.value })}>
                <option value="">{t('sample.chooseLab')}</option>
                {(labs.data ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('lab.code')}>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label={t('lab.name')}>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('lab.manufacturer')}>
              <Input value={form.manufacturer} onChange={(e) => setForm({ ...form, manufacturer: e.target.value })} />
            </Field>
            <Field label={t('lab.model')}>
              <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </Field>
            <Field label={t('lab.serialNumber')}>
              <Input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
            </Field>
            <Field label={t('lab.calibrationDue')}>
              <Input
                type="date"
                value={form.calibrationDueAt}
                onChange={(e) => setForm({ ...form, calibrationDueAt: e.target.value })}
              />
            </Field>
          </div>
          <div style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
            <Button
              loading={create.isPending}
              disabled={!form.laboratoryId || !form.code.trim() || !form.name.trim()}
              onClick={() => create.mutate()}
            >
              {t('lab.newInstrument')}
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="filter-row">
          <Select value={laboratoryId} onChange={(e) => setLaboratoryId(e.target.value)}>
            <option value="">{t('lab.laboratory')}: {t('common.all')}</option>
            {(labs.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card title={t('lab.instrumentsFound', { count: rows.length })}>
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState>{t('lab.noInstruments')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('lab.code')}</th>
                <th>{t('lab.name')}</th>
                <th>{t('lab.laboratory')}</th>
                <th>{t('lab.model')}</th>
                <th>{t('lab.serialNumber')}</th>
                <th>{t('lab.calibrationDue')}</th>
                <th>{t('jobs.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id} className={x.status === 'retired' ? 'is-muted-row' : ''}>
                  <td className="mono">{x.code}</td>
                  <td>{x.name}</td>
                  <td>{x.laboratoryName ?? '—'}</td>
                  <td>
                    {x.manufacturer ?? '—'}
                    {x.model ? ` ${x.model}` : ''}
                  </td>
                  <td className="mono">{x.serialNumber ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {fmt(x.calibrationDueAt, false)}
                    {x.calibrationOverdue ? (
                      <div>
                        <Badge tone="danger">{t('lab.calibrationOverdue')}</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {manage ? (
                      <Select
                        value={x.status}
                        onChange={(e) =>
                          update.mutate({ id: x.id, body: { status: e.target.value as InstrumentStatus } })
                        }
                      >
                        {INSTRUMENT_STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {t(`lab.instrumentStatus.${s}`)}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      t(`lab.instrumentStatus.${x.status}`)
                    )}
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

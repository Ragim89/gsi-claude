import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import { LAB_RESULT_TYPES, LabResultType, LabTest, LabUnit, TestMethod, localize } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead, useFormatDate } from '../components/common';

const EMPTY_TEST = {
  code: '',
  en: '',
  ru: '',
  tr: '',
  category: 'chemical',
  resultType: 'numeric' as LabResultType,
  defaultUnit: '',
};

const EMPTY_METHOD = {
  code: '',
  name: '',
  standardReference: '',
  defaultUnit: '',
  detectionLimit: '',
  quantificationLimit: '',
  accreditationScope: '',
  description: '',
};

/**
 * What the laboratory can measure, and how.
 *
 * Methods are versioned by the database: change a limit or a standard and the version goes up,
 * while every result already measured with the old one keeps the old one in its snapshot. That
 * is why this screen shows the version next to the code and never lets it be typed in.
 */
export function LabCataloguePage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const manage = can('lab.method.manage');

  const [selected, setSelected] = useState<string>('');
  const [search, setSearch] = useState('');
  const [addingTest, setAddingTest] = useState(false);
  const [addingMethod, setAddingMethod] = useState(false);
  const [test, setTest] = useState(EMPTY_TEST);
  const [method, setMethod] = useState(EMPTY_METHOD);

  const tests = useQuery({ queryKey: ['lab-tests'], queryFn: () => api.get<LabTest[]>('/lab/tests') });
  const units = useQuery({
    queryKey: ['lab-units'],
    queryFn: () => api.get<LabUnit[]>('/lab/units'),
    staleTime: 600_000,
  });
  const methods = useQuery({
    queryKey: ['lab-methods', selected],
    queryFn: () => api.get<TestMethod[]>(`/lab/methods?labTestId=${selected}&includeInactive=true`),
    enabled: Boolean(selected),
  });

  const createTest = useMutation({
    mutationFn: () =>
      api.post<LabTest>('/lab/tests', {
        code: test.code.trim(),
        name: blanksToNull({ en: test.en.trim(), ru: test.ru.trim(), tr: test.tr.trim() }),
        category: test.category,
        resultType: test.resultType,
        ...blanksToNull({ defaultUnit: test.defaultUnit }),
      }),
    onSuccess: (created) => {
      setAddingTest(false);
      setTest(EMPTY_TEST);
      setSelected(created.id);
      qc.invalidateQueries({ queryKey: ['lab-tests'] });
    },
  });

  const createMethod = useMutation({
    mutationFn: () =>
      api.post<TestMethod>('/lab/methods', {
        labTestId: selected,
        code: method.code.trim(),
        name: method.name.trim(),
        ...blanksToNull({
          standardReference: method.standardReference,
          defaultUnit: method.defaultUnit,
          accreditationScope: method.accreditationScope,
          description: method.description,
        }),
        detectionLimit: method.detectionLimit === '' ? null : Number(method.detectionLimit),
        quantificationLimit: method.quantificationLimit === '' ? null : Number(method.quantificationLimit),
      }),
    onSuccess: () => {
      setAddingMethod(false);
      setMethod(EMPTY_METHOD);
      qc.invalidateQueries({ queryKey: ['lab-methods', selected] });
      qc.invalidateQueries({ queryKey: ['lab-tests'] });
    },
  });

  const retire = useMutation({
    mutationFn: (m: TestMethod) => api.patch<TestMethod>(`/lab/methods/${m.id}`, { isActive: !m.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lab-methods', selected] }),
  });

  const rows = (tests.data ?? []).filter((x) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return x.code.toLowerCase().includes(q) || localize(x.name, i18n.language).toLowerCase().includes(q);
  });
  const current = (tests.data ?? []).find((x) => x.id === selected);

  return (
    <div className="stack">
      <PageHead title={t('lab.catalogue')} sub={t('lab.catalogueSub')} />
      <ErrorBox error={tests.error ?? createTest.error ?? createMethod.error ?? retire.error} />

      <div className="two-col">
        <Card
          title={t('lab.tests')}
          actions={
            manage ? (
              <Button variant={addingTest ? 'ghost' : 'secondary'} onClick={() => setAddingTest((v) => !v)}>
                {addingTest ? t('common.cancel') : `+ ${t('lab.newTest')}`}
              </Button>
            ) : null
          }
        >
          {addingTest && (
            <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
              <div className="form-grid">
                <Field label={t('lab.code')}>
                  <Input value={test.code} onChange={(e) => setTest({ ...test, code: e.target.value })} />
                </Field>
                <Field label={t('lab.nameEn')}>
                  <Input value={test.en} onChange={(e) => setTest({ ...test, en: e.target.value })} />
                </Field>
                <Field label={t('lab.nameTr')}>
                  <Input value={test.tr} onChange={(e) => setTest({ ...test, tr: e.target.value })} />
                </Field>
                <Field label={t('lab.nameRu')}>
                  <Input value={test.ru} onChange={(e) => setTest({ ...test, ru: e.target.value })} />
                </Field>
                <Field label={t('lab.category')}>
                  <Select value={test.category} onChange={(e) => setTest({ ...test, category: e.target.value })}>
                    {['physical', 'chemical', 'microbiological', 'contaminant', 'sensory', 'other'].map((c) => (
                      <option key={c} value={c}>
                        {t(`lab.testCategory.${c}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('lab.resultType')}>
                  <Select
                    value={test.resultType}
                    onChange={(e) => setTest({ ...test, resultType: e.target.value as LabResultType })}
                  >
                    {LAB_RESULT_TYPES.map((x) => (
                      <option key={x} value={x}>
                        {t(`lab.resultTypes.${x}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('lab.defaultUnit')}>
                  <Select
                    value={test.defaultUnit}
                    onChange={(e) => setTest({ ...test, defaultUnit: e.target.value })}
                  >
                    <option value="">{t('lab.noUnit')}</option>
                    {(units.data ?? []).map((u) => (
                      <option key={u.code} value={u.code}>
                        {u.code} — {localize(u.name, i18n.language)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div>
                <Button
                  loading={createTest.isPending}
                  disabled={!test.code.trim() || !test.en.trim()}
                  onClick={() => createTest.mutate()}
                >
                  {t('lab.newTest')}
                </Button>
              </div>
            </div>
          )}

          <Input
            placeholder={t('lab.searchTests')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBlockEnd: 'var(--gsi-space-3)' }}
          />

          {tests.isLoading ? (
            <Loading />
          ) : !rows.length ? (
            <EmptyState>{t('lab.noTests')}</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t('lab.code')}</th>
                  <th>{t('lab.name')}</th>
                  <th>{t('lab.resultType')}</th>
                  <th>{t('sample.unit')}</th>
                  <th>{t('lab.methods')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr
                    key={x.id}
                    className={`link-row${x.id === selected ? ' row--selected' : ''}${x.isActive ? '' : ' is-muted-row'}`}
                    onClick={() => setSelected(x.id)}
                  >
                    <td className="mono">{x.code}</td>
                    <td>{localize(x.name, i18n.language)}</td>
                    <td>{t(`lab.resultTypes.${x.resultType}`)}</td>
                    <td>{x.defaultUnit ?? '—'}</td>
                    <td className="num">{x.methodCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title={current ? t('lab.methodsFor', { name: localize(current.name, i18n.language) }) : t('lab.methods')}
          actions={
            manage && selected ? (
              <Button variant={addingMethod ? 'ghost' : 'secondary'} onClick={() => setAddingMethod((v) => !v)}>
                {addingMethod ? t('common.cancel') : `+ ${t('lab.newMethod')}`}
              </Button>
            ) : null
          }
        >
          {!selected ? (
            <EmptyState>{t('lab.pickTest')}</EmptyState>
          ) : (
            <>
              {addingMethod && (
                <div className="stack" style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
                  <div className="form-grid">
                    <Field label={t('lab.code')}>
                      <Input value={method.code} onChange={(e) => setMethod({ ...method, code: e.target.value })} />
                    </Field>
                    <Field label={t('lab.name')}>
                      <Input value={method.name} onChange={(e) => setMethod({ ...method, name: e.target.value })} />
                    </Field>
                    <Field label={t('lab.standard')}>
                      <Input
                        value={method.standardReference}
                        onChange={(e) => setMethod({ ...method, standardReference: e.target.value })}
                      />
                    </Field>
                    <Field label={t('lab.defaultUnit')}>
                      <Select
                        value={method.defaultUnit}
                        onChange={(e) => setMethod({ ...method, defaultUnit: e.target.value })}
                      >
                        <option value="">{t('lab.noUnit')}</option>
                        {(units.data ?? []).map((u) => (
                          <option key={u.code} value={u.code}>
                            {u.code}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('lab.detectionLimitShort')}>
                      <Input
                        inputMode="decimal"
                        value={method.detectionLimit}
                        onChange={(e) => setMethod({ ...method, detectionLimit: e.target.value })}
                      />
                    </Field>
                    <Field label={t('lab.quantificationLimit')}>
                      <Input
                        inputMode="decimal"
                        value={method.quantificationLimit}
                        onChange={(e) => setMethod({ ...method, quantificationLimit: e.target.value })}
                      />
                    </Field>
                    <Field label={t('lab.accreditation')}>
                      <Input
                        value={method.accreditationScope}
                        onChange={(e) => setMethod({ ...method, accreditationScope: e.target.value })}
                      />
                    </Field>
                    <div className="form-grid__wide">
                      <Field label={t('lab.description')}>
                        <TextArea
                          rows={2}
                          value={method.description}
                          onChange={(e) => setMethod({ ...method, description: e.target.value })}
                        />
                      </Field>
                    </div>
                  </div>
                  <div>
                    <Button
                      loading={createMethod.isPending}
                      disabled={!method.code.trim() || !method.name.trim()}
                      onClick={() => createMethod.mutate()}
                    >
                      {t('lab.newMethod')}
                    </Button>
                  </div>
                </div>
              )}

              {methods.isLoading ? (
                <Loading />
              ) : !methods.data?.length ? (
                <EmptyState>{t('lab.noMethods')}</EmptyState>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('lab.code')}</th>
                      <th>{t('lab.name')}</th>
                      <th>{t('lab.standard')}</th>
                      <th>{t('lab.version')}</th>
                      <th>{t('lab.accreditation')}</th>
                      <th>{t('lab.effectiveFrom')}</th>
                      {manage ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {methods.data.map((m) => (
                      <tr key={m.id} className={m.isActive ? '' : 'is-muted-row'}>
                        <td className="mono">{m.code}</td>
                        <td>{m.name}</td>
                        <td>{m.standardReference ?? '—'}</td>
                        <td>
                          <Badge tone="info">v{m.version}</Badge>
                        </td>
                        <td>{m.accreditationScope ?? '—'}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmt(m.effectiveFrom, false)}</td>
                        {manage ? (
                          <td>
                            <Button variant="ghost" size="sm" onClick={() => retire.mutate(m)}>
                              {m.isActive ? t('lab.retire') : t('lab.restore')}
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <p className="muted">{t('lab.versionNotice')}</p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

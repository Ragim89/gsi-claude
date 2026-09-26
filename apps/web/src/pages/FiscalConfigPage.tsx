import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import type { LegalEntity } from '@gsi/shared-types';
import { api, blanksToNull } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, PageHead } from '../components/common';

interface Country {
  id: string;
  code: string;
  name: string;
}

interface JurisdictionCountry {
  code: string;
  name: string;
  hasVerifiedProfile: boolean;
  latestVersion: number | null;
}

const EMPTY_ENTITY = {
  countryId: '',
  code: '',
  legalName: '',
  legalAddress: '',
  fiscalIdentifierType: '',
  fiscalIdentifier: '',
  vatRegistered: 'no',
  vatRegistrationNumber: '',
  defaultTaxCode: '',
  defaultCurrency: '',
  bankName: '',
  bankAccount: '',
  bankSwift: '',
  invoiceNumberPrefix: '',
};

const EMPTY_PROFILE = {
  countryCode: '',
  effectiveFrom: '',
  defaultDocumentCurrency: '',
  sourceNotes: '',
  configJson: '',
};

/**
 * Finance / Fiscal Configuration (migration 028_fiscal_compliance.sql, task section 12).
 *
 * Two independent things live here, deliberately not merged into one form:
 *  - Legal entities: the fiscal identity an office trades under. Fully editable — a company's
 *    VAT registration or bank details do change, and past invoices already snapshotted their
 *    own copy at issue time (see docs/FISCAL_COMPLIANCE.md), so editing here never rewrites one.
 *  - Jurisdiction profiles: versioned tax rules per country, read-only once written (the API has
 *    no UPDATE route for them at all — a law change is always a brand-new version below).
 */
export function FiscalConfigPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canManageEntities = can('legal_entity.manage');
  const canManageProfiles = can('fiscal_profile.manage');

  const [addingEntity, setAddingEntity] = useState(false);
  const [editingEntityId, setEditingEntityId] = useState<string | null>(null);
  const [entityForm, setEntityForm] = useState(EMPTY_ENTITY);
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState(EMPTY_PROFILE);

  const countries = useQuery({ queryKey: ['org', 'countries'], queryFn: () => api.get<Country[]>('/org/countries') });
  const entities = useQuery({
    queryKey: ['fiscal', 'legal-entities'],
    queryFn: () => api.get<LegalEntity[]>('/admin/fiscal/legal-entities?includeInactive=true'),
  });
  const jurisdictionCountries = useQuery({
    queryKey: ['fiscal', 'jurisdiction-countries'],
    queryFn: () => api.get<JurisdictionCountry[]>('/admin/fiscal/jurisdiction-countries'),
  });

  const refreshEntities = () => qc.invalidateQueries({ queryKey: ['fiscal', 'legal-entities'] });
  const refreshProfiles = () => qc.invalidateQueries({ queryKey: ['fiscal'] });

  const entityPayload = () =>
    blanksToNull({
      countryId: entityForm.countryId,
      code: entityForm.code.trim(),
      legalName: entityForm.legalName.trim(),
      legalAddress: entityForm.legalAddress,
      fiscalIdentifierType: entityForm.fiscalIdentifierType,
      fiscalIdentifier: entityForm.fiscalIdentifier,
      vatRegistered: entityForm.vatRegistered === 'yes',
      vatRegistrationNumber: entityForm.vatRegistrationNumber,
      defaultTaxCode: entityForm.defaultTaxCode,
      defaultCurrency: entityForm.defaultCurrency.trim().toUpperCase(),
      bankName: entityForm.bankName,
      bankAccount: entityForm.bankAccount,
      bankSwift: entityForm.bankSwift,
      invoiceNumberPrefix: entityForm.invoiceNumberPrefix,
    });

  const createEntity = useMutation({
    mutationFn: () => api.post<LegalEntity>('/admin/fiscal/legal-entities', entityPayload()),
    onSuccess: () => {
      setAddingEntity(false);
      setEntityForm(EMPTY_ENTITY);
      refreshEntities();
    },
  });

  const updateEntity = useMutation({
    mutationFn: (id: string) => api.patch<LegalEntity>(`/admin/fiscal/legal-entities/${id}`, entityPayload()),
    onSuccess: () => {
      setEditingEntityId(null);
      setEntityForm(EMPTY_ENTITY);
      refreshEntities();
    },
  });

  const setEntityActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch<LegalEntity>(`/admin/fiscal/legal-entities/${id}`, { isActive }),
    onSuccess: refreshEntities,
  });

  const createProfileVersion = useMutation({
    mutationFn: () => {
      let config: unknown;
      try {
        config = JSON.parse(profileForm.configJson);
      } catch {
        throw new Error(t('fiscal.profiles.invalidJson'));
      }
      return api.post('/admin/fiscal/jurisdiction-profiles', {
        countryCode: profileForm.countryCode.trim().toUpperCase(),
        effectiveFrom: profileForm.effectiveFrom,
        defaultDocumentCurrency: profileForm.defaultDocumentCurrency.trim().toUpperCase(),
        sourceNotes: profileForm.sourceNotes || null,
        config,
      });
    },
    onSuccess: () => {
      setAddingProfile(false);
      setProfileForm(EMPTY_PROFILE);
      refreshProfiles();
    },
  });

  function startEdit(le: LegalEntity) {
    setEditingEntityId(le.id);
    setAddingEntity(false);
    setEntityForm({
      countryId: le.countryId,
      code: le.code,
      legalName: le.legalName,
      legalAddress: le.legalAddress ?? '',
      fiscalIdentifierType: le.fiscalIdentifierType ?? '',
      fiscalIdentifier: le.fiscalIdentifier ?? '',
      vatRegistered: le.vatRegistered ? 'yes' : 'no',
      vatRegistrationNumber: le.vatRegistrationNumber ?? '',
      defaultTaxCode: le.defaultTaxCode ?? '',
      defaultCurrency: le.defaultCurrency,
      bankName: le.bankName ?? '',
      bankAccount: le.bankAccount ?? '',
      bankSwift: le.bankSwift ?? '',
      invoiceNumberPrefix: le.invoiceNumberPrefix ?? '',
    });
  }

  const set = (k: keyof typeof entityForm) => (e: { target: { value: string } }) =>
    setEntityForm({ ...entityForm, [k]: e.target.value });
  const setP = (k: keyof typeof profileForm) => (e: { target: { value: string } }) =>
    setProfileForm({ ...profileForm, [k]: e.target.value });

  const entityRows = entities.data ?? [];
  const countryRows = countries.data ?? [];
  const jurisdictionRows = jurisdictionCountries.data ?? [];
  const editing = editingEntityId !== null;

  return (
    <div className="stack">
      <PageHead title={t('fiscal.title')} sub={t('fiscal.sub')} />

      <Card title={t('fiscal.entities.title')}>
        <ErrorBox error={entities.error ?? createEntity.error ?? updateEntity.error ?? setEntityActive.error} />
        <p className="muted">{t('fiscal.entities.hint')}</p>

        {canManageEntities && (
          <div style={{ marginBlockEnd: 'var(--gsi-space-3)' }}>
            <Button
              variant={addingEntity || editing ? 'ghost' : 'primary'}
              onClick={() => {
                if (addingEntity || editing) {
                  setAddingEntity(false);
                  setEditingEntityId(null);
                  setEntityForm(EMPTY_ENTITY);
                } else {
                  setAddingEntity(true);
                }
              }}
            >
              {addingEntity || editing ? t('common.cancel') : `+ ${t('fiscal.entities.new')}`}
            </Button>
          </div>
        )}

        {(addingEntity || editing) && (
          <Card title={editing ? t('fiscal.entities.edit') : t('fiscal.entities.new')}>
            <div className="form-grid">
              <Field label={t('fiscal.entities.country')}>
                <Select value={entityForm.countryId} onChange={set('countryId')} disabled={editing}>
                  <option value="">—</option>
                  {countryRows.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fiscal.entities.code')} hint={t('fiscal.entities.codeHint')}>
                <Input value={entityForm.code} onChange={set('code')} disabled={editing} />
              </Field>
              <Field label={t('fiscal.entities.legalName')}>
                <Input value={entityForm.legalName} onChange={set('legalName')} />
              </Field>
              <Field label={t('fiscal.entities.legalAddress')}>
                <Input value={entityForm.legalAddress} onChange={set('legalAddress')} />
              </Field>
              <Field label={t('fiscal.entities.fiscalIdType')} hint={t('fiscal.entities.fiscalIdTypeHint')}>
                <Input value={entityForm.fiscalIdentifierType} onChange={set('fiscalIdentifierType')} placeholder="BIN" />
              </Field>
              <Field label={t('fiscal.entities.fiscalId')}>
                <Input value={entityForm.fiscalIdentifier} onChange={set('fiscalIdentifier')} />
              </Field>
              <Field label={t('fiscal.entities.vatRegistered')}>
                <Select value={entityForm.vatRegistered} onChange={set('vatRegistered')}>
                  <option value="no">{t('common.no')}</option>
                  <option value="yes">{t('common.yes')}</option>
                </Select>
              </Field>
              <Field label={t('fiscal.entities.vatRegNumber')}>
                <Input value={entityForm.vatRegistrationNumber} onChange={set('vatRegistrationNumber')} />
              </Field>
              <Field label={t('fiscal.entities.defaultTaxCode')} hint={t('fiscal.entities.defaultTaxCodeHint')}>
                <Input value={entityForm.defaultTaxCode} onChange={set('defaultTaxCode')} placeholder="STANDARD" />
              </Field>
              <Field label={t('fiscal.entities.defaultCurrency')} hint={t('fiscal.entities.defaultCurrencyHint')}>
                <Input value={entityForm.defaultCurrency} onChange={set('defaultCurrency')} maxLength={3} placeholder="KZT" />
              </Field>
              <Field label={t('fiscal.entities.bankName')}>
                <Input value={entityForm.bankName} onChange={set('bankName')} />
              </Field>
              <Field label={t('fiscal.entities.bankAccount')}>
                <Input value={entityForm.bankAccount} onChange={set('bankAccount')} />
              </Field>
              <Field label={t('fiscal.entities.bankSwift')}>
                <Input value={entityForm.bankSwift} onChange={set('bankSwift')} />
              </Field>
              <Field label={t('fiscal.entities.numberingPrefix')}>
                <Input value={entityForm.invoiceNumberPrefix} onChange={set('invoiceNumberPrefix')} />
              </Field>
            </div>
            <div style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
              <Button
                disabled={!entityForm.countryId || !entityForm.code.trim() || !entityForm.legalName.trim()}
                loading={createEntity.isPending || updateEntity.isPending}
                onClick={() => (editing ? updateEntity.mutate(editingEntityId!) : createEntity.mutate())}
              >
                {editing ? t('common.save') : t('common.create')}
              </Button>
            </div>
          </Card>
        )}

        {entities.isLoading ? (
          <Loading />
        ) : !entityRows.length ? (
          <EmptyState>{t('fiscal.entities.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('fiscal.entities.code')}</th>
                <th>{t('fiscal.entities.legalName')}</th>
                <th>{t('fiscal.entities.country')}</th>
                <th>{t('fiscal.entities.vatRegistered')}</th>
                <th>{t('fiscal.entities.defaultCurrency')}</th>
                <th>{t('fiscal.profiles.status')}</th>
                <th>{t('jobs.status')}</th>
                {canManageEntities && <th style={{ width: 160 }} />}
              </tr>
            </thead>
            <tbody>
              {entityRows.map((le) => (
                <tr key={le.id} className={le.isActive ? undefined : 'is-muted-row'}>
                  <td className="mono">{le.code}</td>
                  <td>{le.legalName}</td>
                  <td>{le.countryCode}</td>
                  <td>
                    <Badge tone={le.vatRegistered ? 'info' : 'neutral'}>
                      {t(le.vatRegistered ? 'common.yes' : 'common.no')}
                    </Badge>
                  </td>
                  <td className="mono">{le.defaultCurrency}</td>
                  <td>
                    <Badge tone={le.hasVerifiedProfile ? 'success' : 'warning'}>
                      {t(le.hasVerifiedProfile ? 'fiscal.profiles.verified' : 'fiscal.profiles.configRequired')}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={le.isActive ? 'success' : 'neutral'}>
                      {t(le.isActive ? 'laboratories.active' : 'laboratories.closed')}
                    </Badge>
                  </td>
                  {canManageEntities && (
                    <td style={{ display: 'flex', gap: 6 }}>
                      <Button size="sm" variant="ghost" onClick={() => startEdit(le)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={setEntityActive.isPending}
                        onClick={() => setEntityActive.mutate({ id: le.id, isActive: !le.isActive })}
                      >
                        {t(le.isActive ? 'laboratories.close' : 'laboratories.reopen')}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={t('fiscal.profiles.title')}>
        <ErrorBox error={jurisdictionCountries.error ?? createProfileVersion.error} />
        <p className="muted">{t('fiscal.profiles.hint')}</p>

        {jurisdictionCountries.isLoading ? (
          <Loading />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('fiscal.entities.country')}</th>
                <th>{t('fiscal.profiles.status')}</th>
                <th>{t('fiscal.profiles.version')}</th>
              </tr>
            </thead>
            <tbody>
              {jurisdictionRows.map((c) => (
                <tr key={c.code}>
                  <td>{c.name} <span className="mono muted">({c.code})</span></td>
                  <td>
                    <Badge tone={c.hasVerifiedProfile ? 'success' : 'warning'}>
                      {t(c.hasVerifiedProfile ? 'fiscal.profiles.verified' : 'fiscal.profiles.configRequired')}
                    </Badge>
                  </td>
                  <td>{c.latestVersion ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {canManageProfiles && (
          <>
            <div style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
              <Button variant={addingProfile ? 'ghost' : 'secondary'} onClick={() => setAddingProfile((v) => !v)}>
                {addingProfile ? t('common.cancel') : `+ ${t('fiscal.profiles.newVersion')}`}
              </Button>
            </div>
            {addingProfile && (
              <Card title={t('fiscal.profiles.newVersion')}>
                <p className="muted">{t('fiscal.profiles.newVersionHint')}</p>
                <div className="form-grid">
                  <Field label={t('fiscal.entities.country')} hint={t('fiscal.profiles.countryCodeHint')}>
                    <Input value={profileForm.countryCode} onChange={setP('countryCode')} maxLength={2} placeholder="KZ" />
                  </Field>
                  <Field label={t('fiscal.profiles.effectiveFrom')}>
                    <Input type="date" value={profileForm.effectiveFrom} onChange={setP('effectiveFrom')} />
                  </Field>
                  <Field label={t('fiscal.entities.defaultCurrency')}>
                    <Input value={profileForm.defaultDocumentCurrency} onChange={setP('defaultDocumentCurrency')} maxLength={3} />
                  </Field>
                  <div className="form-grid__wide">
                    <Field label={t('fiscal.profiles.sourceNotes')}>
                      <TextArea rows={2} value={profileForm.sourceNotes} onChange={setP('sourceNotes')} />
                    </Field>
                  </div>
                  <div className="form-grid__wide">
                    <Field label={t('fiscal.profiles.configJson')} hint={t('fiscal.profiles.configJsonHint')}>
                      <TextArea rows={10} value={profileForm.configJson} onChange={setP('configJson')} className="mono" />
                    </Field>
                  </div>
                </div>
                <div style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
                  <Button
                    disabled={!profileForm.countryCode.trim() || !profileForm.effectiveFrom || !profileForm.defaultDocumentCurrency.trim() || !profileForm.configJson.trim()}
                    loading={createProfileVersion.isPending}
                    onClick={() => createProfileVersion.mutate()}
                  >
                    {t('common.create')}
                  </Button>
                </div>
              </Card>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

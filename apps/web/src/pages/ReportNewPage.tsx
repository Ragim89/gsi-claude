import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Field, Input, Select, Table, TextArea } from '@gsi/ui-kit/react';
import {
  InspectionJob,
  Page,
  REPORT_TYPES,
  ReportDocument,
  ReportSources,
  ReportTemplate,
  ReportType,
  localize,
} from '@gsi/shared-types';
import { api } from '../api';
import { ErrorBox, Loading, PageHead } from '../components/common';

/**
 * Starting a document: what kind, in which language, about which job, and from which of its
 * material. Deliberately not a page designer — the layout belongs to the template, and what a
 * person adds here is the part only a person can write.
 */
export function ReportNewPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [jobId, setJobId] = useState(params.get('jobId') ?? '');
  const [reportType, setReportType] = useState<ReportType>('certificate_of_analysis');
  const [language, setLanguage] = useState(i18n.language === 'tr' || i18n.language === 'ru' ? i18n.language : 'en');
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [jobSearch, setJobSearch] = useState('');

  const jobs = useQuery({
    queryKey: ['jobs', 'report-picker', jobSearch],
    queryFn: () =>
      api.get<Page<InspectionJob>>(`/jobs?limit=20${jobSearch.trim() ? `&search=${encodeURIComponent(jobSearch.trim())}` : ''}`),
  });
  const templates = useQuery({
    queryKey: ['report-templates', reportType],
    queryFn: () => api.get<ReportTemplate[]>(`/report-templates?reportType=${reportType}`),
  });
  const sources = useQuery({
    queryKey: ['report-sources-job', jobId],
    queryFn: () => api.get<ReportSources>(`/reports/sources/${jobId}`),
    enabled: Boolean(jobId),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<ReportDocument>('/reports', {
        jobId,
        reportType,
        language,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(templateId ? { templateId } : {}),
        ...(summary.trim() ? { content: { executiveSummary: summary.trim() } } : {}),
      }),
    onSuccess: (doc) => navigate(`/reports/${doc.id}?tab=content`),
  });

  const job = jobs.data?.rows.find((j) => j.id === jobId);

  return (
    <div className="stack">
      <PageHead title={t('reports.new')} sub={t('reports.newSub')} />
      <ErrorBox error={create.error} />

      <Card title={t('reports.step1')}>
        <div className="form-grid">
          <Field label={t('reports.type')}>
            <Select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
              {REPORT_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`reportType.${x}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('reports.language')} hint={t('reports.languageHint')}>
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="tr">Türkçe</option>
              <option value="ru">Русский</option>
            </Select>
          </Field>
          <Field label={t('reports.template')}>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{t('reports.templateDefault')}</option>
              {(templates.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} (v{x.version})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('reports.title')} hint={t('reports.titleHint')}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title={t('reports.step2')}>
        <div className="filter-row" style={{ marginBlockEnd: 'var(--gsi-space-3)' }}>
          <Input
            placeholder={t('jobs.search')}
            value={jobSearch}
            onChange={(e) => setJobSearch(e.target.value)}
          />
        </div>
        {jobs.isLoading ? (
          <Loading />
        ) : !jobs.data?.rows.length ? (
          <EmptyState>{t('jobs.empty')}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th />
                <th>{t('jobs.number')}</th>
                <th>{t('jobs.client')}</th>
                <th>{t('jobs.type')}</th>
                <th>{t('jobs.location')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.rows.map((j) => (
                <tr
                  key={j.id}
                  className={`link-row${j.id === jobId ? ' row--selected' : ''}`}
                  onClick={() => setJobId(j.id)}
                >
                  <td>{j.id === jobId ? '✓' : ''}</td>
                  <td className="mono">{j.jobNumber}</td>
                  <td>{j.clientName}</td>
                  <td>{j.type}</td>
                  <td>{j.location}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {jobId && (
        <Card title={t('reports.step3')}>
          {sources.isLoading ? (
            <Loading />
          ) : !sources.data ? (
            <ErrorBox error={sources.error} />
          ) : (
            <div className="stack">
              <p className="muted">
                {t('reports.sourcesSummary', {
                  inspections: sources.data.inspections.length,
                  samples: sources.data.samples.length,
                  results: sources.data.results.length,
                  photos: sources.data.photos.length,
                })}
              </p>
              {sources.data.results.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <th>{t('samples.number')}</th>
                      <th>{t('lab.test')}</th>
                      <th>{t('lab.value')}</th>
                      <th>{t('lab.specification')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.data.results.map((x) => (
                      <tr key={x.resultId}>
                        <td className="mono">{x.sampleNumber}</td>
                        <td>{localize(x.testName, i18n.language)}</td>
                        <td className="mono">
                          <strong>{x.value}</strong> {x.unit ?? ''}
                        </td>
                        <td className="mono">{x.specification ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {(reportType === 'certificate_of_analysis' || reportType === 'laboratory_report') &&
                !sources.data.results.length && <EmptyState>{t('reports.noReleasedResults')}</EmptyState>}
            </div>
          )}
        </Card>
      )}

      <Card title={t('reports.step4')}>
        <Field label={t('reports.executiveSummary')} hint={t('reports.narrativeHint')}>
          <TextArea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <div className="row-actions" style={{ marginBlockStart: 'var(--gsi-space-3)' }}>
          <Button loading={create.isPending} disabled={!jobId} onClick={() => create.mutate()}>
            {t('reports.create')}
          </Button>
          <span className="muted">{job ? `${job.jobNumber} · ${job.clientName}` : t('reports.pickJob')}</span>
        </div>
      </Card>
    </div>
  );
}

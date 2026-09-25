import type { ClientBase } from 'pg';
import { DEFAULT_SECTIONS } from '../documents/templates/document';
import type { ReportType } from '@gsi/shared-types';

/**
 * The forms the group prints on.
 *
 * These are reference data rather than demo data: a document type with no template cannot be
 * issued at all, so an installation with an empty `report_templates` table would have a create
 * button that leads nowhere. They are group-wide (no branch), and an office that prints its own
 * form adds a row for itself — which then wins, without anything here changing.
 *
 * Idempotent: a template already present is left exactly as it is, because its version may
 * already be printed on issued documents.
 */
const TEMPLATES: Array<{
  code: string;
  name: string;
  reportType: ReportType;
  description: string;
  statement?: { en: string; tr: string; ru: string };
}> = [
  {
    code: 'inspection-standard',
    name: 'Inspection report — standard',
    reportType: 'inspection_report',
    description: 'Letterhead, client, assignment, inspection, checklist, findings, measurements, photographs.',
  },
  {
    code: 'survey-standard',
    name: 'Survey report — standard',
    reportType: 'survey_report',
    description: 'Draught survey and similar work: measurements and conclusion, without the full checklist.',
  },
  {
    code: 'laboratory-standard',
    name: 'Laboratory report — standard',
    reportType: 'laboratory_report',
    description: 'Samples and released analyses with their methods and limits.',
  },
  {
    code: 'coa-standard',
    name: 'Certificate of analysis — standard',
    reportType: 'certificate_of_analysis',
    description: 'The analytical certificate: sample identity, released results, methods, limits, approval, QR.',
    statement: {
      en: 'The results relate only to the sample examined, as received by the laboratory. This certificate may not be reproduced except in full without the written approval of the issuer.',
      tr: 'Sonuçlar yalnızca laboratuvara ulaştığı hâliyle incelenen numuneye aittir. Bu sertifika, düzenleyenin yazılı izni olmadan kısmen çoğaltılamaz.',
      ru: 'Результаты относятся только к исследованной пробе в том виде, в каком она поступила в лабораторию. Сертификат не может воспроизводиться в неполном виде без письменного согласия выдавшего лица.',
    },
  },
  {
    code: 'certificate-standard',
    name: 'Certificate — standard',
    reportType: 'certificate',
    description: 'A short certificate: identification, statement, approval, QR.',
  },
  {
    code: 'sampling-standard',
    name: 'Sampling report — standard',
    reportType: 'sampling_report',
    description: 'What was sampled, how, by whom, under which seal, and where it went.',
  },
  {
    code: 'custom-blank',
    name: 'Custom report',
    reportType: 'custom',
    description: 'Letterhead and narrative for work that does not fit the standard forms.',
  },
];

export async function seedReportTemplates(client: ClientBase): Promise<void> {
  for (const t of TEMPLATES) {
    await client.query(
      `INSERT INTO report_templates (code, name, report_type, definition, description)
       SELECT $1, $2, $3::report_kind, $4::jsonb, $5
       WHERE NOT EXISTS (SELECT 1 FROM report_templates x WHERE x.code = $1)`,
      [
        t.code,
        t.name,
        t.reportType,
        JSON.stringify({
          sections: DEFAULT_SECTIONS[t.reportType],
          ...(t.statement ? { statement: t.statement } : {}),
        }),
        t.description,
      ],
    );
  }
}

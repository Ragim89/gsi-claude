import {
  ReportContent,
  ReportDataSnapshot,
  ReportSectionSpec,
  ReportTemplateDefinition,
  ReportType,
  localize,
} from '@gsi/shared-types';
import { toCssVariables } from '@gsi/ui-kit';
import { logoDataUri } from './brand';

/**
 * One renderer for every document type.
 *
 * A template is a list of sections and their options, so a certificate of analysis and an
 * inspection report are the same code reading different data. Seven document types do not mean
 * seven React components with the same table copied into each of them; they mean seven rows in
 * `report_templates`.
 *
 * Everything printed here comes from the frozen snapshot. The renderer cannot reach the
 * database even if it wanted to — which is what makes an issued document reproducible years
 * later, after the client was renamed and the method revised.
 */

export interface RenderInput {
  definition: ReportTemplateDefinition;
  snapshot: ReportDataSnapshot;
  content: ReportContent;
  language: string;
  document: {
    reportNumber: string;
    reportType: ReportType;
    title: string | null;
    version: number;
    issuedAt: Date | null;
    verifyUrl: string | null;
    qrDataUrl: string | null;
    /** A preview carries the watermark and no QR: it is not a document yet. */
    draft: boolean;
  };
  /** Photo id → data URI, prepared by the caller (the renderer never touches storage). */
  images: Map<string, string>;
}

type Lang = 'en' | 'tr' | 'ru';

const L = (lang: string): Lang => (['en', 'tr', 'ru'].includes(lang) ? (lang as Lang) : 'en');

/** Wording for everything the renderer prints itself. Document language, never UI language. */
const T: Record<string, Record<Lang, string>> = {
  inspection_report: { en: 'INSPECTION REPORT', tr: 'MUAYENE RAPORU', ru: 'АКТ ИНСПЕКЦИИ' },
  survey_report: { en: 'SURVEY REPORT', tr: 'SÖRVEY RAPORU', ru: 'СЮРВЕЙЕРСКИЙ ОТЧЁТ' },
  laboratory_report: { en: 'LABORATORY REPORT', tr: 'LABORATUVAR RAPORU', ru: 'ПРОТОКОЛ ИСПЫТАНИЙ' },
  certificate_of_analysis: { en: 'CERTIFICATE OF ANALYSIS', tr: 'ANALİZ SERTİFİKASI', ru: 'СЕРТИФИКАТ АНАЛИЗА' },
  certificate: { en: 'CERTIFICATE', tr: 'SERTİFİKA', ru: 'СЕРТИФИКАТ' },
  sampling_report: { en: 'SAMPLING REPORT', tr: 'NUMUNE ALMA RAPORU', ru: 'АКТ ОТБОРА ПРОБ' },
  custom: { en: 'REPORT', tr: 'RAPOR', ru: 'ОТЧЁТ' },

  documentNo: { en: 'Document No', tr: 'Belge No', ru: '№ документа' },
  revision: { en: 'Revision', tr: 'Revizyon', ru: 'Редакция' },
  issueDate: { en: 'Date of Issue', tr: 'Düzenleme Tarihi', ru: 'Дата выдачи' },
  jobNo: { en: 'Job No', tr: 'İş No', ru: '№ заявки' },
  client: { en: 'Client', tr: 'Müşteri', ru: 'Заказчик' },
  clientRef: { en: 'Client Reference', tr: 'Müşteri Referansı', ru: 'Ссылка заказчика' },
  gafta: { en: 'GAFTA / FOSFA Ref.', tr: 'GAFTA / FOSFA Ref.', ru: 'GAFTA / FOSFA' },
  address: { en: 'Address', tr: 'Adres', ru: 'Адрес' },
  job: { en: 'Assignment', tr: 'İş', ru: 'Заявка' },
  service: { en: 'Service', tr: 'Hizmet', ru: 'Услуга' },
  place: { en: 'Place', tr: 'Yer', ru: 'Место' },
  object: { en: 'Vessel / Object', tr: 'Gemi / Obje', ru: 'Судно / объект' },
  commodity: { en: 'Commodity', tr: 'Ürün', ru: 'Груз' },
  quantity: { en: 'Quantity', tr: 'Miktar', ru: 'Количество' },
  inspection: { en: 'Inspection', tr: 'Muayene', ru: 'Инспекция' },
  inspectionNo: { en: 'Inspection No', tr: 'Muayene No', ru: '№ инспекции' },
  period: { en: 'Period', tr: 'Dönem', ru: 'Период' },
  inspectors: { en: 'Surveyors', tr: 'Eksperler', ru: 'Инспекторы' },
  conditions: { en: 'Conditions', tr: 'Koşullar', ru: 'Условия' },
  checklist: { en: 'Inspection Findings', tr: 'Muayene Bulguları', ru: 'Результаты осмотра' },
  checkPoint: { en: 'Check Point', tr: 'Kontrol Noktası', ru: 'Пункт проверки' },
  result: { en: 'Result', tr: 'Sonuç', ru: 'Результат' },
  reading: { en: 'Value', tr: 'Değer', ru: 'Значение' },
  remarks: { en: 'Remarks', tr: 'Açıklama', ru: 'Примечание' },
  findings: { en: 'Observations Raised', tr: 'Tespitler', ru: 'Замечания' },
  severity: { en: 'Severity', tr: 'Önem', ru: 'Значимость' },
  description: { en: 'Description', tr: 'Açıklama', ru: 'Описание' },
  recommendation: { en: 'Recommendation', tr: 'Öneri', ru: 'Рекомендация' },
  measurements: { en: 'Measurements', tr: 'Ölçümler', ru: 'Измерения' },
  type: { en: 'Type', tr: 'Tip', ru: 'Тип' },
  unit: { en: 'Unit', tr: 'Birim', ru: 'Ед.' },
  location: { en: 'Location', tr: 'Konum', ru: 'Место' },
  samples: { en: 'Samples', tr: 'Numuneler', ru: 'Пробы' },
  sampleNo: { en: 'Sample No', tr: 'Numune No', ru: '№ пробы' },
  seal: { en: 'Seal', tr: 'Mühür', ru: 'Пломба' },
  sampledAt: { en: 'Sampled', tr: 'Alınma', ru: 'Отобрана' },
  sampledBy: { en: 'Sampled by', tr: 'Numuneyi alan', ru: 'Отобрал' },
  method: { en: 'Method', tr: 'Metot', ru: 'Методика' },
  laboratory: { en: 'Laboratory', tr: 'Laboratuvar', ru: 'Лаборатория' },
  custody: { en: 'Chain of custody', tr: 'Zincir kaydı', ru: 'Цепочка хранения' },
  results: { en: 'Test Results', tr: 'Analiz Sonuçları', ru: 'Результаты испытаний' },
  test: { en: 'Test', tr: 'Analiz', ru: 'Показатель' },
  specification: { en: 'Specification', tr: 'Spesifikasyon', ru: 'Норма' },
  observations: { en: 'Observations', tr: 'Gözlemler', ru: 'Наблюдения' },
  summary: { en: 'Executive Summary', tr: 'Yönetici Özeti', ru: 'Краткое заключение' },
  conclusion: { en: 'Conclusion', tr: 'Sonuç', ru: 'Заключение' },
  recommendations: { en: 'Recommendations', tr: 'Öneriler', ru: 'Рекомендации' },
  photos: { en: 'Photographic Evidence', tr: 'Fotoğraf Kayıtları', ru: 'Фотоматериалы' },
  prepared: { en: 'Prepared by', tr: 'Hazırlayan', ru: 'Подготовил' },
  reviewed: { en: 'Reviewed by', tr: 'Kontrol eden', ru: 'Проверил' },
  approved: { en: 'Approved by', tr: 'Onaylayan', ru: 'Утвердил' },
  issued: { en: 'Issued by', tr: 'Düzenleyen', ru: 'Выдал' },
  signature: { en: 'Signature / Stamp', tr: 'İmza / Kaşe', ru: 'Подпись / печать' },
  verify: { en: 'Verification', tr: 'Doğrulama', ru: 'Проверка подлинности' },
  verifyText: {
    en: 'Scan the QR code to verify the authenticity of this document.',
    tr: 'Bu belgenin gerçekliğini QR kodu okutarak doğrulayabilirsiniz.',
    ru: 'Отсканируйте QR-код, чтобы проверить подлинность документа.',
  },
  statement: { en: 'Statement', tr: 'Beyan', ru: 'Заявление' },
  defaultStatement: {
    en: 'This document reflects only the conditions observed and the material examined at the time and place stated. It may not be reproduced except in full without the written approval of the issuer.',
    tr: 'Bu belge yalnızca belirtilen yer ve zamanda gözlemlenen koşulları ve incelenen malzemeyi yansıtır. Düzenleyenin yazılı izni olmadan kısmen çoğaltılamaz.',
    ru: 'Документ отражает только состояние и материал, наблюдавшиеся в указанном месте и в указанное время. Воспроизведение в неполном виде без письменного согласия выдавшего лица не допускается.',
  },
  draft: { en: 'DRAFT', tr: 'TASLAK', ru: 'ЧЕРНОВИК' },
  page: { en: 'Page', tr: 'Sayfa', ru: 'Стр.' },
  of: { en: 'of', tr: '/', ru: 'из' },
  assessment: { en: 'Assessment', tr: 'Değerlendirme', ru: 'Оценка' },
  outOfSpec: { en: 'Out of specification', tr: 'Spesifikasyon dışı', ru: 'Вне нормы' },
  withinSpec: { en: 'Within specification', tr: 'Uygun', ru: 'В пределах нормы' },
  noLimit: { en: 'No limit set', tr: 'Limit yok', ru: 'Норма не задана' },
  none: { en: 'None recorded', tr: 'Kayıt yok', ru: 'Не зафиксировано' },
};

const t = (key: string, lang: Lang): string => T[key]?.[lang] ?? key;

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Paragraphs a person wrote: newlines are meaningful, everything else is escaped. */
function prose(v: string | null | undefined): string {
  if (!v || !v.trim()) return '';
  return v
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function fmtDate(d: string | Date | null | undefined, tz: string, lang: Lang, withTime = true): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const locale = lang === 'tr' ? 'tr-TR' : lang === 'ru' ? 'ru-RU' : 'en-GB';
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(date);
}

function infoRow(label: string, value: unknown): string {
  return `<tr><th>${esc(label)}</th><td>${esc(value) || '—'}</td></tr>`;
}

function section(title: string, body: string): string {
  if (!body) return '';
  return `<section class="block"><h2 class="section">${esc(title)}</h2>${body}</section>`;
}

const CSS = `
@page { size: A4; margin: 14mm 14mm 20mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--gsi-font-family);
  font-size: 9.5pt;
  color: var(--gsi-color-text);
  line-height: 1.45;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.letterhead .brand img { height: 54px; }
.letterhead .contacts { text-align: right; font-size: 7.5pt; color: var(--gsi-color-text-muted); max-width: 46%; }
.accent-rule { height: 3px; margin: 10px 0 12px; border-radius: 2px;
  background: linear-gradient(90deg, var(--gsi-color-primary), var(--gsi-color-accent)); }
.accreditation { font-size: 7.5pt; color: var(--gsi-color-text-muted); margin-bottom: 10px; }

.title-block { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 10px; }
.title-block h1 { margin: 0; font-size: 17pt; color: var(--gsi-color-primary); letter-spacing: 0.02em; }
.title-block .subtitle { font-size: 9pt; color: var(--gsi-color-text-muted); margin-top: 2px; }
table.meta { border-collapse: collapse; font-size: 8.5pt; }
table.meta th { text-align: left; font-weight: 500; padding: 1px 10px 1px 0; color: var(--gsi-color-text-muted); white-space: nowrap; }
table.meta td { padding: 1px 0; font-weight: 700; color: var(--gsi-color-primary); white-space: nowrap; }

section.block { break-inside: auto; }
h2.section { font-size: 10.5pt; color: var(--gsi-color-primary); margin: 16px 0 6px;
  padding-bottom: 4px; border-bottom: 1.5px solid var(--gsi-color-accent); break-after: avoid; }

table.info { width: 100%; border-collapse: collapse; }
table.info th, table.info td { border: 1px solid var(--gsi-color-border); padding: 5px 8px; vertical-align: top; }
table.info th { width: 32%; background: var(--gsi-color-background); text-align: left; font-weight: 500; }

table.grid { width: 100%; border-collapse: collapse; }
table.grid thead { display: table-header-group; }
table.grid tfoot { display: table-footer-group; }
table.grid th { background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  text-align: left; padding: 5px 7px; font-weight: 500; font-size: 8.5pt; }
table.grid td { border-bottom: 1px solid var(--gsi-color-border); padding: 5px 7px; vertical-align: top;
  word-break: break-word; }
table.grid tr { break-inside: avoid; }
table.grid td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
table.grid td.mono { font-family: var(--gsi-font-family-mono, monospace); white-space: nowrap; }

.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 8pt; font-weight: 700; white-space: nowrap; }
.pill--ok { background: color-mix(in srgb, var(--gsi-color-success) 16%, white); color: var(--gsi-color-success); }
.pill--bad { background: color-mix(in srgb, var(--gsi-color-danger) 16%, white); color: var(--gsi-color-danger); }
.pill--muted { background: var(--gsi-color-background); color: var(--gsi-color-text-muted); }

.prose p { margin: 0 0 6px; }
.muted { color: var(--gsi-color-text-muted); }

.photos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.photo { break-inside: avoid; border: 1px solid var(--gsi-color-border); border-radius: 4px; overflow: hidden; }
.photo img { width: 100%; height: 62mm; object-fit: cover; display: block; }
.photo .cap { padding: 4px 6px; font-size: 7.5pt; color: var(--gsi-color-text-muted); }

.signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 6px; break-inside: avoid; }
.sign { border-top: 1px solid var(--gsi-color-border); padding-top: 5px; font-size: 8.5pt; }
.sign .role { color: var(--gsi-color-text-muted); font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
.sign .name { font-weight: 700; }
.sign .line { margin-top: 20px; border-bottom: 1px dotted var(--gsi-color-border-strong); }

.verify { display: flex; gap: 14px; align-items: center; margin-top: 14px; break-inside: avoid; }
.verify img { width: 30mm; height: 30mm; }
.verify .text { font-size: 8pt; color: var(--gsi-color-text-muted); }
.verify .url { font-size: 7.5pt; word-break: break-all; color: var(--gsi-color-primary); }

.statement { margin-top: 12px; font-size: 7.5pt; color: var(--gsi-color-text-muted); break-inside: avoid; }

/* A preview is not a document, and says so on every page. */
.watermark { position: fixed; top: 44%; left: 0; right: 0; text-align: center;
  font-size: 68pt; font-weight: 800; color: var(--gsi-color-danger); opacity: 0.1;
  transform: rotate(-24deg); letter-spacing: 0.1em; z-index: 0; }
`;

// ---- Section renderers ------------------------------------------------------------------------

type Ctx = RenderInput & { lang: Lang; tz: string };

function renderHeader(ctx: Ctx): string {
  const { snapshot: s, document: d, lang } = ctx;
  const title = d.title?.trim() || t(d.reportType, lang);
  return `
    <header class="letterhead">
      <div class="brand"><img src="${logoDataUri('logo-wordmark.png')}" alt="General Survey Inspection"/></div>
      <div class="contacts">
        <div><strong>${esc(s.branch.legalName ?? s.branch.code)}</strong></div>
        ${s.branch.address ? `<div>${esc(s.branch.address)}</div>` : ''}
        ${s.branch.phone ? `<div>${esc(s.branch.phone)}</div>` : ''}
        ${s.branch.email ? `<div>${esc(s.branch.email)}</div>` : ''}
      </div>
    </header>
    <div class="accent-rule"></div>
    ${s.branch.accreditation ? `<div class="accreditation">${esc(s.branch.accreditation)}</div>` : ''}
    <div class="title-block">
      <div>
        <h1>${esc(t(d.reportType, lang))}</h1>
        ${title !== t(d.reportType, lang) ? `<div class="subtitle">${esc(title)}</div>` : ''}
      </div>
      <table class="meta">
        <tr><th>${esc(t('documentNo', lang))}</th><td>${esc(d.reportNumber)}</td></tr>
        <tr><th>${esc(t('revision', lang))}</th><td>${d.version}</td></tr>
        <tr><th>${esc(t('issueDate', lang))}</th><td>${esc(fmtDate(d.issuedAt, ctx.tz, lang, false))}</td></tr>
        <tr><th>${esc(t('jobNo', lang))}</th><td>${esc(s.job.jobNumber)}</td></tr>
      </table>
    </div>`;
}

function renderClient(ctx: Ctx): string {
  const { snapshot: s, lang } = ctx;
  return section(
    t('client', lang),
    `<table class="info">
      ${infoRow(t('client', lang), s.client.name)}
      ${s.client.address ? infoRow(t('address', lang), s.client.address) : ''}
      ${s.client.gaftaFosfaRef ? infoRow(t('gafta', lang), s.client.gaftaFosfaRef) : ''}
      ${s.job.clientReference ? infoRow(t('clientRef', lang), s.job.clientReference) : ''}
    </table>`,
  );
}

function renderJob(ctx: Ctx): string {
  const { snapshot: s, lang } = ctx;
  return section(
    t('job', lang),
    `<table class="info">
      ${infoRow(t('jobNo', lang), s.job.jobNumber)}
      ${infoRow(t('service', lang), s.job.type.replace(/_/g, ' '))}
      ${s.job.location ? infoRow(t('place', lang), [s.job.location, s.job.city].filter(Boolean).join(', ')) : ''}
      ${s.job.vesselOrObject ? infoRow(t('object', lang), s.job.vesselOrObject) : ''}
      ${s.job.commodity ? infoRow(t('commodity', lang), s.job.commodity) : ''}
      ${s.job.quantity ? infoRow(t('quantity', lang), s.job.quantity) : ''}
    </table>`,
  );
}

function renderInspection(ctx: Ctx): string {
  const { snapshot: s, lang, tz } = ctx;
  if (!s.inspections.length) return '';
  const body = s.inspections
    .map(
      (i) => `<table class="info">
        ${infoRow(t('inspectionNo', lang), i.inspectionNumber)}
        ${infoRow(t('service', lang), i.type.replace(/_/g, ' '))}
        ${infoRow(
          t('period', lang),
          i.actualEnd
            ? `${fmtDate(i.actualStart, tz, lang)} — ${fmtDate(i.actualEnd, tz, lang)}`
            : fmtDate(i.actualStart, tz, lang),
        )}
        ${i.inspectors.length ? infoRow(t('inspectors', lang), i.inspectors.join(', ')) : ''}
        ${i.weatherConditions || i.siteConditions
          ? infoRow(t('conditions', lang), [i.weatherConditions, i.siteConditions].filter(Boolean).join(' · '))
          : ''}
      </table>
      ${i.generalObservations ? `<div class="prose">${prose(i.generalObservations)}</div>` : ''}`,
    )
    .join('');
  return section(t('inspection', lang), body);
}

function renderChecklist(ctx: Ctx): string {
  const { snapshot: s, lang } = ctx;
  const rows = s.inspections.flatMap((i) => i.checklist);
  if (!rows.length) return '';
  const pill = (r: string | null) =>
    r === 'ok'
      ? '<span class="pill pill--ok">OK</span>'
      : r === 'deviation'
        ? '<span class="pill pill--bad">!</span>'
        : '<span class="pill pill--muted">—</span>';
  return section(
    t('checklist', lang),
    `<table class="grid">
      <thead><tr>
        <th>${esc(t('checkPoint', lang))}</th><th style="width:70px">${esc(t('result', lang))}</th>
        <th style="width:110px">${esc(t('reading', lang))}</th><th style="width:34%">${esc(t('remarks', lang))}</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (c) => `<tr>
            <td>${esc(localize(c.label as never, lang))}</td>
            <td>${pill(c.result)}</td>
            <td>${esc(c.value) || '—'}</td>
            <td>${esc(c.notes) || ''}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`,
  );
}

function renderFindings(ctx: Ctx): string {
  const { snapshot: s, lang } = ctx;
  const rows = s.inspections.flatMap((i) => i.findings);
  if (!rows.length) return '';
  return section(
    t('findings', lang),
    `<table class="grid">
      <thead><tr>
        <th style="width:90px">${esc(t('severity', lang))}</th><th style="width:28%">${esc(t('description', lang))}</th>
        <th>${esc(t('remarks', lang))}</th><th style="width:26%">${esc(t('recommendation', lang))}</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (f) => `<tr>
            <td><span class="pill ${f.severity === 'critical' || f.severity === 'major' ? 'pill--bad' : 'pill--muted'}">${esc(f.severity)}</span></td>
            <td><strong>${esc(f.title)}</strong></td>
            <td>${esc(f.description) || ''}</td>
            <td>${esc(f.recommendation) || ''}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`,
  );
}

function renderMeasurements(ctx: Ctx): string {
  const { snapshot: s, lang } = ctx;
  const rows = s.inspections.flatMap((i) => i.measurements);
  if (!rows.length) return '';
  return section(
    t('measurements', lang),
    `<table class="grid">
      <thead><tr>
        <th>${esc(t('type', lang))}</th><th style="width:110px">${esc(t('reading', lang))}</th>
        <th style="width:80px">${esc(t('unit', lang))}</th><th style="width:34%">${esc(t('location', lang))}</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (m) => `<tr>
            <td>${esc(m.type.replace(/_/g, ' '))}</td>
            <td class="num">${esc(m.value)}</td>
            <td>${esc(m.unit) || ''}</td>
            <td>${esc(m.location) || ''}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>`,
  );
}

function renderSamples(ctx: Ctx, spec: ReportSectionSpec): string {
  const { snapshot: s, lang, tz } = ctx;
  if (!s.samples.length) return '';
  const withCustody = spec.options?.showCustody === true;
  return section(
    t('samples', lang),
    `<table class="grid">
      <thead><tr>
        <th>${esc(t('sampleNo', lang))}</th><th>${esc(t('commodity', lang))}</th>
        <th style="width:90px">${esc(t('quantity', lang))}</th><th style="width:110px">${esc(t('seal', lang))}</th>
        <th style="width:120px">${esc(t('sampledAt', lang))}</th><th>${esc(t('sampledBy', lang))}</th>
      </tr></thead>
      <tbody>${s.samples
        .map(
          (x) => `<tr>
            <td class="mono">${esc(x.sampleNumber)}</td>
            <td>${esc(x.commodity) || '—'}</td>
            <td class="num">${esc(x.quantity ? `${Number(x.quantity)} ${x.unit ?? ''}`.trim() : '—')}</td>
            <td class="mono">${esc(x.sealNumber) || '—'}</td>
            <td>${esc(fmtDate(x.sampledAt, tz, lang, false))}</td>
            <td>${esc(x.sampledByName) || '—'}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
    ${
      withCustody
        ? s.samples
            .map(
              (x) =>
                `<div class="muted" style="margin-top:6px;font-size:8pt">
                  <strong>${esc(x.sampleNumber)}</strong> — ${esc(t('custody', lang))}:
                  ${x.custodySummary
                    .map((c) => `${esc(c.event.replace(/_/g, ' '))} ${esc(fmtDate(c.at, tz, lang, false))}${c.by ? ` → ${esc(c.by)}` : ''}`)
                    .join(' · ') || esc(t('none', lang))}
                </div>`,
            )
            .join('')
        : ''
    }`,
  );
}

function renderResults(ctx: Ctx, spec: ReportSectionSpec): string {
  const { snapshot: s, lang, tz } = ctx;
  if (!s.results.length) return '';
  const showSpec = spec.options?.showSpecification !== false;
  const showMethod = spec.options?.showMethod !== false;
  const bySample = s.results.length > 1 && new Set(s.results.map((r) => r.sampleNumber)).size > 1;

  const evaluation = (e: string) =>
    e === 'out_of_spec'
      ? `<span class="pill pill--bad">${esc(t('outOfSpec', lang))}</span>`
      : e === 'within_spec'
        ? `<span class="pill pill--ok">${esc(t('withinSpec', lang))}</span>`
        : `<span class="pill pill--muted">${esc(t('noLimit', lang))}</span>`;

  return section(
    t('results', lang),
    `<table class="grid">
      <thead><tr>
        ${bySample ? `<th style="width:120px">${esc(t('sampleNo', lang))}</th>` : ''}
        <th>${esc(t('test', lang))}</th>
        <th style="width:90px">${esc(t('result', lang))}</th>
        <th style="width:60px">${esc(t('unit', lang))}</th>
        ${showSpec ? `<th style="width:90px">${esc(t('specification', lang))}</th>` : ''}
        ${showMethod ? `<th style="width:20%">${esc(t('method', lang))}</th>` : ''}
        <th style="width:110px">${esc(t('assessment', lang))}</th>
      </tr></thead>
      <tbody>${s.results
        .map(
          (r) => `<tr>
            ${bySample ? `<td class="mono">${esc(r.sampleNumber)}</td>` : ''}
            <td>${esc(localize(r.testName as never, lang))}</td>
            <td class="num"><strong>${esc(r.value)}</strong></td>
            <td>${esc(r.unit) || ''}</td>
            ${showSpec ? `<td class="num">${esc(r.specification) || '—'}</td>` : ''}
            ${showMethod ? `<td>${esc(r.methodCode)}${r.standardReference ? `<div class="muted" style="font-size:7.5pt">${esc(r.standardReference)}</div>` : ''}</td>` : ''}
            <td>${evaluation(r.evaluation)}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
    <div class="muted" style="margin-top:6px;font-size:7.5pt">
      ${esc(t('laboratory', lang))}: ${esc(s.samples.find((x) => x.laboratoryName)?.laboratoryName ?? '—')} ·
      ${esc(t('issueDate', lang))}: ${esc(fmtDate(s.results[0]?.releasedAt ?? null, tz, lang, false))}
    </div>`,
  );
}

function renderNarrative(ctx: Ctx, key: 'summary' | 'observations' | 'conclusion' | 'recommendations'): string {
  const { content, lang, snapshot } = ctx;
  const text =
    key === 'summary'
      ? content.executiveSummary
      : key === 'observations'
        ? content.observations ?? snapshot.inspections.map((i) => i.generalObservations).filter(Boolean).join('\n\n')
        : key === 'conclusion'
          ? content.conclusions ?? snapshot.inspections.map((i) => i.conclusion).filter(Boolean).join('\n\n')
          : content.recommendations;
  if (!text || !text.trim()) return '';
  return section(t(key, lang), `<div class="prose">${prose(text)}</div>`);
}

function renderPhotos(ctx: Ctx, spec: ReportSectionSpec): string {
  const { snapshot: s, lang, tz, images } = ctx;
  const chosen = s.photos.filter((p) => images.has(p.id));
  if (!chosen.length) return '';
  const showGps = spec.options?.showGps === true;
  return section(
    t('photos', lang),
    `<div class="photos">${chosen
      .map(
        (p) => `<figure class="photo">
          <img src="${images.get(p.id)}" alt=""/>
          <figcaption class="cap">
            ${esc(p.caption) || ''}${p.caption && p.takenAt ? ' · ' : ''}${esc(fmtDate(p.takenAt, tz, lang))}
            ${showGps && p.gpsLat != null && p.gpsLng != null ? ` · ${p.gpsLat.toFixed(5)}, ${p.gpsLng.toFixed(5)}` : ''}
          </figcaption>
        </figure>`,
      )
      .join('')}</div>`,
  );
}

function renderSignatures(ctx: Ctx): string {
  const { snapshot: s, lang, tz } = ctx;
  const a = s.approvals;
  const sign = (role: string, name: string | null, at: string | null) => `
    <div class="sign">
      <div class="role">${esc(role)}</div>
      <div class="name">${esc(name) || '—'}</div>
      <div class="muted" style="font-size:7.5pt">${at ? esc(fmtDate(at, tz, lang, false)) : ''}</div>
      <div class="line"></div>
      <div class="muted" style="font-size:7pt">${esc(t('signature', lang))}</div>
    </div>`;
  return section(
    t('approved', lang),
    `<div class="signatures">
      ${sign(t('prepared', lang), a.preparedByName, null)}
      ${sign(t('reviewed', lang), a.reviewedByName, null)}
      ${sign(t('approved', lang), a.approvedByName, a.approvedAt)}
    </div>`,
  );
}

function renderQr(ctx: Ctx): string {
  const { document: d, lang } = ctx;
  if (!d.qrDataUrl || !d.verifyUrl) return '';
  return `<div class="verify">
      <img src="${d.qrDataUrl}" alt=""/>
      <div>
        <div><strong>${esc(t('verify', lang))}</strong></div>
        <div class="text">${esc(t('verifyText', lang))}</div>
        <div class="url">${esc(d.verifyUrl)}</div>
      </div>
    </div>`;
}

function renderStatement(ctx: Ctx): string {
  const { definition, lang } = ctx;
  const custom = definition.statement ? localize(definition.statement, lang) : null;
  return `<div class="statement"><strong>${esc(t('statement', lang))}.</strong> ${esc(custom || t('defaultStatement', lang))}</div>`;
}

// ---- The renderer -------------------------------------------------------------------------------

export function renderDocument(input: RenderInput): { html: string; footer: string } {
  const lang = L(input.language);
  const ctx: Ctx = { ...input, lang, tz: input.snapshot.branch.timezone || 'Europe/Istanbul' };

  const sections = input.definition.sections?.length
    ? input.definition.sections
    : DEFAULT_SECTIONS[input.document.reportType];

  const body = sections
    .map((spec) => {
      switch (spec.section) {
        case 'header': return renderHeader(ctx);
        case 'client': return renderClient(ctx);
        case 'job': return renderJob(ctx);
        case 'inspection': return renderInspection(ctx);
        case 'checklist': return renderChecklist(ctx);
        case 'findings': return renderFindings(ctx);
        case 'measurements': return renderMeasurements(ctx);
        case 'samples': return renderSamples(ctx, spec);
        case 'lab_results': return renderResults(ctx, spec);
        case 'observations': return renderNarrative(ctx, 'observations');
        case 'conclusion':
          return renderNarrative(ctx, 'summary') + renderNarrative(ctx, 'conclusion') +
                 renderNarrative(ctx, 'recommendations');
        case 'photos': return renderPhotos(ctx, spec);
        case 'signatures': return renderSignatures(ctx);
        case 'qr': return renderQr(ctx);
        case 'footer': return renderStatement(ctx);
        default: return '';
      }
    })
    .join('\n');

  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(input.document.reportNumber)}</title>
<style>${toCssVariables()}
${CSS}</style></head>
<body>
${input.document.draft ? `<div class="watermark">${esc(t('draft', lang))}</div>` : ''}
${body}
</body></html>`;

  const footer = `
    <div style="width:100%;font-size:7pt;color:#6b7280;padding:0 14mm;display:flex;justify-content:space-between;">
      <span>${esc(input.document.reportNumber)}${input.document.draft ? ` — ${esc(t('draft', lang))}` : ''}</span>
      <span>${esc(input.snapshot.branch.legalName ?? '')}</span>
      <span>${esc(t('page', lang))} <span class="pageNumber"></span> ${esc(t('of', lang))} <span class="totalPages"></span></span>
    </div>`;

  return { html, footer };
}

/**
 * What each document type prints when its template says nothing more specific. These are the
 * sections the document *is*: a certificate of analysis without results is not a certificate,
 * and an inspection report without findings is a letterhead.
 */
export const DEFAULT_SECTIONS: Record<ReportType, ReportSectionSpec[]> = {
  inspection_report: [
    { section: 'header' }, { section: 'client' }, { section: 'job' }, { section: 'inspection' },
    { section: 'checklist' }, { section: 'findings' }, { section: 'measurements' },
    { section: 'conclusion' }, { section: 'photos' }, { section: 'signatures' },
    { section: 'qr' }, { section: 'footer' },
  ],
  survey_report: [
    { section: 'header' }, { section: 'client' }, { section: 'job' }, { section: 'inspection' },
    { section: 'measurements' }, { section: 'conclusion' }, { section: 'photos' },
    { section: 'signatures' }, { section: 'qr' }, { section: 'footer' },
  ],
  laboratory_report: [
    { section: 'header' }, { section: 'client' }, { section: 'job' }, { section: 'samples' },
    { section: 'lab_results', options: { showMethod: true, showSpecification: true } },
    { section: 'conclusion' }, { section: 'signatures' }, { section: 'qr' }, { section: 'footer' },
  ],
  certificate_of_analysis: [
    { section: 'header' }, { section: 'client' }, { section: 'job' }, { section: 'samples' },
    { section: 'lab_results', options: { showMethod: true, showSpecification: true } },
    { section: 'conclusion' }, { section: 'signatures' }, { section: 'qr' }, { section: 'footer' },
  ],
  certificate: [
    { section: 'header' }, { section: 'client' }, { section: 'job' },
    { section: 'conclusion' }, { section: 'signatures' }, { section: 'qr' }, { section: 'footer' },
  ],
  sampling_report: [
    { section: 'header' }, { section: 'client' }, { section: 'job' },
    { section: 'samples', options: { showCustody: true } },
    { section: 'conclusion' }, { section: 'photos' }, { section: 'signatures' },
    { section: 'qr' }, { section: 'footer' },
  ],
  custom: [
    { section: 'header' }, { section: 'client' }, { section: 'job' },
    { section: 'conclusion' }, { section: 'photos' }, { section: 'signatures' },
    { section: 'qr' }, { section: 'footer' },
  ],
};

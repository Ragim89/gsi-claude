import { localize, SERVICE_TYPE_LABELS } from '@gsi/shared-types';
import { tokens, toCssVariables } from '@gsi/ui-kit';
import { logoDataUri } from './brand';
import type { ReportTemplate, ReportTemplateData } from './types';

/**
 * Letterhead template: GSI Türkiye (HQ, Istanbul).
 *
 * All colours/fonts come from @gsi/ui-kit design tokens, injected as CSS custom properties —
 * no brand HEX values in this file, so the brandbook update (open question #1) is a token change.
 *
 * ASSUMPTION: GSI has not shared its current Turkish report/certificate form (open question #4).
 * Layout follows common ISO/IEC 17020 inspection-report practice: letterhead + accreditation,
 * identification of the report, client and object, results, photographic evidence, statement of
 * limitation, authorised signature, QR for third-party verification. Labels are bilingual
 * Turkish / English (branch UI locales: tr, en).
 *
 * The official logo files (packages/ui-kit/src/assets) are printed on the letterhead.
 * ASSUMPTION: only raster logos were supplied; an SVG version would print sharper.
 */

const T = {
  title: ['MUAYENE RAPORU', 'INSPECTION REPORT'],
  reportNo: ['Rapor No', 'Report No'],
  version: ['Revizyon', 'Revision'],
  issueDate: ['Düzenleme Tarihi', 'Date of Issue'],
  jobNo: ['İş No', 'Job No'],
  client: ['Müşteri', 'Client'],
  gafta: ['GAFTA / FOSFA Ref.', 'GAFTA / FOSFA Ref.'],
  service: ['Hizmet', 'Service'],
  location: ['Muayene Yeri', 'Place of Inspection'],
  object: ['Gemi / Obje', 'Vessel / Object'],
  commodity: ['Ürün', 'Commodity'],
  quantity: ['Miktar', 'Quantity'],
  date: ['Muayene Tarihi', 'Date of Inspection'],
  inspector: ['Eksper', 'Surveyor'],
  checklist: ['Muayene Bulguları', 'Inspection Findings'],
  item: ['Kontrol Noktası', 'Check Point'],
  result: ['Sonuç', 'Result'],
  reading: ['Değer / Okuma', 'Value / Reading'],
  remarks: ['Açıklama', 'Remarks'],
  photos: ['Fotoğraf Kayıtları', 'Photographic Evidence'],
  approved: ['Onaylayan', 'Approved by'],
  signature: ['İmza / Kaşe', 'Signature / Stamp'],
  verify: ['Doğrulama', 'Verification'],
  verifyText: [
    'Bu raporun gerçekliğini QR kodu okutarak doğrulayabilirsiniz.',
    'Scan the QR code to verify the authenticity of this report.',
  ],
  disclaimerTitle: ['Beyan', 'Statement'],
  disclaimer: [
    'Bu rapor yalnızca muayene tarihinde ve yerinde gözlemlenen koşulları yansıtır. Rapor, düzenleyen kuruluşun yazılı izni olmadan kısmen çoğaltılamaz.',
    'This report reflects only the conditions observed at the time and place of inspection. It may not be reproduced except in full without the written approval of the issuing organization.',
  ],
  draft: ['TASLAK', 'DRAFT'],
  page: ['Sayfa', 'Page'],
} as const;

const RESULT = {
  ok: { label: ['Uygun', 'Satisfactory'], tone: 'success' },
  deviation: { label: ['Uygunsuz', 'Deviation'], tone: 'danger' },
  na: { label: ['Uygulanamaz', 'N/A'], tone: 'muted' },
} as const;

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bilingual label: Turkish primary, English secondary. */
function bi(pair: readonly [string, string]): string {
  return `<span class="tr">${esc(pair[0])}</span><span class="en">${esc(pair[1])}</span>`;
}

function fmtDate(d: string | Date | null, tz: string, withTime = true): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: tz,
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(date);
}

function row(label: readonly [string, string], value: unknown): string {
  return `<tr><th>${bi(label)}</th><td>${esc(value) || '—'}</td></tr>`;
}

const CSS = `
@page { size: A4; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--gsi-font-family);
  font-size: 9.5pt;
  color: var(--gsi-color-text);
  line-height: 1.4;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.tr { display: block; }
.en { display: block; color: var(--gsi-color-text-muted); font-size: 0.85em; font-weight: var(--gsi-font-weight-regular); }

/* Letterhead: the official wordmark on white, as on the company's own stationery. */
.letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.letterhead .brand img { height: 58px; }
.brand-sub { font-size: 8pt; color: var(--gsi-color-text-muted); margin-top: 4px; }
.letterhead .contacts { text-align: right; font-size: 7.5pt; color: var(--gsi-color-text-muted); max-width: 45%; }
.accent-rule {
  height: 3px; margin: 10px 0 14px; border-radius: 2px;
  background: linear-gradient(90deg, var(--gsi-color-primary), var(--gsi-color-accent));
}
.accreditation { font-size: 7.5pt; color: var(--gsi-color-text-muted); margin-bottom: 12px; }

.title-block { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 12px; }
.title-block h1 { margin: 0; font-size: 17pt; color: var(--gsi-color-primary); letter-spacing: 0.02em; }
.title-block h1 .en { font-size: 10pt; letter-spacing: 0.08em; }
.meta { border-collapse: collapse; font-size: 8.5pt; }
.meta th { text-align: left; font-weight: var(--gsi-font-weight-medium); padding: 2px 10px 2px 0; color: var(--gsi-color-text-muted); }
.meta td { padding: 2px 0; font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); }
.meta .tr, .meta .en { display: inline; }
.meta .en::before { content: ' / '; }

h2.section {
  font-size: 10.5pt; color: var(--gsi-color-primary); margin: 18px 0 6px;
  padding-bottom: 4px; border-bottom: 1.5px solid var(--gsi-color-accent);
  display: flex; gap: 8px; align-items: baseline;
}
h2.section .tr, h2.section .en { display: inline; }

table.info { width: 100%; border-collapse: collapse; }
table.info th, table.info td { border: 1px solid var(--gsi-color-border); padding: 5px 8px; vertical-align: top; }
table.info th { width: 32%; background: var(--gsi-color-background); text-align: left; font-weight: var(--gsi-font-weight-medium); }

table.findings { width: 100%; border-collapse: collapse; }
table.findings th {
  background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  text-align: left; padding: 5px 7px; font-weight: var(--gsi-font-weight-medium); font-size: 8.5pt;
}
table.findings th .en { color: var(--gsi-color-on-primary); opacity: 0.75; }
table.findings td { border-bottom: 1px solid var(--gsi-color-border); padding: 6px 7px; vertical-align: top; }
table.findings tr { page-break-inside: avoid; }
table.findings td.num { width: 22px; color: var(--gsi-color-text-muted); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 8pt; font-weight: var(--gsi-font-weight-bold); white-space: nowrap; }
.pill .tr, .pill .en { display: inline; color: inherit; }
.pill .en::before { content: ' / '; }
.pill.success { background: var(--gsi-color-success-bg); color: var(--gsi-color-success); }
.pill.danger { background: var(--gsi-color-danger-bg); color: var(--gsi-color-danger); }
.pill.muted { background: var(--gsi-color-background); color: var(--gsi-color-text-muted); }

.gallery-group { page-break-inside: avoid; margin-bottom: 10px; }
.gallery-group h3 { font-size: 9pt; margin: 8px 0 4px; color: var(--gsi-color-primary); }
.gallery-group h3 .tr, .gallery-group h3 .en { display: inline; }
.gallery-group h3 .en::before { content: ' / '; }
.gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
figure { margin: 0; border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); overflow: hidden; page-break-inside: avoid; }
figure img { width: 100%; height: 62mm; object-fit: cover; display: block; background: var(--gsi-color-background); }
figcaption { font-size: 7pt; color: var(--gsi-color-text-muted); padding: 3px 6px; font-family: var(--gsi-font-family-mono); }

.closing { display: grid; grid-template-columns: 1fr 1fr auto; gap: 14px; margin-top: 18px; page-break-inside: avoid; }
.box { border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); padding: 8px 10px; min-height: 30mm; }
.box .label { font-size: 8pt; color: var(--gsi-color-text-muted); }
.box .label .tr, .box .label .en { display: inline; }
.box .label .en::before { content: ' / '; }
.box .value { font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); margin-top: 4px; }
.qr { text-align: center; width: 36mm; }
.qr img { width: 30mm; height: 30mm; }
.qr .hint { font-size: 6.5pt; color: var(--gsi-color-text-muted); }
.disclaimer { margin-top: 14px; font-size: 7.5pt; color: var(--gsi-color-text-muted); page-break-inside: avoid; }
.disclaimer .en { font-size: 1em; margin-top: 2px; }

.watermark {
  position: fixed; top: 40%; left: 0; right: 0; text-align: center;
  font-size: 90pt; font-weight: var(--gsi-font-weight-bold);
  color: var(--gsi-color-danger); opacity: 0.08; transform: rotate(-30deg); pointer-events: none;
}
`;

function html(d: ReportTemplateData): string {
  const tz = d.branch.timezone;
  const service = SERVICE_TYPE_LABELS[d.job.type];
  const findings = d.items
    .map((it, i) => {
      const res = it.result ? RESULT[it.result] : null;
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>${bi([localize(it.label, 'tr'), localize(it.label, 'en')])}</td>
        <td>${res ? `<span class="pill ${res.tone}">${bi(res.label)}</span>` : '—'}</td>
        <td>${esc(it.value) || '—'}</td>
        <td>${esc(it.notes)}</td>
      </tr>`;
    })
    .join('');

  const withPhotos = d.items.filter((it) => it.photos.length);
  const gallery = withPhotos
    .map(
      (it) => `<div class="gallery-group">
        <h3>${bi([localize(it.label, 'tr'), localize(it.label, 'en')])}</h3>
        <div class="gallery">
          ${it.photos
            .map(
              (p) => `<figure><img src="${p.src}" alt="" /><figcaption>${esc(fmtDate(p.takenAt, tz))}${
                p.gpsLat != null && p.gpsLng != null ? ` · ${p.gpsLat.toFixed(5)}, ${p.gpsLng.toFixed(5)}` : ''
              }</figcaption></figure>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('');

  const b = d.branch;
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8" /><title>${esc(d.report.number)}</title>
<style>${toCssVariables()}\n${CSS}</style></head>
<body>
${d.draft ? `<div class="watermark">${esc(T.draft[0])} / ${esc(T.draft[1])}</div>` : ''}

<header class="letterhead">
  <div class="brand">
    <img src="${d.organization.logoUrl?.startsWith('data:') ? d.organization.logoUrl : logoDataUri('logo-wordmark.png')}" alt="${esc(d.organization.name)}" />
    <div class="brand-sub">${esc(b.legalName)}</div>
  </div>
  <div class="contacts">
    ${esc(b.address)}<br />
    ${[b.phone, b.email, b.website].filter(Boolean).map(esc).join(' · ')}
  </div>
</header>
<div class="accent-rule"></div>
${b.accreditation ? `<div class="accreditation">${esc(b.accreditation)} · GAFTA · FOSFA</div>` : ''}

<div class="title-block">
  <h1>${bi(T.title)}</h1>
  <table class="meta">
    <tr><th>${bi(T.reportNo)}</th><td>${esc(d.report.number)}</td></tr>
    <tr><th>${bi(T.version)}</th><td>${d.report.version}</td></tr>
    <tr><th>${bi(T.issueDate)}</th><td>${esc(fmtDate(d.report.issuedAt, tz, false))}</td></tr>
  </table>
</div>

<table class="info">
  ${row(T.client, d.client.name)}
  ${d.client.gaftaFosfaRef ? row(T.gafta, d.client.gaftaFosfaRef) : ''}
  ${row(T.service, `${service.tr ?? service.en} / ${service.en}`)}
  ${row(T.jobNo, d.job.jobNumber)}
  ${row(T.location, d.job.location)}
  ${row(T.object, d.job.vesselOrObject)}
  ${row(T.commodity, d.job.commodity)}
  ${row(T.quantity, d.job.quantity)}
  ${row(T.date, fmtDate(d.job.scheduledAt ?? d.job.submittedAt, tz))}
  ${row(T.inspector, d.job.assignedInspectorName)}
</table>

<h2 class="section">${bi(T.checklist)}</h2>
<table class="findings">
  <thead><tr>
    <th>#</th><th>${bi(T.item)}</th><th>${bi(T.result)}</th><th>${bi(T.reading)}</th><th>${bi(T.remarks)}</th>
  </tr></thead>
  <tbody>${findings}</tbody>
</table>

${gallery ? `<h2 class="section">${bi(T.photos)}</h2>${gallery}` : ''}

<div class="closing">
  <div class="box">
    <div class="label">${bi(T.approved)}</div>
    <div class="value">${esc(d.approvedByName) || '—'}</div>
    <div>${d.draft ? '' : esc(fmtDate(d.report.issuedAt, tz))}</div>
  </div>
  <div class="box">
    <div class="label">${bi(T.signature)}</div>
  </div>
  <div class="qr">
    ${d.report.qrDataUrl ? `<img src="${d.report.qrDataUrl}" alt="QR" />` : ''}
    <div class="hint">${esc(T.verifyText[0])}<br />${esc(T.verifyText[1])}</div>
  </div>
</div>

<div class="disclaimer">
  <strong>${esc(T.disclaimerTitle[0])} / ${esc(T.disclaimerTitle[1])}:</strong>
  <span class="tr">${esc(T.disclaimer[0])}</span>
  <span class="en">${esc(T.disclaimer[1])}</span>
</div>
</body></html>`;
}

/** Chromium footer templates cannot see page CSS, so token values are inlined here. */
function footer(d: ReportTemplateData): string {
  const c = tokens.color;
  return `<div style="box-sizing:border-box; width:100%; padding:0 14mm; font-family:${tokens.font.family.replace(/"/g, "'")}; font-size:7pt; color:${c.textMuted};">
    <div style="display:flex; justify-content:space-between; border-top:1px solid ${c.border}; padding-top:4px;">
      <span>${esc(d.report.number)} · ${esc(d.branch.legalName)}</span>
      <span>${T.page[0]} / ${T.page[1]} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  </div>`;
}

export const trDefaultTemplate: ReportTemplate = { id: 'tr-default', html, footer };

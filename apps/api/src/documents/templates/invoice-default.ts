import { localize, SERVICE_TYPE_LABELS } from '@gsi/shared-types';
import { tokens, toCssVariables } from '@gsi/ui-kit';
import type { InvoiceTemplateData } from './types';

/**
 * Invoice on the branch letterhead. Same mechanism and the same design tokens as the
 * inspection report (apps/api/src/documents/templates/tr-default.ts), so a brandbook change
 * updates both.
 *
 * ASSUMPTION: GSI has not provided its invoice form or bank details (open questions #1 and #4).
 * Layout follows ordinary commercial-invoice practice; bank details print a placeholder until
 * per-branch payment data is supplied, and the wording is bilingual TR/EN like the report.
 */

const T = {
  title: ['FATURA', 'INVOICE'],
  invoiceNo: ['Fatura No', 'Invoice No'],
  issueDate: ['Düzenleme Tarihi', 'Issue Date'],
  dueDate: ['Son Ödeme Tarihi', 'Due Date'],
  billTo: ['Müşteri', 'Bill to'],
  taxId: ['Vergi No', 'Tax ID'],
  jobRef: ['İş Referansı', 'Job Reference'],
  service: ['Hizmet', 'Service'],
  description: ['Açıklama', 'Description'],
  qty: ['Miktar', 'Qty'],
  unitPrice: ['Birim Fiyat', 'Unit Price'],
  amount: ['Tutar', 'Amount'],
  subtotal: ['Ara Toplam', 'Subtotal'],
  vat: ['KDV', 'VAT'],
  total: ['Genel Toplam', 'Total'],
  paid: ['Ödenen', 'Paid'],
  due: ['Kalan Bakiye', 'Balance Due'],
  payment: ['Ödeme Bilgileri', 'Payment Details'],
  bankTbc: ['Banka bilgileri sözleşmeye göre', 'Bank details as per contract'],
  terms: ['Ödeme Koşulları', 'Payment Terms'],
  termsText: [
    'Ödeme, fatura tarihinden itibaren belirtilen vade içinde yapılmalıdır. Lütfen havale açıklamasına fatura numarasını yazınız.',
    'Payment is due within the stated term from the invoice date. Please quote the invoice number with your transfer.',
  ],
  status: ['Durum', 'Status'],
  cancelled: ['İPTAL', 'CANCELLED'],
  draft: ['TASLAK', 'DRAFT'],
  page: ['Sayfa', 'Page'],
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

function bi(pair: readonly [string, string]): string {
  return `<span class="tr">${esc(pair[0])}</span><span class="en">${esc(pair[1])}</span>`;
}

function fmtDate(d: string | null, tz: string): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('tr-TR', { timeZone: tz, dateStyle: 'medium' }).format(new Date(d));
}

function money(v: number, currency: string): string {
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
}

const CSS = `
@page { size: A4; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--gsi-font-family);
  font-size: 10pt;
  color: var(--gsi-color-text);
  line-height: 1.45;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.tr { display: block; }
.en { display: block; color: var(--gsi-color-text-muted); font-size: 0.85em; }
.letterhead {
  display: flex; justify-content: space-between; align-items: stretch;
  background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  border-radius: var(--gsi-radius-md); overflow: hidden;
}
.letterhead .brand { padding: 14px 18px; display: flex; align-items: center; gap: 14px; }
.wordmark { font-size: 26pt; font-weight: var(--gsi-font-weight-bold); letter-spacing: 0.08em; color: var(--gsi-color-accent); line-height: 1; }
.brand-name { font-size: 10.5pt; font-weight: var(--gsi-font-weight-bold); letter-spacing: 0.04em; text-transform: uppercase; }
.brand-sub { font-size: 8pt; opacity: 0.85; margin-top: 2px; }
.letterhead .contacts { padding: 14px 18px; text-align: right; font-size: 7.5pt; opacity: 0.9; max-width: 45%; }
.accent-rule { height: 4px; background: var(--gsi-color-accent); margin: 6px 0 16px; border-radius: 2px; }

.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 19pt; color: var(--gsi-color-primary); letter-spacing: 0.02em; }
h1 .en { font-size: 10pt; letter-spacing: 0.08em; }
.meta { border-collapse: collapse; font-size: 9pt; }
.meta th { text-align: left; padding: 2px 10px 2px 0; color: var(--gsi-color-text-muted); font-weight: var(--gsi-font-weight-medium); }
.meta td { padding: 2px 0; font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); }
.meta .tr, .meta .en { display: inline; }
.meta .en::before { content: ' / '; }

.party { border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); padding: 10px 12px; min-width: 45%; }
.party .label { font-size: 8pt; color: var(--gsi-color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.party .name { font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); margin-top: 3px; font-size: 11pt; }
.party .line { font-size: 8.5pt; color: var(--gsi-color-text-muted); }

table.lines { width: 100%; border-collapse: collapse; margin-top: 4px; }
table.lines th {
  background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  text-align: left; padding: 6px 8px; font-size: 8.5pt; font-weight: var(--gsi-font-weight-medium);
}
table.lines th .en { color: var(--gsi-color-on-primary); opacity: 0.75; }
table.lines th.num, table.lines td.num { text-align: right; }
table.lines td { border-bottom: 1px solid var(--gsi-color-border); padding: 7px 8px; vertical-align: top; }

.totals { margin-top: 14px; display: flex; justify-content: flex-end; }
.totals table { border-collapse: collapse; min-width: 62mm; }
.totals th { text-align: left; padding: 4px 14px 4px 0; color: var(--gsi-color-text-muted); font-weight: var(--gsi-font-weight-regular); font-size: 9pt; }
.totals td { text-align: right; padding: 4px 0; font-variant-numeric: tabular-nums; }
.totals tr.grand th, .totals tr.grand td {
  border-top: 1.5px solid var(--gsi-color-accent); font-weight: var(--gsi-font-weight-bold);
  color: var(--gsi-color-primary); font-size: 11pt; padding-top: 7px;
}
.totals tr.due td { color: var(--gsi-color-danger); font-weight: var(--gsi-font-weight-bold); }

.blocks { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 22px; }
.block { border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); padding: 9px 11px; font-size: 8.5pt; }
.block .label { font-size: 8pt; color: var(--gsi-color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.watermark {
  position: fixed; top: 42%; left: 0; right: 0; text-align: center;
  font-size: 84pt; font-weight: var(--gsi-font-weight-bold);
  color: var(--gsi-color-danger); opacity: 0.09; transform: rotate(-28deg);
}
`;

function html(d: InvoiceTemplateData): string {
  const tz = d.branch.timezone;
  const c = d.invoice.currency;
  const due = d.invoice.amountTotal - d.invoice.amountPaid;
  const service = d.invoice.serviceType ? SERVICE_TYPE_LABELS[d.invoice.serviceType] : null;
  const watermark =
    d.invoice.status === 'cancelled' ? T.cancelled : d.invoice.status === 'draft' ? T.draft : null;

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8" /><title>${esc(d.invoice.invoiceNumber)}</title>
<style>${toCssVariables()}\n${CSS}</style></head>
<body>
${watermark ? `<div class="watermark">${esc(watermark[0])} / ${esc(watermark[1])}</div>` : ''}

<header class="letterhead">
  <div class="brand">
    <div class="wordmark">GSI</div>
    <div>
      <div class="brand-name">General Survey Inspection</div>
      <div class="brand-sub">${esc(d.branch.legalName)}</div>
    </div>
  </div>
  <div class="contacts">
    ${esc(d.branch.address)}<br />
    ${[d.branch.phone, d.branch.email].filter(Boolean).map(esc).join(' · ')}
  </div>
</header>
<div class="accent-rule"></div>

<div class="head">
  <div>
    <h1>${bi(T.title)}</h1>
  </div>
  <table class="meta">
    <tr><th>${bi(T.invoiceNo)}</th><td>${esc(d.invoice.invoiceNumber)}</td></tr>
    <tr><th>${bi(T.issueDate)}</th><td>${esc(fmtDate(d.invoice.issueDate, tz))}</td></tr>
    <tr><th>${bi(T.dueDate)}</th><td>${esc(fmtDate(d.invoice.dueDate, tz))}</td></tr>
    ${d.invoice.jobNumber ? `<tr><th>${bi(T.jobRef)}</th><td>${esc(d.invoice.jobNumber)}</td></tr>` : ''}
  </table>
</div>

<div class="party">
  <div class="label">${esc(T.billTo[0])} / ${esc(T.billTo[1])}</div>
  <div class="name">${esc(d.client.name)}</div>
  ${d.client.address ? `<div class="line">${esc(d.client.address)}</div>` : ''}
  ${d.client.taxId ? `<div class="line">${esc(T.taxId[0])} / ${esc(T.taxId[1])}: ${esc(d.client.taxId)}</div>` : ''}
  ${d.client.gaftaFosfaRef ? `<div class="line">GAFTA / FOSFA: ${esc(d.client.gaftaFosfaRef)}</div>` : ''}
</div>

<table class="lines">
  <thead>
    <tr>
      <th>#</th>
      <th>${bi(T.description)}</th>
      <th class="num">${bi(T.qty)}</th>
      <th class="num">${bi(T.unitPrice)}</th>
      <th class="num">${bi(T.amount)}</th>
    </tr>
  </thead>
  <tbody>
    ${d.lines
      .map(
        (l, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(l.description)}${
            service && i === 0 ? `<div class="en">${esc(service.tr ?? service.en)} / ${esc(localize(service, 'en'))}</div>` : ''
          }</td>
          <td class="num">${l.quantity}</td>
          <td class="num">${esc(money(l.unitPrice, c))}</td>
          <td class="num">${esc(money(l.amount, c))}</td>
        </tr>`,
      )
      .join('')}
  </tbody>
</table>

<div class="totals">
  <table>
    <tr><th>${bi(T.subtotal)}</th><td>${esc(money(d.invoice.amountNet, c))}</td></tr>
    <tr><th>${bi(T.vat)} ${d.invoice.taxRate}%</th><td>${esc(money(d.invoice.taxAmount, c))}</td></tr>
    <tr class="grand"><th>${bi(T.total)}</th><td>${esc(money(d.invoice.amountTotal, c))}</td></tr>
    ${d.invoice.amountPaid > 0 ? `<tr><th>${bi(T.paid)}</th><td>${esc(money(d.invoice.amountPaid, c))}</td></tr>` : ''}
    ${due > 0.001 ? `<tr class="due"><th>${bi(T.due)}</th><td>${esc(money(due, c))}</td></tr>` : ''}
  </table>
</div>

<div class="blocks">
  <div class="block">
    <div class="label">${esc(T.payment[0])} / ${esc(T.payment[1])}</div>
    <div>${esc(T.bankTbc[0])}</div>
    <div class="en">${esc(T.bankTbc[1])}</div>
  </div>
  <div class="block">
    <div class="label">${esc(T.terms[0])} / ${esc(T.terms[1])}</div>
    <div>${esc(T.termsText[0])}</div>
    <div class="en">${esc(T.termsText[1])}</div>
  </div>
</div>

${d.invoice.notes ? `<div class="block" style="margin-top:14px">${esc(d.invoice.notes)}</div>` : ''}
</body></html>`;
}

function footer(d: InvoiceTemplateData): string {
  const c = tokens.color;
  return `<div style="box-sizing:border-box; width:100%; padding:0 14mm; font-family:${tokens.font.family.replace(/"/g, "'")}; font-size:7pt; color:${c.textMuted};">
    <div style="display:flex; justify-content:space-between; border-top:1px solid ${c.border}; padding-top:4px;">
      <span>${esc(d.invoice.invoiceNumber)} · ${esc(d.branch.legalName)}</span>
      <span>${T.page[0]} / ${T.page[1]} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  </div>`;
}

export const invoiceTemplate = { id: 'invoice-default', html, footer };

import { localize, SERVICE_TYPE_LABELS } from '@gsi/shared-types';
import { tokens, toCssVariables } from '@gsi/ui-kit';
import { logoDataUri } from './brand';
import type { InvoiceTemplateData } from './types';

/**
 * Invoice on the branch letterhead, in the issuing branch's own language and currency
 * (`branch.locale`/`branch.currency`, already seeded per office: KZ→ru/KZT, RU→ru/RUB,
 * TR→tr/TRY, every other branch its own — apps/api/src/db/seed.ts BRANCHES). This is the
 * generic/non-fiscal path used by every branch except Kazakhstan invoices that carry an
 * actual fiscal snapshot (those render through invoice-kz.ts instead — see
 * invoice-pdf.service.ts).
 *
 * Previously this file (`invoice-default.ts`) was hardcoded Turkish/English regardless of
 * branch, so e.g. a Russian invoice printed in Turkish. A branch whose locale has no
 * authored dictionary below (ro/uk/uz/it/…) falls back to English wording — the currency is
 * always still the branch's own — never to another country's language.
 *
 * Same mechanism and design tokens as the inspection report (tr-default.ts) and invoice-kz.ts,
 * so a brandbook change updates all three.
 */

const EN = {
  title: 'INVOICE', invoiceNo: 'Invoice No', issueDate: 'Issue Date', dueDate: 'Due Date',
  billTo: 'Bill to', taxId: 'Tax ID', jobRef: 'Job Reference', description: 'Description',
  qty: 'Qty', unitPrice: 'Unit Price', amount: 'Amount', subtotal: 'Subtotal', vat: 'VAT',
  total: 'Total', paid: 'Paid', due: 'Balance Due', payment: 'Payment Details',
  bankTbc: 'Bank details as per contract', terms: 'Payment Terms',
  termsText:
    'Payment is due within the stated term from the invoice date. Please quote the invoice number with your transfer.',
  cancelled: 'CANCELLED', draft: 'DRAFT', page: 'Page', langTag: 'en-GB',
};

type Terms = typeof EN;

const RU: Terms = {
  title: 'СЧЁТ', invoiceNo: 'Счёт №', issueDate: 'Дата выставления', dueDate: 'Срок оплаты',
  billTo: 'Покупатель', taxId: 'ИНН/БИН', jobRef: 'Номер заявки', description: 'Описание',
  qty: 'Кол-во', unitPrice: 'Цена за ед.', amount: 'Сумма', subtotal: 'Подытог', vat: 'НДС',
  total: 'Итого', paid: 'Оплачено', due: 'Остаток к оплате', payment: 'Реквизиты для оплаты',
  bankTbc: 'Банковские реквизиты согласно договору', terms: 'Условия оплаты',
  termsText:
    'Оплата производится в срок, указанный в счёте, с даты его выставления. Просим указывать номер счёта в назначении платежа.',
  cancelled: 'АННУЛИРОВАНО', draft: 'ЧЕРНОВИК', page: 'Страница', langTag: 'ru-RU',
};

const TR: Terms = {
  title: 'FATURA', invoiceNo: 'Fatura No', issueDate: 'Düzenleme Tarihi', dueDate: 'Son Ödeme Tarihi',
  billTo: 'Müşteri', taxId: 'Vergi No', jobRef: 'İş Referansı', description: 'Açıklama',
  qty: 'Miktar', unitPrice: 'Birim Fiyat', amount: 'Tutar', subtotal: 'Ara Toplam', vat: 'KDV',
  total: 'Genel Toplam', paid: 'Ödenen', due: 'Kalan Bakiye', payment: 'Ödeme Bilgileri',
  bankTbc: 'Banka bilgileri sözleşmeye göre', terms: 'Ödeme Koşulları',
  termsText:
    'Ödeme, fatura tarihinden itibaren belirtilen vade içinde yapılmalıdır. Lütfen havale açıklamasına fatura numarasını yazınız.',
  cancelled: 'İPTAL', draft: 'TASLAK', page: 'Sayfa', langTag: 'tr-TR',
};

/** The three "live" UI languages (apps/web/src/i18n.ts). Any other branch locale falls back
 *  to English wording — never to another country's language — while still using that
 *  branch's own currency. */
const TERMS_BY_LOCALE: Record<string, Terms> = { ru: RU, tr: TR, en: EN };

function termsFor(locale: string): Terms {
  return TERMS_BY_LOCALE[locale] ?? EN;
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Primary line in the branch's language, English underneath — skipped when they're the same. */
function bi(primary: string, english: string): string {
  return `<span class="t-primary">${esc(primary)}</span>${
    primary === english ? '' : `<span class="t-secondary">${esc(english)}</span>`
  }`;
}

function fmtDate(d: string | null, tz: string, langTag: string): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat(langTag, { timeZone: tz, dateStyle: 'medium' }).format(new Date(d));
}

/** Presentation only — never touches the stored accounting currency/amounts. Node's ICU data
 *  has no narrow KZT symbol for most locales, so Intl's currency style prints the "KZT" code;
 *  the tenge sign is appended by hand instead, in the same trailing position ₽/€ already use. */
function money(v: number, currency: string, langTag: string): string {
  if (currency === 'KZT') {
    return `${new Intl.NumberFormat(langTag, { maximumFractionDigits: 2 }).format(v)} ₸`;
  }
  return new Intl.NumberFormat(langTag, { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
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
.t-primary { display: block; }
.t-secondary { display: block; color: var(--gsi-color-text-muted); font-size: 0.85em; }
/* Letterhead: the official wordmark on white, as on the company's own stationery. */
.letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.letterhead .brand img { height: 58px; }
.brand-sub { font-size: 8pt; color: var(--gsi-color-text-muted); margin-top: 4px; }
.letterhead .contacts { text-align: right; font-size: 7.5pt; color: var(--gsi-color-text-muted); max-width: 45%; }
.accent-rule {
  height: 3px; margin: 10px 0 16px; border-radius: 2px;
  background: linear-gradient(90deg, var(--gsi-color-primary), var(--gsi-color-accent));
}

.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 19pt; color: var(--gsi-color-primary); letter-spacing: 0.02em; }
h1 .t-secondary { font-size: 10pt; letter-spacing: 0.08em; }
.meta { border-collapse: collapse; font-size: 9pt; }
.meta th { text-align: left; padding: 2px 10px 2px 0; color: var(--gsi-color-text-muted); font-weight: var(--gsi-font-weight-medium); }
.meta td { padding: 2px 0; font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); }
.meta .t-primary, .meta .t-secondary { display: inline; }
.meta .t-secondary::before { content: ' / '; }

.party { border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); padding: 10px 12px; min-width: 45%; }
.party .label { font-size: 8pt; color: var(--gsi-color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.party .name { font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); margin-top: 3px; font-size: 11pt; }
.party .line { font-size: 8.5pt; color: var(--gsi-color-text-muted); }

table.lines { width: 100%; border-collapse: collapse; margin-top: 4px; }
table.lines th {
  background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  text-align: left; padding: 6px 8px; font-size: 8.5pt; font-weight: var(--gsi-font-weight-medium);
}
table.lines th .t-secondary { color: var(--gsi-color-on-primary); opacity: 0.75; }
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
  const T = termsFor(d.branch.locale);
  const tz = d.branch.timezone;
  const c = d.invoice.currency;
  const due = d.invoice.amountTotal - d.invoice.amountPaid;
  const service = d.invoice.serviceType ? SERVICE_TYPE_LABELS[d.invoice.serviceType] : null;
  const watermark =
    d.invoice.status === 'cancelled' ? T.cancelled : d.invoice.status === 'draft' ? T.draft : null;

  return `<!doctype html>
<html lang="${esc(d.branch.locale)}"><head><meta charset="utf-8" /><title>${esc(d.invoice.invoiceNumber)}</title>
<style>${toCssVariables()}\n${CSS}</style></head>
<body>
${watermark ? `<div class="watermark">${esc(watermark)}</div>` : ''}

<header class="letterhead">
  <div class="brand">
    <img src="${d.organization.logoUrl?.startsWith('data:') ? d.organization.logoUrl : logoDataUri('logo-wordmark.png')}" alt="${esc(d.organization.name)}" />
    <div class="brand-sub">${esc(d.branch.legalName)}</div>
  </div>
  <div class="contacts">
    ${esc(d.branch.address)}<br />
    ${[d.branch.phone, d.branch.email, d.branch.website].filter(Boolean).map(esc).join(' · ')}
  </div>
</header>
<div class="accent-rule"></div>

<div class="head">
  <div>
    <h1>${bi(T.title, EN.title)}</h1>
  </div>
  <table class="meta">
    <tr><th>${bi(T.invoiceNo, EN.invoiceNo)}</th><td>${esc(d.invoice.invoiceNumber)}</td></tr>
    <tr><th>${bi(T.issueDate, EN.issueDate)}</th><td>${esc(fmtDate(d.invoice.issueDate, tz, T.langTag))}</td></tr>
    <tr><th>${bi(T.dueDate, EN.dueDate)}</th><td>${esc(fmtDate(d.invoice.dueDate, tz, T.langTag))}</td></tr>
    ${d.invoice.jobNumber ? `<tr><th>${bi(T.jobRef, EN.jobRef)}</th><td>${esc(d.invoice.jobNumber)}</td></tr>` : ''}
  </table>
</div>

<div class="party">
  <div class="label">${bi(T.billTo, EN.billTo)}</div>
  <div class="name">${esc(d.client.name)}</div>
  ${d.client.address ? `<div class="line">${esc(d.client.address)}</div>` : ''}
  ${d.client.taxId ? `<div class="line">${esc(T.taxId)} / ${esc(EN.taxId)}: ${esc(d.client.taxId)}</div>` : ''}
  ${d.client.gaftaFosfaRef ? `<div class="line">GAFTA / FOSFA: ${esc(d.client.gaftaFosfaRef)}</div>` : ''}
</div>

<table class="lines">
  <thead>
    <tr>
      <th>#</th>
      <th>${bi(T.description, EN.description)}</th>
      <th class="num">${bi(T.qty, EN.qty)}</th>
      <th class="num">${bi(T.unitPrice, EN.unitPrice)}</th>
      <th class="num">${bi(T.amount, EN.amount)}</th>
    </tr>
  </thead>
  <tbody>
    ${d.lines
      .map(
        (l, i) => `<tr>
          <td>${i + 1}</td>
          <td>${esc(l.description)}${
            service && i === 0
              ? `<div class="t-secondary">${esc(localize(service, d.branch.locale))}</div>`
              : ''
          }</td>
          <td class="num">${l.quantity}</td>
          <td class="num">${esc(money(l.unitPrice, c, T.langTag))}</td>
          <td class="num">${esc(money(l.amount, c, T.langTag))}</td>
        </tr>`,
      )
      .join('')}
  </tbody>
</table>

<div class="totals">
  <table>
    <tr><th>${bi(T.subtotal, EN.subtotal)}</th><td>${esc(money(d.invoice.amountNet, c, T.langTag))}</td></tr>
    <tr><th>${bi(T.vat, EN.vat)} ${d.invoice.taxRate}%</th><td>${esc(money(d.invoice.taxAmount, c, T.langTag))}</td></tr>
    <tr class="grand"><th>${bi(T.total, EN.total)}</th><td>${esc(money(d.invoice.amountTotal, c, T.langTag))}</td></tr>
    ${d.invoice.amountPaid > 0 ? `<tr><th>${bi(T.paid, EN.paid)}</th><td>${esc(money(d.invoice.amountPaid, c, T.langTag))}</td></tr>` : ''}
    ${due > 0.001 ? `<tr class="due"><th>${bi(T.due, EN.due)}</th><td>${esc(money(due, c, T.langTag))}</td></tr>` : ''}
  </table>
</div>

<div class="blocks">
  <div class="block">
    <div class="label">${bi(T.payment, EN.payment)}</div>
    <div>${esc(T.bankTbc)}</div>
    ${T.bankTbc !== EN.bankTbc ? `<div class="t-secondary">${esc(EN.bankTbc)}</div>` : ''}
  </div>
  <div class="block">
    <div class="label">${bi(T.terms, EN.terms)}</div>
    <div>${esc(T.termsText)}</div>
    ${T.termsText !== EN.termsText ? `<div class="t-secondary">${esc(EN.termsText)}</div>` : ''}
  </div>
</div>

${d.invoice.notes ? `<div class="block" style="margin-top:14px">${esc(d.invoice.notes)}</div>` : ''}
</body></html>`;
}

function footer(d: InvoiceTemplateData): string {
  const T = termsFor(d.branch.locale);
  const c = tokens.color;
  return `<div style="box-sizing:border-box; width:100%; padding:0 14mm; font-family:${tokens.font.family.replace(/"/g, "'")}; font-size:7pt; color:${c.textMuted};">
    <div style="display:flex; justify-content:space-between; border-top:1px solid ${c.border}; padding-top:4px;">
      <span>${esc(d.invoice.invoiceNumber)} · ${esc(d.branch.legalName)}</span>
      <span>${esc(T.page)}${T.page !== EN.page ? ` / ${esc(EN.page)}` : ''} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  </div>`;
}

export const invoiceTemplate = { id: 'invoice-generic', html, footer };

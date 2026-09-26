import { localize, SERVICE_TYPE_LABELS } from '@gsi/shared-types';
import { tokens, toCssVariables } from '@gsi/ui-kit';
import { logoDataUri } from './brand';
import type { InvoiceTemplateData } from './types';

/**
 * Kazakhstan invoice (migration 028_fiscal_compliance.sql). Selected by invoice-pdf.service.ts
 * whenever an invoice carries a fiscal snapshot for jurisdictionCountryCode 'KZ' — every other
 * country keeps rendering through invoice-default.ts, completely unchanged.
 *
 * Renders exactly what the immutable fiscalSnapshot says was charged: seller/buyer BIN/IIN,
 * the tax code actually applied (16% / 0% / без НДС — never a generic "VAT X%"), the supply
 * date, and the legal entity's own bank details instead of the TR/EN template's placeholder.
 * The e-invoice line states the current esfStatus plainly; it is never printed as a registered
 * ЭСФ unless that status really is 'registered' with a registration number set by an operator
 * (see EsfService — nothing here or in the API simulates that).
 */

const T = {
  title: ['СЧЕТ-ФАКТУРА', 'INVOICE'],
  invoiceNo: ['Номер счета', 'Invoice No'],
  issueDate: ['Дата выписки', 'Issue Date'],
  supplyDate: ['Дата поставки', 'Supply Date'],
  dueDate: ['Срок оплаты', 'Due Date'],
  seller: ['Продавец', 'Seller'],
  buyer: ['Покупатель', 'Buyer'],
  bin: ['БИН/ИИН', 'BIN/IIN'],
  vatReg: ['Рег. номер НДС', 'VAT reg. no'],
  jobRef: ['Referансы работы', 'Job Reference'],
  service: ['Услуга', 'Service'],
  description: ['Описание', 'Description'],
  qty: ['Кол-во', 'Qty'],
  unitPrice: ['Цена за ед.', 'Unit Price'],
  amount: ['Сумма', 'Amount'],
  subtotal: ['Итого без НДС', 'Subtotal (excl. VAT)'],
  tax: ['Налог', 'Tax'],
  total: ['Итого к оплате', 'Total'],
  paid: ['Оплачено', 'Paid'],
  due: ['Остаток к оплате', 'Balance Due'],
  payment: ['Банковские реквизиты', 'Bank Details'],
  bankMissing: ['Реквизиты не указаны', 'Bank details not on file'],
  eInvoice: ['Электронный счет-фактура (ЭСФ)', 'Electronic invoice (ESF)'],
  esfStatus: {
    not_required: ['не требуется', 'not required'],
    draft: ['черновик — ещё не подана', 'draft — not yet submitted'],
    ready: ['готова к подаче', 'ready to submit'],
    submitted: ['подана', 'submitted'],
    registered: ['зарегистрирована в ИС ЭСФ', 'registered in ИС ЭСФ'],
    corrected: ['подана исправленная форма', 'corrected form submitted'],
    additional: ['подана дополнительная форма', 'additional form submitted'],
    cancelled: ['аннулирована', 'cancelled'],
  } as Record<string, readonly [string, string]>,
  terms: ['Условия оплаты', 'Payment Terms'],
  termsText: [
    'Оплата производится в срок, указанный в счете. Пожалуйста, укажите номер счета в назначении платежа.',
    'Payment is due within the stated term. Please quote the invoice number with your transfer.',
  ],
  cancelled: ['АННУЛИРОВАН', 'CANCELLED'],
  draft: ['ЧЕРНОВИК', 'DRAFT'],
  page: ['Страница', 'Page'],
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
  return `<span class="ru">${esc(pair[0])}</span><span class="en">${esc(pair[1])}</span>`;
}

function fmtDate(d: string | null, tz: string): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'medium' }).format(new Date(d));
}

function money(v: number, currency: string): string {
  return new Intl.NumberFormat('ru-KZ', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
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
.ru { display: block; }
.en { display: block; color: var(--gsi-color-text-muted); font-size: 0.85em; }
.letterhead { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.letterhead .brand img { height: 58px; }
.brand-sub { font-size: 8pt; color: var(--gsi-color-text-muted); margin-top: 4px; }
.letterhead .contacts { text-align: right; font-size: 7.5pt; color: var(--gsi-color-text-muted); max-width: 45%; }
.accent-rule {
  height: 3px; margin: 10px 0 16px; border-radius: 2px;
  background: linear-gradient(90deg, var(--gsi-color-primary), var(--gsi-color-accent));
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 17pt; color: var(--gsi-color-primary); letter-spacing: 0.01em; }
h1 .en { font-size: 9.5pt; letter-spacing: 0.06em; }
.meta { border-collapse: collapse; font-size: 9pt; }
.meta th { text-align: left; padding: 2px 10px 2px 0; color: var(--gsi-color-text-muted); font-weight: var(--gsi-font-weight-medium); }
.meta td { padding: 2px 0; font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); }
.meta .ru, .meta .en { display: inline; }
.meta .en::before { content: ' / '; }
.parties { display: flex; gap: 14px; }
.party { border: 1px solid var(--gsi-color-border); border-radius: var(--gsi-radius-sm); padding: 10px 12px; flex: 1; }
.party .label { font-size: 8pt; color: var(--gsi-color-text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.party .name { font-weight: var(--gsi-font-weight-bold); color: var(--gsi-color-primary); margin-top: 3px; font-size: 10.5pt; }
.party .line { font-size: 8.5pt; color: var(--gsi-color-text-muted); }
.badge { display: inline-block; font-size: 7.5pt; padding: 1px 6px; border-radius: 999px; margin-top: 4px;
  background: var(--gsi-color-surface-muted); color: var(--gsi-color-text-muted); }
table.lines { width: 100%; border-collapse: collapse; margin-top: 12px; }
table.lines th {
  background: var(--gsi-color-primary); color: var(--gsi-color-on-primary);
  text-align: left; padding: 6px 8px; font-size: 8.5pt; font-weight: var(--gsi-font-weight-medium);
}
table.lines th .en { color: var(--gsi-color-on-primary); opacity: 0.75; }
table.lines th.num, table.lines td.num { text-align: right; }
table.lines td { border-bottom: 1px solid var(--gsi-color-border); padding: 7px 8px; vertical-align: top; }
.totals { margin-top: 14px; display: flex; justify-content: flex-end; }
.totals table { border-collapse: collapse; min-width: 66mm; }
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
  const s = d.fiscalSnapshot;
  const due = d.invoice.amountTotal - d.invoice.amountPaid;
  const service = d.invoice.serviceType ? SERVICE_TYPE_LABELS[d.invoice.serviceType] : null;
  const watermark = d.invoice.status === 'cancelled' ? T.cancelled : d.invoice.status === 'draft' ? T.draft : null;
  const seller = s?.legalEntity;
  const buyer = s?.buyer;
  const esfKey = d.invoice.esfStatus ?? 'not_required';
  const esfLabel = T.esfStatus[esfKey] ?? T.esfStatus.not_required;
  const bank = seller?.bankName || seller?.bankAccount
    ? [seller?.bankName, seller?.bankAccount, seller?.bankSwift].filter(Boolean).map(esc).join(' · ')
    : null;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" /><title>${esc(d.invoice.invoiceNumber)}</title>
<style>${toCssVariables()}\n${CSS}</style></head>
<body>
${watermark ? `<div class="watermark">${esc(watermark[0])} / ${esc(watermark[1])}</div>` : ''}

<header class="letterhead">
  <div class="brand">
    <img src="${d.organization.logoUrl?.startsWith('data:') ? d.organization.logoUrl : logoDataUri('logo-wordmark.png')}" alt="${esc(d.organization.name)}" />
    <div class="brand-sub">${esc(seller?.legalName ?? d.branch.legalName)}</div>
  </div>
  <div class="contacts">
    ${esc(seller?.legalAddress ?? d.branch.address)}<br />
    ${[d.branch.phone, d.branch.email, d.branch.website].filter(Boolean).map(esc).join(' · ')}
  </div>
</header>
<div class="accent-rule"></div>

<div class="head">
  <div><h1>${bi(T.title)}</h1></div>
  <table class="meta">
    <tr><th>${bi(T.invoiceNo)}</th><td>${esc(d.invoice.invoiceNumber)}</td></tr>
    <tr><th>${bi(T.issueDate)}</th><td>${esc(fmtDate(d.invoice.issueDate, tz))}</td></tr>
    <tr><th>${bi(T.supplyDate)}</th><td>${esc(fmtDate(s?.supplyDate ?? d.invoice.issueDate, tz))}</td></tr>
    <tr><th>${bi(T.dueDate)}</th><td>${esc(fmtDate(d.invoice.dueDate, tz))}</td></tr>
    ${d.invoice.jobNumber ? `<tr><th>${bi(T.jobRef)}</th><td>${esc(d.invoice.jobNumber)}</td></tr>` : ''}
  </table>
</div>

<div class="parties">
  <div class="party">
    <div class="label">${esc(T.seller[0])} / ${esc(T.seller[1])}</div>
    <div class="name">${esc(seller?.legalName ?? d.branch.legalName)}</div>
    ${seller?.legalAddress ? `<div class="line">${esc(seller.legalAddress)}</div>` : ''}
    ${seller?.fiscalIdentifier ? `<div class="line">${esc(T.bin[0])} / ${esc(T.bin[1])}: ${esc(seller.fiscalIdentifier)}</div>` : ''}
    ${seller?.vatRegistered && seller.vatRegistrationNumber
      ? `<div class="line">${esc(T.vatReg[0])} / ${esc(T.vatReg[1])}: ${esc(seller.vatRegistrationNumber)}</div>`
      : `<span class="badge">${seller?.vatRegistered ? 'НДС / VAT' : 'Без НДС / Non-VAT'}</span>`}
  </div>
  <div class="party">
    <div class="label">${esc(T.buyer[0])} / ${esc(T.buyer[1])}</div>
    <div class="name">${esc(buyer?.name ?? d.client.name)}</div>
    ${(buyer?.address ?? d.client.address) ? `<div class="line">${esc(buyer?.address ?? d.client.address)}</div>` : ''}
    ${(buyer?.fiscalIdentifier ?? d.client.taxId) ? `<div class="line">${esc(T.bin[0])} / ${esc(T.bin[1])}: ${esc(buyer?.fiscalIdentifier ?? d.client.taxId)}</div>` : ''}
  </div>
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
            service && i === 0 ? `<div class="en">${esc(localize(service, 'ru'))} / ${esc(localize(service, 'en'))}</div>` : ''
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
    <tr><th>${bi(T.tax)}${s ? ` — ${esc(s.taxCodeLabel)}` : ` ${d.invoice.taxRate}%`}</th><td>${esc(money(d.invoice.taxAmount, c))}</td></tr>
    <tr class="grand"><th>${bi(T.total)}</th><td>${esc(money(d.invoice.amountTotal, c))}</td></tr>
    ${d.invoice.amountPaid > 0 ? `<tr><th>${bi(T.paid)}</th><td>${esc(money(d.invoice.amountPaid, c))}</td></tr>` : ''}
    ${due > 0.001 ? `<tr class="due"><th>${bi(T.due)}</th><td>${esc(money(due, c))}</td></tr>` : ''}
  </table>
</div>

<div class="blocks">
  <div class="block">
    <div class="label">${esc(T.payment[0])} / ${esc(T.payment[1])}</div>
    <div>${bank ?? bi(T.bankMissing)}</div>
  </div>
  <div class="block">
    <div class="label">${esc(T.eInvoice[0])} / ${esc(T.eInvoice[1])}</div>
    <div>${esc(esfLabel[0])} / ${esc(esfLabel[1])}</div>
  </div>
</div>

<div class="blocks">
  <div class="block" style="grid-column: 1 / -1;">
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
      <span>${esc(d.invoice.invoiceNumber)} · ${esc(d.fiscalSnapshot?.legalEntity.legalName ?? d.branch.legalName)}</span>
      <span>${T.page[0]} / ${T.page[1]} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>
  </div>`;
}

export const invoiceKzTemplate = { id: 'invoice-kz', html, footer };

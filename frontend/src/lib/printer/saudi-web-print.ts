/**
 * FactorPOS: Saudi simplified tax invoice (فاتورة ضريبية مبسطة) for browser printing.
 * Mirrors main/printers/document-saudi.ts. The ZATCA QR image comes from the
 * backend (GET /api/bills/:id/zatca-qr), which owns the TLV payload.
 */
import type { Bill } from '@/lib/types';
import { isExcludedFromBillReceipt } from '../../../../shared/order-item-status';
import { parseDbTimestamp } from '@/lib/utils';

export const SAUDI_TITLE_AR = 'فاتورة ضريبية مبسطة';
export const SAUDI_TITLE_EN = 'Simplified Tax Invoice';

export interface SaudiWebInvoiceOptions {
  paperSize?: 'thermal58' | 'thermal80';
  businessName?: string;
  address?: string;
  phone?: string;
  vatNumber?: string;
  footerNote?: string;
  timezone?: string;
  showTableNumber?: boolean;
  isReprint?: boolean;
  /** PNG data URL of the ZATCA QR, or null when the VAT number is missing. */
  qrDataUrl: string | null;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function halalas(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function issueDate(timestamp: string, timezone: string): string {
  const date = parseDbTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Riyadh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Meta row: English label with the Arabic label beneath, value kept on one line. */
function meta(en: string, ar: string, value: unknown): string {
  return `<tr><td class="label">${esc(en)}<div class="ar" dir="rtl">${esc(ar)}</div></td><td class="value" dir="ltr">${esc(value)}</td></tr>`;
}

/** Two-language label: English left, Arabic right. */
function pair(en: string, ar: string, amount: string, cls = ''): string {
  return `<tr class="${cls}"><td>${esc(en)}<div class="ar" dir="rtl">${esc(ar)}</div></td><td class="num">${esc(amount)}</td></tr>`;
}

export function generateSaudiBillHtml(bill: Bill, opts: SaudiWebInvoiceOptions): string {
  const raw = bill as unknown as Record<string, unknown>;
  const order = bill.order;
  const width = opts.paperSize === 'thermal58' ? '58mm' : '80mm';
  const items = (order?.items ?? []).filter((item) => !isExcludedFromBillReceipt(item?.status));
  const vat = halalas(bill.tax_amount);
  const payable = halalas(bill.total);
  const roundOff = halalas(bill.round_off);
  const withVat = payable - roundOff;
  const beforeVat = withVat - vat;
  const rate = beforeVat > 0 ? (vat / beforeVat) * 100 : 0;
  const roundedRate = Math.round(rate);
  const vatLabel =
    beforeVat > 0 && Math.abs(rate - roundedRate) < 0.1 ? `VAT ${roundedRate}%` : 'VAT';
  const discount = halalas(bill.discount_amount);
  const charges: Array<[string, string, number]> = [
    ['Service charge', 'رسوم الخدمة', halalas(bill.service_charge)],
    ['Packaging', 'التغليف', halalas(bill.packaging_charge)],
    ['Delivery', 'التوصيل', halalas(bill.delivery_charge)],
  ];
  const issuedAt = String(raw.paid_at || raw.created_at || order?.created_at || '');
  const vatNumber = (opts.vatNumber ?? '').trim();

  const itemRows = items
    .map((item) => {
      const name = item.variant_selection?.name
        ? `${item.product_name} (${item.variant_selection.name})`
        : item.product_name;
      const addons = (item.addons ?? [])
        .filter((addon) => addon?.name)
        .map((addon) => `<div class="addon">+ ${esc(addon.name)}</div>`)
        .join('');
      return `<tr><td>${esc(name)}${addons}</td><td class="num">${esc(item.quantity)}</td><td class="num">${money(halalas(item.unit_price))}</td><td class="num">${money(halalas(item.total))}</td></tr>`;
    })
    .join('');

  const extraRows =
    discount !== 0 || charges.some(([, , amount]) => amount !== 0)
      ? pair('Items total', 'إجمالي الأصناف', money(halalas(bill.subtotal))) +
        (discount !== 0 ? pair('Discount', 'الخصم', `-${money(discount)}`) : '') +
        charges
          .filter(([, , amount]) => amount !== 0)
          .map(([en, ar, amount]) => pair(en, ar, money(amount)))
          .join('')
      : '';

  const payments = (bill.payment_details ?? [])
    .map(
      (payment) =>
        `<tr><td>${esc(payment.method.charAt(0).toUpperCase() + payment.method.slice(1).replace(/_/g, ' '))}</td><td class="num">${money(halalas(payment.amount))}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ar" dir="ltr">
<head>
<meta charset="UTF-8">
<title>${esc(SAUDI_TITLE_EN)} ${esc(bill.bill_number)}</title>
<style>
  @page { size: ${width} auto; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${width}; margin: 0 auto; color: #000; font-family: -apple-system, 'Segoe UI', Tahoma, 'Noto Naskh Arabic', Arial, sans-serif; font-size: ${opts.paperSize === 'thermal58' ? '11px' : '13px'}; font-weight: 600; line-height: 1.35; }
  .bill { padding: 3mm; }
  .center { text-align: center; }
  h1 { font-size: 1.35em; font-weight: 800; }
  .title { border-top: 1px solid #000; border-bottom: 1px solid #000; margin: 6px 0; padding: 4px 0; font-weight: 800; }
  .reprint { border: 2px solid #000; text-align: center; font-weight: 800; padding: 3px; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 2px 0; vertical-align: top; }
  th { text-align: start; border-bottom: 1px solid #000; }
  .num { text-align: end; white-space: nowrap; padding-inline-start: 6px; }
  .items td { border-bottom: 1px dashed #000; }
  .addon { font-size: 0.9em; padding-inline-start: 8px; }
  .ar { font-family: 'Noto Naskh Arabic', Tahoma, 'Segoe UI', sans-serif; font-size: 0.85em; font-weight: 600; text-align: start; }
  .title .ar { font-size: 1.25em; font-weight: 800; text-align: center; }
  .meta td.value { text-align: end; white-space: nowrap; vertical-align: top; }
  .meta td.label, .totals td:first-child { width: 100%; }
  .vat-no { white-space: nowrap; }
  .meta .ar, .totals .ar { text-align: left; }
  .totals { margin-top: 6px; }
  .grand td { border-top: 2px solid #000; font-size: 1.2em; font-weight: 800; padding-top: 4px; }
  .qr { display: block; width: 38mm; height: 38mm; margin: 8px auto 4px; image-rendering: pixelated; }
  .note { font-size: 0.9em; margin-top: 6px; }
</style>
</head>
<body>
<div class="bill">
  ${opts.isReprint ? '<div class="reprint">REPRINT / إعادة طباعة</div>' : ''}
  <div class="center">
    ${opts.businessName ? `<h1>${esc(opts.businessName)}</h1>` : ''}
    ${opts.address ? `<div>${esc(opts.address).replace(/\n/g, '<br>')}</div>` : ''}
    ${opts.phone ? `<div>Tel: <span dir="ltr">${esc(opts.phone)}</span></div>` : ''}
    ${vatNumber ? `<div class="vat-no"><strong>VAT No:</strong> <span dir="ltr">${esc(vatNumber)}</span></div><div class="ar" dir="rtl" style="text-align:center">الرقم الضريبي: <span dir="ltr">${esc(vatNumber)}</span></div>` : ''}
  </div>
  <div class="title center"><div class="ar" dir="rtl">${SAUDI_TITLE_AR}</div><div>${SAUDI_TITLE_EN.toUpperCase()}</div></div>
  <table class="meta">
    ${meta('Invoice No', 'رقم الفاتورة', bill.bill_number)}
    ${meta('Date', 'التاريخ', issueDate(issuedAt, opts.timezone ?? ''))}
    ${order?.order_number ? meta('Order No', 'رقم الطلب', order.order_number) : ''}
    ${opts.showTableNumber !== false && order?.table?.name ? meta('Table', 'الطاولة', order.table.name) : ''}
  </table>
  <table class="items" style="margin-top:6px">
    <tr><th>Item / الصنف</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr>
    ${itemRows}
  </table>
  <table class="totals">
    ${extraRows}
    ${pair('Total excl. VAT', 'الإجمالي غير شامل الضريبة', money(beforeVat))}
    ${pair(vatLabel, 'ضريبة القيمة المضافة', money(vat))}
    ${pair('Total incl. VAT', 'الإجمالي شامل الضريبة', `SAR ${money(withVat)}`, 'grand')}
    ${roundOff !== 0 ? pair('Round-off', 'التقريب', money(roundOff)) + pair('Amount payable', 'المبلغ المستحق', `SAR ${money(payable)}`) : ''}
  </table>
  ${payments ? `<table style="margin-top:6px">${payments}</table>` : ''}
  ${
    opts.qrDataUrl
      ? `<img class="qr" src="${esc(opts.qrDataUrl)}" alt="ZATCA QR">`
      : '<div class="center note">Add the VAT number in Settings to print the ZATCA QR</div>'
  }
  ${opts.footerNote ? `<div class="center note">${esc(opts.footerNote).replace(/\n/g, '<br>')}</div>` : ''}
</div>
</body>
</html>`;
}

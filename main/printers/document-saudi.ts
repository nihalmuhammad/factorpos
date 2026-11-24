/**
 * FactorPOS: Saudi simplified tax invoice (فاتورة ضريبية مبسطة) for thermal printers.
 *
 * A FactorPOS-owned core bill template ('saudi'). It prints what a ZATCA simplified
 * tax invoice needs: seller name and address, seller VAT number, the
 * "Simplified Tax Invoice" title in Arabic and English, invoice number, issue date
 * and time, items, amount before VAT, VAT, total with VAT, and the ZATCA QR code
 * (TLV tags 1–5, see shared/print/zatca-qr.ts).
 *
 * Arabic lines print through the printer's raster mode when it is on, or as text
 * when the printer can represent Arabic (Arabic shaping); otherwise they are left
 * out so the bill never prints "????".
 */
import { parseDbTimestamp } from '../db';
import type { PrinterCutMode } from './profiles';
import {
  isThermalTextRepresentable,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';
import {
  concatBytes,
  encodeGsV0Band,
  rasterCapabilityEnabled,
  type RasterSemanticLineGroup,
} from '../../shared/print/raster';
import { displayCellWidth, padToDisplayCells } from '../../shared/print/width';
import { getLogoRasterBands } from '../../shared/print/image-raster';
import type { PrintWarning } from '../../shared/print';
import { isExcludedFromBillReceipt } from '../../shared/order-item-status';
import {
  buildEscPos,
  formatVariantItemHeading,
  normalizeThermalText,
  parseVariantSelection,
  wrapText,
} from './formatting-helpers';
import {
  encodeZatcaQr,
  zatcaQrFieldsForBill,
  ZATCA_PREVIEW_BANNER_AR,
  ZATCA_PREVIEW_BANNER_EN,
  ZATCA_PREVIEW_ONLY,
} from '../../shared/print/zatca-qr';

export const SAUDI_INVOICE_TITLE_AR = 'فاتورة ضريبية مبسطة';
export const SAUDI_INVOICE_TITLE_EN = 'SIMPLIFIED TAX INVOICE';

export interface SaudiReceiptOptions {
  columns: number;
  isReprint: boolean;
  useUnicode: boolean;
  arabicShaping: boolean;
  cutMode: PrinterCutMode;
  capabilities?: ThermalPrinterCapabilities;
  /** Draw Arabic lines as raster groups (the raster pipeline renders them). */
  rasterArabic?: boolean;
  rasterGroups?: RasterSemanticLineGroup[];
}

export interface SaudiReceiptResult {
  lines: string[];
  data: Buffer;
  warnings: PrintWarning[];
  rasterGroups: RasterSemanticLineGroup[];
  /** The Base64 TLV the QR carries, or null when the VAT number or date is missing. */
  qrPayload: string | null;
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function halalas(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ') : text;
}

function parsePayments(raw: unknown): Array<{ method: string; amount: number }> {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
    )
    .map((entry) => ({ method: String(entry.method ?? ''), amount: halalas(entry.amount) }));
}

/** dd/mm/yyyy HH:mm:ss in the shop's time zone, Latin digits. */
function formatIssueDate(dbTimestamp: string, timezone: string): string {
  const date = parseDbTimestamp(dbTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  const tz = timezone || 'Asia/Riyadh';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
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

/** Native ESC/POS QR (model 2, module size 6, error correction M), centred. */
export function saudiQrEscPos(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const pL = (data.length + 3) & 0xff;
  const pH = ((data.length + 3) >> 8) & 0xff;
  return Buffer.concat([
    Buffer.from([0x1b, 0x61, 0x01]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]),
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    Buffer.from([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]),
    data,
    Buffer.from([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    Buffer.from([0x0a]),
    Buffer.from([0x1b, 0x61, 0x00]),
  ]);
}

function row(left: string, right: string, cols: number): string {
  const gap = cols - displayCellWidth(left) - displayCellWidth(right);
  return gap >= 1 ? left + ' '.repeat(gap) + right : `${left} ${right}`;
}

/** Builds the token lines for the Saudi simplified tax invoice. */
export function renderSaudiReceiptLines(
  order: any,
  bill: any,
  business: any,
  options: SaudiReceiptOptions,
): { lines: string[]; qrPayload: string | null } {
  const cols = Math.max(24, options.columns);
  const capabilities = options.capabilities;
  const normalize = (text: string) =>
    capabilities ? normalizeThermalText(text, capabilities) : text;
  const canPrintArabic =
    options.rasterArabic === true ||
    (capabilities !== undefined &&
      isThermalTextRepresentable(SAUDI_INVOICE_TITLE_AR, {
        ...capabilities,
        raster: { ...capabilities.raster, enabled: false },
      })) ||
    (capabilities === undefined && options.arabicShaping);
  const lines: string[] = [];
  const dash = '-'.repeat(cols);
  const groups = options.rasterGroups;
  /** Fixed Arabic labels are skipped on printers that cannot print Arabic; shop data
   * (names, items) still prints there the way FloCafe prints it. */
  const pushArabicAware = (line: string, plain: string, optional = true) => {
    if (ARABIC_RE.test(plain)) {
      if (!canPrintArabic) {
        if (!optional) lines.push(line);
        return;
      }
      if (options.rasterArabic && groups) {
        groups.push({
          groupId: `saudi-ar-${lines.length}`,
          lineIndex: lines.length,
          lineCount: 1,
          sourceLines: [plain],
          sourceControlLines: [line],
        });
      }
    }
    lines.push(line);
  };
  const center = (text: string, styles: string[] = [], optional = true) => {
    const open = styles.map((style) => `{${style}}`).join('');
    const close = [...styles]
      .reverse()
      .map((style) => `{/${style}}`)
      .join('');
    pushArabicAware(`{CENTER}${open}${normalize(text)}${close}{/CENTER}`, text, optional);
  };

  lines.push('{INIT}');
  if (options.isReprint) lines.push('{CENTER}{BOLD}** REPRINT / إعادة طباعة **{/BOLD}{/CENTER}');

  const logoRaster =
    typeof business?.receipt_logo_raster === 'string' ? business.receipt_logo_raster : '';
  if (
    business?.show_logo === true &&
    logoRaster &&
    capabilities &&
    rasterCapabilityEnabled(capabilities)
  ) {
    const widthDots = capabilities.raster.widthDots ?? (cols <= 32 ? 384 : 576);
    const maxBandHeight = capabilities.raster.maxBandHeight ?? 200;
    const bands = getLogoRasterBands(logoRaster, widthDots, maxBandHeight);
    if (bands.length > 0) {
      const raw = concatBytes(bands.map((band) => encodeGsV0Band(band, maxBandHeight)));
      lines.push(`{RAW_BYTES:${Buffer.from(raw).toString('base64')}}`);
    }
  }

  const sellerName = String(business?.name ?? '').trim();
  if (sellerName) {
    for (const part of ARABIC_RE.test(sellerName)
      ? [sellerName]
      : wrapText(sellerName, Math.floor(cols / 2)))
      center(part, ['BOLD', 'DOUBLE_HEIGHT'], false);
  }
  const address = String(business?.address ?? '').trim();
  if (address) for (const part of address.split(/\r?\n/)) center(part, [], false);
  const phone = String(business?.phone ?? '').trim();
  if (phone) center(`Tel: ${phone}`);
  const vatNumber = String(business?.taxRegistrationNumber ?? '').trim();
  if (vatNumber) {
    center(`VAT No: ${vatNumber}`, ['BOLD']);
    center(`الرقم الضريبي: ${vatNumber}`);
  }
  lines.push(dash);
  center(SAUDI_INVOICE_TITLE_AR, ['BOLD']);
  center(SAUDI_INVOICE_TITLE_EN, ['BOLD']);
  if (ZATCA_PREVIEW_ONLY) {
    lines.push(dash);
    center(`** ${ZATCA_PREVIEW_BANNER_EN} **`, ['BOLD'], false);
    center(ZATCA_PREVIEW_BANNER_AR, ['BOLD']);
  }
  lines.push(dash);

  const issuedAt = String(bill?.paid_at || bill?.created_at || order?.created_at || '');
  lines.push(normalize(row('Invoice No:', String(bill?.bill_number ?? ''), cols)));
  const issueDate = formatIssueDate(issuedAt, String(business?.timezone ?? ''));
  if (issueDate) lines.push(normalize(row('Date:', issueDate, cols)));
  if (order?.order_number)
    lines.push(normalize(row('Order No:', String(order.order_number), cols)));
  if (business?.show_table_number !== false && order?.table?.name)
    lines.push(normalize(row('Table:', String(order.table.name), cols)));
  if (business?.show_customer_name !== false && business?.customer_name)
    lines.push(normalize(row('Customer:', String(business.customer_name), cols)));
  lines.push(dash);

  // Item rows: name | qty | total (and unit price on 40+ columns). Prices include VAT.
  const withPrice = cols >= 40;
  const qtyW = 4;
  const totalW = 10;
  const priceW = withPrice ? 9 : 0;
  const nameW = cols - qtyW - totalW - priceW;
  const header =
    padToDisplayCells('Item', nameW) +
    padToDisplayCells('Qty', qtyW, 'right') +
    (withPrice ? padToDisplayCells('Price', priceW, 'right') : '') +
    padToDisplayCells('Total', totalW, 'right');
  lines.push(header, dash);
  const items = (Array.isArray(order?.items) ? order.items : []).filter(
    (item: any) => !isExcludedFromBillReceipt(item?.status),
  );
  for (const item of items) {
    const name = formatVariantItemHeading(
      String(item?.product_name ?? ''),
      parseVariantSelection(item?.variant_selection),
    );
    const quantity = Number(item?.quantity) || 0;
    const unit = halalas(item?.unit_price ?? item?.price ?? 0);
    const total = halalas(item?.total);
    const tail =
      padToDisplayCells(String(quantity), qtyW, 'right') +
      (withPrice ? padToDisplayCells(money(unit), priceW, 'right') : '') +
      padToDisplayCells(money(total), totalW, 'right');
    if (ARABIC_RE.test(name)) {
      pushArabicAware(normalize(name), name, false);
      lines.push(' '.repeat(nameW) + tail);
    } else {
      const nameLines = wrapText(normalize(name), nameW - 1);
      lines.push(padToDisplayCells(nameLines[0] ?? '', nameW) + tail);
      for (const extra of nameLines.slice(1)) lines.push(extra);
    }
    for (const addon of Array.isArray(item?.addons) ? item.addons : []) {
      const addonName = String(addon?.name ?? '').trim();
      if (!addonName) continue;
      const addonQty = (typeof addon?.quantity === 'number' && addon.quantity) || 1;
      const addonTotal = halalas(addon?.price) * addonQty * quantity;
      const label = `  + ${addonName}`;
      pushArabicAware(
        addonTotal > 0 ? normalize(row(label, money(addonTotal), cols)) : normalize(label),
        label,
        false,
      );
    }
  }
  lines.push(dash);

  // Totals. FloCafe stores VAT-inclusive totals; the round-off is not taxable.
  const vat = halalas(bill?.tax_amount);
  const payable = halalas(bill?.total);
  const roundOff = halalas(bill?.round_off);
  const withVat = payable - roundOff;
  const beforeVat = withVat - vat;
  const discount = halalas(bill?.discount_amount);
  const charges: Array<[string, number]> = [
    ['Service charge', halalas(bill?.service_charge)],
    ['Packaging', halalas(bill?.packaging_charge)],
    ['Delivery', halalas(bill?.delivery_charge)],
  ];
  if (discount !== 0 || charges.some(([, amount]) => amount !== 0)) {
    lines.push(normalize(row('Items total', money(halalas(bill?.subtotal)), cols)));
    if (discount !== 0) lines.push(normalize(row('Discount', `-${money(discount)}`, cols)));
    for (const [label, amount] of charges)
      if (amount !== 0) lines.push(normalize(row(label, money(amount), cols)));
  }
  const rate = beforeVat > 0 ? (vat / beforeVat) * 100 : 0;
  const roundedRate = Math.round(rate);
  const vatLabel =
    beforeVat > 0 && Math.abs(rate - roundedRate) < 0.1 ? `VAT ${roundedRate}%` : 'VAT';
  lines.push(normalize(row('Total excl. VAT', money(beforeVat), cols)));
  pushArabicAware(
    normalize(row('الإجمالي غير شامل الضريبة', money(beforeVat), cols)),
    'الإجمالي غير شامل الضريبة',
  );
  lines.push(normalize(row(vatLabel, money(vat), cols)));
  pushArabicAware(normalize(row('ضريبة القيمة المضافة', money(vat), cols)), 'ضريبة القيمة المضافة');
  lines.push(dash);
  lines.push(
    `{BOLD}{DOUBLE_HEIGHT}${normalize(row('TOTAL incl. VAT', `SAR ${money(withVat)}`, cols))}{/DOUBLE_HEIGHT}{/BOLD}`,
  );
  pushArabicAware(
    `{BOLD}${normalize(row('الإجمالي شامل الضريبة', `SAR ${money(withVat)}`, cols))}{/BOLD}`,
    'الإجمالي شامل الضريبة',
  );
  if (roundOff !== 0) {
    lines.push(normalize(row('Round-off', money(roundOff), cols)));
    lines.push(`{BOLD}${normalize(row('Amount payable', `SAR ${money(payable)}`, cols))}{/BOLD}`);
  }
  const payments = parsePayments(bill?.payment_details);
  if (payments.length > 0) {
    lines.push(dash);
    for (const payment of payments)
      lines.push(normalize(row(capitalize(payment.method), money(payment.amount), cols)));
  }
  lines.push(dash);

  let qrPayload: string | null = null;
  if (vatNumber && sellerName && issuedAt) {
    try {
      qrPayload = encodeZatcaQr(zatcaQrFieldsForBill(bill, { name: sellerName, vatNumber }));
    } catch {
      qrPayload = null;
    }
  }
  if (qrPayload) {
    lines.push(`{RAW_BYTES:${saudiQrEscPos(qrPayload).toString('base64')}}`);
  } else {
    lines.push('{CENTER}Add the VAT number in Settings to print the ZATCA QR{/CENTER}');
  }

  const footer = String(business?.footer_note ?? '').trim();
  if (footer) {
    lines.push('');
    for (const part of footer.split(/\r?\n/)) center(part, [], false);
  }
  lines.push('', '{CUT}');
  return { lines, qrPayload };
}

/** Renders the Saudi simplified tax invoice to ESC/POS bytes (and raster lines). */
export function renderSaudiReceiptViaDocument(
  order: any,
  bill: any,
  business: any,
  opts: Omit<SaudiReceiptOptions, 'rasterArabic' | 'rasterGroups'>,
): SaudiReceiptResult {
  const warnings: PrintWarning[] = [];
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const rasterOn = opts.capabilities !== undefined && rasterCapabilityEnabled(opts.capabilities);
  const { lines, qrPayload } = renderSaudiReceiptLines(order, bill, business, {
    ...opts,
    rasterArabic: rasterOn,
    rasterGroups,
  });
  // Native bytes never carry raster-only Arabic lines: render again without raster.
  const nativeLines = rasterOn
    ? renderSaudiReceiptLines(order, bill, business, {
        ...opts,
        capabilities: {
          ...opts.capabilities!,
          raster: { ...opts.capabilities!.raster, enabled: false },
        },
        rasterArabic: false,
      }).lines
    : lines;
  const data = buildEscPos(
    nativeLines,
    opts.useUnicode,
    {
      cutMode: opts.cutMode,
      arabicShaping: opts.arabicShaping,
      columns: opts.columns,
      language: 'en',
      capabilities: opts.capabilities,
    },
    warnings,
  );
  return { lines, data, warnings, rasterGroups, qrPayload };
}

/**
 * FactorPOS monthly VAT invoice report.
 *
 * One workbook per month: every paid invoice with its VAT, every refund as a
 * credit note with its VAT, a per-day table and a summary for the VAT return.
 * Money is summed in minor units (halalas) so totals never drift from floats.
 * The report reads paid bills and refunds only; it never changes data.
 */
import type { Database } from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {
  dayBoundsInTimezone,
  getDatabase,
  localDateInTimezone,
  parseDbTimestamp,
  tenantBusinessDayStartTime,
} from '../db';
import { getCurrencyFractionDigits } from '../countries';
import { getTenantCurrency } from './refund';
import { formatStoreLocalDateTime } from '../../shared/business-date';
import { resolveExportTimezone } from './daily-sales-export';

/** `calendar`: midnight to midnight in the store timezone (the VAT tax point). `business_day`: the store's day-close cutoff. */
export type MonthlyVatBasis = 'calendar' | 'business_day';

export class MonthlyVatExportValidationError extends Error {}

export type MonthlyVatInvoiceRow = {
  invoice_number: string;
  invoice_date: string;
  day: string;
  order_number: string;
  token_number: number | null;
  order_type: string;
  payment_methods: string;
  items_subtotal: number;
  discount: number;
  charges: number;
  amount_before_vat: number;
  vat_amount: number;
  effective_vat_percent: number | null;
  total_with_vat: number;
  round_off: number;
  amount_payable: number;
  refunded_amount: number;
  payment_status: string;
};

export type MonthlyVatCreditNoteRow = {
  refund_id: number;
  refund_date: string;
  day: string;
  original_invoice_number: string;
  original_invoice_date: string;
  refunded_item: string;
  reason: string;
  method: string;
  amount_with_vat: number;
  vat_amount: number;
  amount_before_vat: number;
  /** How the refund VAT was derived: from the refunded item's VAT share, or the whole invoice's. */
  vat_basis: 'item_ratio' | 'invoice_ratio' | 'none';
};

export type MonthlyVatDailyRow = {
  day: string;
  invoice_count: number;
  amount_before_vat: number;
  vat_amount: number;
  total_with_vat: number;
  credit_note_count: number;
  credit_note_before_vat: number;
  credit_note_vat: number;
  net_vat: number;
};

export type MonthlyVatSummary = {
  month: string;
  from_date: string;
  to_date: string;
  basis: MonthlyVatBasis;
  timezone: string;
  business_day_start: string;
  currency: string;
  business_name: string;
  vat_registration_number: string;
  invoice_count: number;
  invoices_before_vat: number;
  invoices_vat: number;
  invoices_with_vat: number;
  credit_note_count: number;
  credit_notes_before_vat: number;
  credit_notes_vat: number;
  credit_notes_with_vat: number;
  net_before_vat: number;
  net_vat: number;
  net_with_vat: number;
  round_off_total: number;
};

export type MonthlyVatDataset = {
  summary: MonthlyVatSummary;
  invoices: MonthlyVatInvoiceRow[];
  creditNotes: MonthlyVatCreditNoteRow[];
  daily: MonthlyVatDailyRow[];
};

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Validates `YYYY-MM` and returns the first and last calendar date of the month. */
export function resolveMonthRange(month: unknown): {
  month: string;
  fromDate: string;
  toDate: string;
} {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    throw new MonthlyVatExportValidationError('month must be YYYY-MM');
  }
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    month,
    fromDate: `${month}-01`,
    toDate: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function resolveMonthlyVatBasis(value: unknown): MonthlyVatBasis {
  if (value === undefined || value === '' || value === 'calendar') return 'calendar';
  if (value === 'business_day') return 'business_day';
  throw new MonthlyVatExportValidationError('basis must be calendar or business_day');
}

function settingValue(db: Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value?: string | null }
    | undefined;
  return typeof row?.value === 'string' ? row.value : '';
}

function paymentMethodNames(paymentDetails: unknown, namesById: Map<number, string>): string {
  if (typeof paymentDetails !== 'string' || !paymentDetails) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(paymentDetails);
  } catch {
    return '';
  }
  const lines = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const entry = line as { payment_method_id?: unknown; method?: unknown };
    const name =
      namesById.get(Number(entry.payment_method_id)) ||
      (typeof entry.method === 'string' ? entry.method : '');
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join('; ');
}

type MinorUnits = {
  toMinor: (amount: unknown) => number;
  fromMinor: (minor: number) => number;
};

function minorUnits(currency: string): MinorUnits {
  const factor = 10 ** getCurrencyFractionDigits(currency);
  return {
    toMinor: (amount) => {
      const value = Number(amount);
      return Number.isFinite(value) ? Math.round(value * factor) : 0;
    },
    fromMinor: (minor) => minor / factor,
  };
}

/** Splits a VAT-inclusive refund into VAT using the share VAT had in its source (item or invoice). */
function vatShare(grossMinor: number, sourceVatMinor: number, sourceGrossMinor: number): number {
  if (sourceGrossMinor <= 0 || sourceVatMinor <= 0) return 0;
  return Math.round((grossMinor * sourceVatMinor) / sourceGrossMinor);
}

export function buildMonthlyVatDataset(
  options: { month: string; basis?: MonthlyVatBasis },
  db: Database = getDatabase(),
): MonthlyVatDataset {
  const range = resolveMonthRange(options.month);
  const basis = options.basis ?? 'calendar';
  const timezone = resolveExportTimezone(db);
  const businessDayStart = tenantBusinessDayStartTime(db);
  const dayStart = basis === 'business_day' ? businessDayStart : '00:00';
  const [start] = dayBoundsInTimezone(range.fromDate, timezone, dayStart);
  const [, end] = dayBoundsInTimezone(range.toDate, timezone, dayStart);
  const currency = getTenantCurrency(db);
  const { toMinor, fromMinor } = minorUnits(currency);
  const dayOf = (stored: string) =>
    localDateInTimezone(parseDbTimestamp(stored), timezone, dayStart);
  const localTime = (stored: string) => {
    const instant = parseDbTimestamp(stored);
    return Number.isNaN(instant.getTime()) ? '' : formatStoreLocalDateTime(instant, timezone);
  };

  const methodNames = new Map<number, string>();
  for (const pm of db.prepare('SELECT id, name FROM payment_methods').all() as Array<{
    id: number;
    name: string;
  }>) {
    methodNames.set(Number(pm.id), String(pm.name));
  }

  const billRows = db
    .prepare(`
    SELECT
      b.id, b.bill_number, b.paid_at, b.subtotal, b.discount_amount, b.tax_amount,
      b.service_charge, b.packaging_charge, b.delivery_charge, b.round_off, b.total,
      b.payment_status, b.payment_details,
      o.order_number, o.token_number, o.type AS order_type,
      (SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r WHERE r.bill_id = b.id) AS refunded_cents
    FROM bills b
    JOIN orders o ON o.id = b.order_id
    WHERE b.paid_at >= ? AND b.paid_at < ?
    ORDER BY b.paid_at, b.id
  `)
    .all(start, end) as Array<Record<string, unknown>>;

  const invoices: MonthlyVatInvoiceRow[] = [];
  const dailyMinor = new Map<string, Omit<MonthlyVatDailyRow, 'day'>>();
  const dailyEntry = (day: string) => {
    let entry = dailyMinor.get(day);
    if (!entry) {
      entry = {
        invoice_count: 0,
        amount_before_vat: 0,
        vat_amount: 0,
        total_with_vat: 0,
        credit_note_count: 0,
        credit_note_before_vat: 0,
        credit_note_vat: 0,
        net_vat: 0,
      };
      dailyMinor.set(day, entry);
    }
    return entry;
  };
  let invoicesBefore = 0;
  let invoicesVat = 0;
  let roundOffTotal = 0;

  for (const bill of billRows) {
    const vat = toMinor(bill.tax_amount);
    const roundOff = toMinor(bill.round_off);
    const payable = toMinor(bill.total);
    // Round-off is a payable adjustment, not taxable supply.
    const withVat = payable - roundOff;
    const before = withVat - vat;
    const day = dayOf(String(bill.paid_at));
    invoices.push({
      invoice_number: String(bill.bill_number),
      invoice_date: localTime(String(bill.paid_at)),
      day,
      order_number: String(bill.order_number ?? ''),
      token_number:
        Number.isInteger(Number(bill.token_number)) && Number(bill.token_number) > 0
          ? Number(bill.token_number)
          : null,
      order_type: String(bill.order_type ?? ''),
      payment_methods: paymentMethodNames(bill.payment_details, methodNames),
      items_subtotal: fromMinor(toMinor(bill.subtotal)),
      discount: fromMinor(toMinor(bill.discount_amount)),
      charges: fromMinor(
        toMinor(bill.service_charge) +
          toMinor(bill.packaging_charge) +
          toMinor(bill.delivery_charge),
      ),
      amount_before_vat: fromMinor(before),
      vat_amount: fromMinor(vat),
      effective_vat_percent: before > 0 ? Math.round((vat / before) * 10000) / 100 : null,
      total_with_vat: fromMinor(withVat),
      round_off: fromMinor(roundOff),
      amount_payable: fromMinor(payable),
      refunded_amount: fromMinor(Number(bill.refunded_cents) || 0),
      payment_status: String(bill.payment_status ?? ''),
    });
    invoicesBefore += before;
    invoicesVat += vat;
    roundOffTotal += roundOff;
    const entry = dailyEntry(day);
    entry.invoice_count += 1;
    entry.amount_before_vat += before;
    entry.vat_amount += vat;
    entry.total_with_vat += withVat;
  }

  // Refunds are dated when issued (as the daily sales export does), not on the original sale day.
  const refundRows = db
    .prepare(`
    SELECT
      r.id, r.created_at, r.amount_cents, r.method, r.reason, r.order_item_id,
      b.bill_number, b.paid_at, b.tax_amount AS bill_tax, b.total AS bill_total, b.round_off AS bill_round_off,
      oi.product_name AS item_name, oi.tax_amount AS item_tax, oi.total AS item_total
    FROM refunds r
    JOIN bills b ON b.id = r.bill_id
    LEFT JOIN order_items oi ON oi.id = r.order_item_id
    WHERE r.created_at >= ? AND r.created_at < ?
    ORDER BY r.created_at, r.id
  `)
    .all(start, end) as Array<Record<string, unknown>>;

  const creditNotes: MonthlyVatCreditNoteRow[] = [];
  let creditBefore = 0;
  let creditVat = 0;
  for (const refund of refundRows) {
    const gross = Math.round(Number(refund.amount_cents) || 0);
    let vat = 0;
    let vatBasis: MonthlyVatCreditNoteRow['vat_basis'] = 'none';
    const itemGross = toMinor(refund.item_total);
    if (refund.order_item_id != null && itemGross > 0) {
      vat = vatShare(gross, toMinor(refund.item_tax), itemGross);
      vatBasis = 'item_ratio';
    } else {
      const invoiceGross = toMinor(refund.bill_total) - toMinor(refund.bill_round_off);
      vat = vatShare(gross, toMinor(refund.bill_tax), invoiceGross);
      vatBasis = invoiceGross > 0 ? 'invoice_ratio' : 'none';
    }
    const day = dayOf(String(refund.created_at));
    creditNotes.push({
      refund_id: Number(refund.id),
      refund_date: localTime(String(refund.created_at)),
      day,
      original_invoice_number: String(refund.bill_number),
      original_invoice_date: refund.paid_at ? localTime(String(refund.paid_at)) : '',
      refunded_item: refund.item_name ? String(refund.item_name) : '',
      reason: refund.reason ? String(refund.reason) : '',
      method: String(refund.method ?? ''),
      amount_with_vat: fromMinor(gross),
      vat_amount: fromMinor(vat),
      amount_before_vat: fromMinor(gross - vat),
      vat_basis: vatBasis,
    });
    creditBefore += gross - vat;
    creditVat += vat;
    const entry = dailyEntry(day);
    entry.credit_note_count += 1;
    entry.credit_note_before_vat += gross - vat;
    entry.credit_note_vat += vat;
  }

  const daily: MonthlyVatDailyRow[] = [...dailyMinor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, entry]) => ({
      day,
      invoice_count: entry.invoice_count,
      amount_before_vat: fromMinor(entry.amount_before_vat),
      vat_amount: fromMinor(entry.vat_amount),
      total_with_vat: fromMinor(entry.total_with_vat),
      credit_note_count: entry.credit_note_count,
      credit_note_before_vat: fromMinor(entry.credit_note_before_vat),
      credit_note_vat: fromMinor(entry.credit_note_vat),
      net_vat: fromMinor(entry.vat_amount - entry.credit_note_vat),
    }));

  return {
    summary: {
      month: range.month,
      from_date: range.fromDate,
      to_date: range.toDate,
      basis,
      timezone,
      business_day_start: businessDayStart,
      currency,
      business_name: settingValue(db, 'business_name'),
      vat_registration_number: settingValue(db, 'tax_registration_number'),
      invoice_count: invoices.length,
      invoices_before_vat: fromMinor(invoicesBefore),
      invoices_vat: fromMinor(invoicesVat),
      invoices_with_vat: fromMinor(invoicesBefore + invoicesVat),
      credit_note_count: creditNotes.length,
      credit_notes_before_vat: fromMinor(creditBefore),
      credit_notes_vat: fromMinor(creditVat),
      credit_notes_with_vat: fromMinor(creditBefore + creditVat),
      net_before_vat: fromMinor(invoicesBefore - creditBefore),
      net_vat: fromMinor(invoicesVat - creditVat),
      net_with_vat: fromMinor(invoicesBefore + invoicesVat - creditBefore - creditVat),
      round_off_total: fromMinor(roundOffTotal),
    },
    invoices,
    creditNotes,
    daily,
  };
}

export function monthlyVatExportFilename(month: string): string {
  return `vat-invoices-${month}.xlsx`;
}

type Column<Row> = {
  key: keyof Row & string;
  en: string;
  ar: string;
  money?: boolean;
  text?: boolean;
  width?: number;
};

const INVOICE_COLUMNS: Column<MonthlyVatInvoiceRow>[] = [
  { key: 'invoice_number', en: 'Invoice No.', ar: 'رقم الفاتورة', text: true, width: 20 },
  { key: 'invoice_date', en: 'Invoice date', ar: 'تاريخ الفاتورة', width: 20 },
  { key: 'day', en: 'Day', ar: 'اليوم', width: 12 },
  { key: 'order_number', en: 'Order No.', ar: 'رقم الطلب', text: true, width: 20 },
  { key: 'token_number', en: 'Token', ar: 'الرقم', width: 8 },
  { key: 'order_type', en: 'Order type', ar: 'نوع الطلب', width: 12 },
  { key: 'payment_methods', en: 'Payment', ar: 'طريقة الدفع', width: 18 },
  { key: 'items_subtotal', en: 'Items subtotal', ar: 'إجمالي الأصناف', money: true },
  { key: 'discount', en: 'Discount', ar: 'الخصم', money: true },
  { key: 'charges', en: 'Charges', ar: 'الرسوم', money: true },
  { key: 'amount_before_vat', en: 'Amount before VAT', ar: 'المبلغ قبل الضريبة', money: true },
  { key: 'vat_amount', en: 'VAT', ar: 'ضريبة القيمة المضافة', money: true },
  { key: 'effective_vat_percent', en: 'VAT %', ar: 'نسبة الضريبة', width: 8 },
  { key: 'total_with_vat', en: 'Total with VAT', ar: 'الإجمالي شامل الضريبة', money: true },
  { key: 'round_off', en: 'Round-off', ar: 'التقريب', money: true },
  { key: 'amount_payable', en: 'Amount payable', ar: 'المبلغ المستحق', money: true },
  { key: 'refunded_amount', en: 'Refunded', ar: 'المسترد', money: true },
  { key: 'payment_status', en: 'Status', ar: 'الحالة', width: 16 },
];

const CREDIT_NOTE_COLUMNS: Column<MonthlyVatCreditNoteRow>[] = [
  { key: 'refund_id', en: 'Refund ID', ar: 'رقم الاسترداد', width: 10 },
  { key: 'refund_date', en: 'Refund date', ar: 'تاريخ الاسترداد', width: 20 },
  { key: 'day', en: 'Day', ar: 'اليوم', width: 12 },
  {
    key: 'original_invoice_number',
    en: 'Original invoice',
    ar: 'الفاتورة الأصلية',
    text: true,
    width: 20,
  },
  {
    key: 'original_invoice_date',
    en: 'Original invoice date',
    ar: 'تاريخ الفاتورة الأصلية',
    width: 20,
  },
  { key: 'refunded_item', en: 'Refunded item', ar: 'الصنف المسترد', width: 24 },
  { key: 'reason', en: 'Reason', ar: 'السبب', width: 24 },
  { key: 'method', en: 'Method', ar: 'طريقة الاسترداد', width: 12 },
  { key: 'amount_with_vat', en: 'Amount with VAT', ar: 'المبلغ شامل الضريبة', money: true },
  { key: 'vat_amount', en: 'VAT', ar: 'ضريبة القيمة المضافة', money: true },
  { key: 'amount_before_vat', en: 'Amount before VAT', ar: 'المبلغ قبل الضريبة', money: true },
  { key: 'vat_basis', en: 'VAT derived from', ar: 'أساس احتساب الضريبة', width: 16 },
];

const DAILY_COLUMNS: Column<MonthlyVatDailyRow>[] = [
  { key: 'day', en: 'Day', ar: 'اليوم', width: 12 },
  { key: 'invoice_count', en: 'Invoices', ar: 'عدد الفواتير', width: 10 },
  { key: 'amount_before_vat', en: 'Sales before VAT', ar: 'المبيعات قبل الضريبة', money: true },
  { key: 'vat_amount', en: 'Output VAT', ar: 'ضريبة المخرجات', money: true },
  { key: 'total_with_vat', en: 'Sales with VAT', ar: 'المبيعات شامل الضريبة', money: true },
  { key: 'credit_note_count', en: 'Refunds', ar: 'عدد المستردات', width: 10 },
  {
    key: 'credit_note_before_vat',
    en: 'Refunds before VAT',
    ar: 'المستردات قبل الضريبة',
    money: true,
  },
  { key: 'credit_note_vat', en: 'Refund VAT', ar: 'ضريبة المستردات', money: true },
  { key: 'net_vat', en: 'Net VAT', ar: 'صافي الضريبة', money: true },
];

const SUMMARY_LABELS: Array<{
  key: keyof MonthlyVatSummary;
  en: string;
  ar: string;
  money?: boolean;
}> = [
  { key: 'business_name', en: 'Business name', ar: 'اسم المنشأة' },
  { key: 'vat_registration_number', en: 'VAT registration number', ar: 'الرقم الضريبي' },
  { key: 'month', en: 'Month', ar: 'الشهر' },
  { key: 'from_date', en: 'From', ar: 'من' },
  { key: 'to_date', en: 'To', ar: 'إلى' },
  { key: 'basis', en: 'Day boundary', ar: 'حدود اليوم' },
  { key: 'timezone', en: 'Timezone', ar: 'المنطقة الزمنية' },
  { key: 'currency', en: 'Currency', ar: 'العملة' },
  { key: 'invoice_count', en: 'Invoices', ar: 'عدد الفواتير' },
  { key: 'invoices_before_vat', en: 'Sales before VAT', ar: 'المبيعات قبل الضريبة', money: true },
  { key: 'invoices_vat', en: 'Output VAT', ar: 'ضريبة المخرجات', money: true },
  { key: 'invoices_with_vat', en: 'Sales with VAT', ar: 'المبيعات شامل الضريبة', money: true },
  { key: 'credit_note_count', en: 'Refunds (credit notes)', ar: 'عدد المستردات' },
  {
    key: 'credit_notes_before_vat',
    en: 'Refunds before VAT',
    ar: 'المستردات قبل الضريبة',
    money: true,
  },
  { key: 'credit_notes_vat', en: 'Refund VAT', ar: 'ضريبة المستردات', money: true },
  {
    key: 'credit_notes_with_vat',
    en: 'Refunds with VAT',
    ar: 'المستردات شامل الضريبة',
    money: true,
  },
  {
    key: 'net_before_vat',
    en: 'Net sales before VAT',
    ar: 'صافي المبيعات قبل الضريبة',
    money: true,
  },
  { key: 'net_vat', en: 'Net output VAT', ar: 'صافي ضريبة المخرجات', money: true },
  { key: 'net_with_vat', en: 'Net sales with VAT', ar: 'صافي المبيعات شامل الضريبة', money: true },
  {
    key: 'round_off_total',
    en: 'Round-off (not taxable)',
    ar: 'التقريب (غير خاضع للضريبة)',
    money: true,
  },
];

function addTableSheet<Row extends Record<string, unknown>>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: Column<Row>[],
  rows: Row[],
  moneyFmt: string,
): void {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width ?? 16 }));
  // Two header rows: English, then Arabic.
  sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, column.en])));
  sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, column.ar])));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(2).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  for (const row of rows) {
    const entry = sheet.addRow(
      Object.fromEntries(columns.map((column) => [column.key, row[column.key] ?? ''])),
    );
    for (const column of columns) {
      const cell = entry.getCell(column.key);
      if (column.money && typeof cell.value === 'number') cell.numFmt = moneyFmt;
      if (column.text) cell.numFmt = '@';
    }
  }
}

export async function serializeMonthlyVatXlsx(dataset: MonthlyVatDataset): Promise<Buffer> {
  const fractionDigits = getCurrencyFractionDigits(dataset.summary.currency);
  const moneyFmt = fractionDigits > 0 ? `#,##0.${'0'.repeat(fractionDigits)}` : '#,##0';
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { key: 'en', width: 30 },
    { key: 'ar', width: 30 },
    { key: 'value', width: 24 },
  ];
  summary.addRow({
    en: 'Monthly VAT report',
    ar: 'تقرير ضريبة القيمة المضافة الشهري',
    value: '',
  }).font = {
    bold: true,
  };
  for (const label of SUMMARY_LABELS) {
    const row = summary.addRow({ en: label.en, ar: label.ar, value: dataset.summary[label.key] });
    if (label.money) row.getCell('value').numFmt = moneyFmt;
  }
  summary.addRow({});
  summary.addRow({
    en: 'Refund VAT is split from the refunded amount using the VAT share of the refunded item or invoice.',
    ar: 'تُحتسب ضريبة المستردات بنسبة الضريبة في الصنف أو الفاتورة المستردة.',
    value: '',
  });

  addTableSheet(workbook, 'Invoices', INVOICE_COLUMNS, dataset.invoices, moneyFmt);
  addTableSheet(workbook, 'Credit notes', CREDIT_NOTE_COLUMNS, dataset.creditNotes, moneyFmt);
  addTableSheet(workbook, 'Daily', DAILY_COLUMNS, dataset.daily, moneyFmt);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

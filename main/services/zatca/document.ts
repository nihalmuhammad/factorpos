/**
 * FactorPOS: turns a frozen fiscal record (bill, order items, tax snapshot, seller) into
 * the ZATCA document input. Anything ZATCA would not accept is refused here, so a sale
 * never completes with an invoice that cannot be issued.
 */
import type { ZatcaDocumentInput, ZatcaLine, ZatcaSeller } from './xml';

export class ZatcaDocumentError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ZatcaDocumentError';
    this.code = code;
  }
}

export interface SellerSnapshot {
  name?: string;
  vat_number?: string;
  crn?: string;
  street?: string;
  building_number?: string;
  district?: string;
  city?: string;
  postal_code?: string;
  timezone?: string;
}

const CHARGE_NAMES: Record<string, string> = {
  service: 'Service charge',
  packaging: 'Packaging',
  delivery: 'Delivery',
};

function minor(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** The ZATCA seller block; refuses when a required detail is missing or malformed. */
export function zatcaSeller(seller: SellerSnapshot): ZatcaSeller {
  const out: ZatcaSeller = {
    name: String(seller.name ?? '').trim(),
    vatNumber: String(seller.vat_number ?? '').trim(),
    crn: String(seller.crn ?? '').trim(),
    street: String(seller.street ?? '').trim(),
    buildingNumber: String(seller.building_number ?? '').trim(),
    district: String(seller.district ?? '').trim(),
    city: String(seller.city ?? '').trim(),
    postalCode: String(seller.postal_code ?? '').trim(),
  };
  const labels: Record<keyof ZatcaSeller, string> = {
    name: 'seller name',
    vatNumber: 'VAT number',
    crn: 'CR number',
    street: 'street',
    buildingNumber: 'building number',
    district: 'district',
    city: 'city',
    postalCode: 'postal code',
  };
  const missing = (Object.keys(out) as Array<keyof ZatcaSeller>)
    .filter((key) => !out[key])
    .map((key) => labels[key]);
  if (missing.length > 0) {
    throw new ZatcaDocumentError(
      `The ZATCA seller details are incomplete (missing: ${missing.join(', ')}). Fill them in Settings → Tax before issuing invoices.`,
      'zatca_seller_incomplete',
    );
  }
  if (!/^3\d{13}3$/.test(out.vatNumber)) {
    throw new ZatcaDocumentError(
      'The VAT number must be 15 digits, starting and ending with 3',
      'zatca_seller_invalid',
    );
  }
  if (!/^\d{4}$/.test(out.buildingNumber) || !/^\d{5}$/.test(out.postalCode)) {
    throw new ZatcaDocumentError(
      'The building number must be 4 digits and the postal code 5 digits',
      'zatca_seller_invalid',
    );
  }
  return out;
}

/** Local issue date and time (YYYY-MM-DD, HH:mm:ss) for a stored UTC timestamp. */
export function localIssueDateTime(utc: string, timezone: string): { date: string; time: string } {
  const text = String(utc).trim();
  const date = new Date(/^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  if (Number.isNaN(date.getTime())) {
    throw new ZatcaDocumentError('The invoice time could not be read', 'zatca_issue_time_invalid');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

export function paymentMeansCode(method: string | undefined): string {
  if (method === 'cash') return '10';
  if (method === 'card') return '48';
  return '1';
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstPaymentMethod(paymentDetails: unknown): string | undefined {
  const parsed = parseJson(paymentDetails);
  if (!Array.isArray(parsed)) return undefined;
  const first = parsed.find((p) => p && typeof p === 'object') as { method?: string } | undefined;
  return first?.method;
}

/** Invoice lines from the bill's tax snapshot, which sums exactly to the bill. */
export function invoiceLines(
  bill: Record<string, unknown>,
  order: { items?: Array<Record<string, unknown>> } | undefined,
): ZatcaLine[] {
  // FloCafe stores one tax snapshot per item (an array), or one for the whole bill.
  const parsed = parseJson(bill.tax_snapshot);
  const snapshots = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as Array<{
    lines?: Array<Record<string, unknown>>;
  }>;
  const taxLines = snapshots.flatMap((snapshot) =>
    Array.isArray(snapshot?.lines) ? snapshot.lines : [],
  );
  if (taxLines.length === 0) {
    throw new ZatcaDocumentError(
      'This bill has no tax breakdown, so it cannot be issued as a ZATCA invoice',
      'zatca_tax_snapshot_missing',
    );
  }
  const items = order?.items ?? [];
  const used = new Set<number>();
  return taxLines.map((line, index) => {
    const lineId = String(line.lineId ?? '');
    const netMinor = minor(line.taxableBase);
    const vatMinor = minor(line.taxAmount);
    const components = Array.isArray(line.components) ? line.components : [];
    const rates = components.map((c: any) => Number(c?.rate));
    if (netMinor <= 0 || rates.length !== 1 || rates[0] !== 15) {
      throw new ZatcaDocumentError(
        'Only standard-rated (15% VAT) sales can be issued as ZATCA invoices for now',
        'zatca_line_unsupported',
      );
    }
    if (lineId.startsWith('charge:')) {
      const kind = lineId.slice('charge:'.length);
      return {
        name: CHARGE_NAMES[kind] ?? 'Charge',
        quantity: 1,
        netMinor,
        vatMinor,
        ratePercent: 15,
      };
    }
    const productId = lineId.includes(':') ? lineId.slice(lineId.indexOf(':') + 1) : '';
    let itemIndex = items.findIndex(
      (item, i) => !used.has(i) && productId && String(item.product_id ?? '') === productId,
    );
    if (itemIndex < 0 && index < items.length && !used.has(index)) itemIndex = index;
    const item = itemIndex >= 0 ? items[itemIndex] : undefined;
    if (itemIndex >= 0) used.add(itemIndex);
    const quantity = Number(item?.quantity) > 0 ? Number(item?.quantity) : 1;
    const name = String(item?.product_name ?? '').trim() || `Item ${index + 1}`;
    return { name, quantity, netMinor, vatMinor, ratePercent: 15 };
  });
}

export interface InvoiceSnapshot {
  seller: SellerSnapshot;
  bill: Record<string, unknown>;
  order?: { items?: Array<Record<string, unknown>> };
}

export function invoiceInput(args: {
  snapshot: InvoiceSnapshot;
  documentId: string;
  counter: number;
  previousInvoiceHash: string;
  issuedAt: string;
  totalWithVatMinor: number;
  vatMinor: number;
}): ZatcaDocumentInput {
  const seller = zatcaSeller(args.snapshot.seller);
  const lines = invoiceLines(args.snapshot.bill, args.snapshot.order);
  const net = lines.reduce((sum, l) => sum + l.netMinor, 0);
  const vat = lines.reduce((sum, l) => sum + l.vatMinor, 0);
  if (net + vat !== args.totalWithVatMinor || vat !== args.vatMinor) {
    throw new ZatcaDocumentError(
      'The bill lines do not add up to the bill total, so it cannot be issued',
      'zatca_totals_mismatch',
    );
  }
  const issued = localIssueDateTime(args.issuedAt, String(args.snapshot.seller.timezone ?? ''));
  return {
    type: 'invoice',
    number: String(args.snapshot.bill.bill_number ?? ''),
    uuid: args.documentId,
    issueDate: issued.date,
    issueTime: issued.time,
    counter: args.counter,
    previousInvoiceHash: args.previousInvoiceHash,
    seller,
    lines,
    paymentMeansCode: paymentMeansCode(firstPaymentMethod(args.snapshot.bill.payment_details)),
  };
}

export function creditNoteInput(args: {
  seller: SellerSnapshot;
  documentId: string;
  counter: number;
  previousInvoiceHash: string;
  issuedAt: string;
  originalInvoiceNumber: string;
  refund: Record<string, unknown>;
  itemName?: string;
  totalWithVatMinor: number;
  vatMinor: number;
}): ZatcaDocumentInput {
  const seller = zatcaSeller(args.seller);
  const issued = localIssueDateTime(args.issuedAt, String(args.seller.timezone ?? ''));
  const reason = String(args.refund.reason ?? '').trim() || 'Refund';
  return {
    type: 'credit_note',
    number: `${args.originalInvoiceNumber}-CN${args.counter}`,
    uuid: args.documentId,
    issueDate: issued.date,
    issueTime: issued.time,
    counter: args.counter,
    previousInvoiceHash: args.previousInvoiceHash,
    seller,
    lines: [
      {
        name: args.itemName
          ? `Refund: ${args.itemName}`
          : `Refund of ${args.originalInvoiceNumber}`,
        quantity: 1,
        netMinor: args.totalWithVatMinor - args.vatMinor,
        vatMinor: args.vatMinor,
        ratePercent: 15,
      },
    ],
    paymentMeansCode: paymentMeansCode(String(args.refund.method ?? '')),
    originalInvoiceNumber: args.originalInvoiceNumber,
    reason,
  };
}

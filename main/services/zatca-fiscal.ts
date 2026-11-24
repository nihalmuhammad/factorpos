/**
 * FactorPOS: ZATCA fiscal records (roadmap phase 3).
 *
 * When ZATCA issuance is switched on (`zatca_environment`), every bill that becomes
 * fully paid gets one frozen, numbered simplified-invoice document, and every refund
 * gets a simplified credit note linked to that invoice. Both are written in the same
 * database transaction as the payment or refund. The invoice counter only moves
 * forward and never skips. Signing and reporting (phases 4–6) build on these rows.
 *
 * While the setting is 'disabled' (the default) nothing here writes anything.
 */
import { randomUUID } from 'crypto';
import { getDatabase, now } from '../db';
import { getCurrencyMinorUnitFactor } from '../countries';

type Database = ReturnType<typeof getDatabase>;

export type ZatcaEnvironment = 'simulation' | 'production';

export type FiscalIssuanceStatus = 'not_issued' | 'recorded' | 'signed' | 'review';

export interface FiscalBillStatus {
  documentId: string | null;
  counter: number | null;
  environment: string | null;
  issuanceStatus: FiscalIssuanceStatus;
  reportingStatus: string | null;
  creditNotes: number;
}

export class FiscalConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;
  /** Read by the refund route to tell the POS which refusal this is. */
  readonly diagnosticCode: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FiscalConflictError';
    this.code = code;
    this.diagnosticCode = code;
  }
}

function setting(db: Database, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return String(row?.value ?? '').trim();
}

function hasFiscalTables(db: Database): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zatca_fiscal_documents'",
      )
      .get(),
  );
}

/** The active ZATCA environment, or null when issuance is switched off. */
export function activeZatcaEnvironment(db: Database): ZatcaEnvironment | null {
  if (!hasFiscalTables(db)) return null;
  const value = setting(db, 'zatca_environment') || 'disabled';
  if (value === 'disabled') return null;
  if (value === 'simulation') return 'simulation';
  if (value === 'production') {
    // Live issuance needs signing and reporting (roadmap phases 4–6) and a signed-off pilot.
    throw new FiscalConflictError(
      'ZATCA production issuance is not available yet',
      'zatca_production_not_enabled',
    );
  }
  throw new FiscalConflictError(
    `Unknown ZATCA environment "${value}"`,
    'zatca_environment_invalid',
  );
}

function nextCounter(db: Database): number {
  db.prepare('UPDATE zatca_fiscal_sequence SET last_counter = last_counter + 1 WHERE id = 1').run();
  return (
    db.prepare('SELECT last_counter FROM zatca_fiscal_sequence WHERE id = 1').get() as {
      last_counter: number;
    }
  ).last_counter;
}

function toMinor(value: unknown, factor: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * factor) : 0;
}

function sellerSnapshot(db: Database) {
  return {
    name: setting(db, 'business_name'),
    vat_number: setting(db, 'tax_registration_number'),
    address: setting(db, 'business_address'),
    country: setting(db, 'country'),
    timezone: setting(db, 'timezone'),
  };
}

function billCurrency(db: Database): string {
  return setting(db, 'currency') || 'SAR';
}

function existingInvoice(
  db: Database,
  billId: string | number,
): { id: string; status: string } | undefined {
  return db
    .prepare(
      "SELECT id, status FROM zatca_fiscal_documents WHERE bill_id = ? AND document_type = 'simplified_invoice'",
    )
    .get(billId) as { id: string; status: string } | undefined;
}

/**
 * Records the simplified invoice for a bill that has just become fully paid.
 * Idempotent: a bill that already has its invoice returns the existing record.
 * `projectOrder` supplies the bill's order as the receipt shows it (items, add-ons,
 * split allocations); it is frozen into the record.
 */
export function recordPaidBillInvoice(
  db: Database,
  billId: string | number,
  projectOrder: (orderId: number, billId: number) => unknown,
): { id: string; counter: number; status: string } | null {
  const environment = activeZatcaEnvironment(db);
  if (!environment) return null;
  const existing = existingInvoice(db, billId);
  if (existing) {
    const row = db
      .prepare('SELECT counter FROM zatca_fiscal_documents WHERE id = ?')
      .get(existing.id) as { counter: number };
    return { id: existing.id, counter: row.counter, status: existing.status };
  }
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as
    | Record<string, unknown>
    | undefined;
  if (!bill || bill.payment_status !== 'paid') {
    throw new FiscalConflictError(
      'Only a fully paid bill can be recorded as a tax invoice',
      'zatca_bill_not_paid',
    );
  }
  const order = projectOrder(Number(bill.order_id), Number(bill.id)) as
    | { id?: unknown; items?: unknown }
    | null
    | undefined;
  if (!order || Number(order.id) !== Number(bill.order_id) || !Array.isArray(order.items)) {
    throw new FiscalConflictError(
      'The bill could not be read for its tax invoice record',
      'zatca_bill_projection_unavailable',
    );
  }
  const currency = billCurrency(db);
  const factor = getCurrencyMinorUnitFactor(currency);
  // VAT-inclusive invoice total excludes the non-taxable cash round-off.
  const totalWithVat = toMinor(bill.total, factor) - toMinor(bill.round_off, factor);
  const vat = toMinor(bill.tax_amount, factor);
  const id = randomUUID();
  const counter = nextCounter(db);
  const createdAt = now();
  db.prepare(
    `INSERT INTO zatca_fiscal_documents
      (id, document_type, bill_id, counter, environment, status, total_with_vat_minor, vat_minor,
       currency, issued_at, snapshot_json, created_at)
     VALUES (?, 'simplified_invoice', ?, ?, ?, 'recorded', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    bill.id,
    counter,
    environment,
    totalWithVat,
    vat,
    currency,
    String(bill.paid_at || createdAt),
    JSON.stringify({ seller: sellerSnapshot(db), bill, order }),
    createdAt,
  );
  return { id, counter, status: 'recorded' };
}

/**
 * Records the simplified credit note for a refund, linked to the bill's invoice.
 * A refund on a bill with no invoice record is refused while issuance is on, because
 * ZATCA credit notes must reference the original invoice.
 */
export function recordRefundCreditNote(
  db: Database,
  billId: string | number,
  refundId: string | number,
): { id: string; counter: number } | null {
  const environment = activeZatcaEnvironment(db);
  if (!environment) return null;
  const existing = db
    .prepare('SELECT id, counter FROM zatca_fiscal_documents WHERE refund_id = ?')
    .get(refundId) as { id: string; counter: number } | undefined;
  if (existing) return existing;
  const original = db
    .prepare(
      "SELECT id, counter, snapshot_json FROM zatca_fiscal_documents WHERE bill_id = ? AND document_type = 'simplified_invoice'",
    )
    .get(billId) as { id: string; counter: number; snapshot_json: string } | undefined;
  if (!original) {
    throw new FiscalConflictError(
      'This bill has no tax invoice record, so a credit note cannot be issued for it',
      'zatca_original_invoice_missing',
    );
  }
  const refund = db
    .prepare('SELECT * FROM refunds WHERE id = ? AND bill_id = ?')
    .get(refundId, billId) as Record<string, unknown> | undefined;
  if (!refund) {
    throw new FiscalConflictError('The refund is not linked to this bill', 'zatca_refund_mismatch');
  }
  const currency = billCurrency(db);
  const factor = getCurrencyMinorUnitFactor(currency);
  const amountMinor = Math.round((Number(refund.amount_cents) || 0) * (factor / 100));
  const originalSnapshot = JSON.parse(original.snapshot_json) as {
    bill?: Record<string, unknown>;
  };
  const vatMinor = creditNoteVatMinor(db, refund, originalSnapshot.bill ?? {}, amountMinor, factor);
  const id = randomUUID();
  const counter = nextCounter(db);
  const createdAt = now();
  db.prepare(
    `INSERT INTO zatca_fiscal_documents
      (id, document_type, bill_id, refund_id, original_document_id, counter, environment, status,
       total_with_vat_minor, vat_minor, currency, issued_at, snapshot_json, created_at)
     VALUES (?, 'simplified_credit_note', ?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    billId,
    refundId,
    original.id,
    counter,
    environment,
    amountMinor,
    vatMinor,
    currency,
    String(refund.created_at || createdAt),
    JSON.stringify({
      seller: sellerSnapshot(db),
      original: { document_id: original.id, counter: original.counter },
      refund,
    }),
    createdAt,
  );
  return { id, counter };
}

/**
 * VAT carried by a refund: the refunded item's VAT share when one item is refunded,
 * otherwise the invoice's VAT share (same rule as the monthly VAT report).
 */
function creditNoteVatMinor(
  db: Database,
  refund: Record<string, unknown>,
  bill: Record<string, unknown>,
  amountMinor: number,
  factor: number,
): number {
  if (refund.order_item_id) {
    const item = db
      .prepare('SELECT total, tax_amount FROM order_items WHERE id = ?')
      .get(refund.order_item_id) as { total?: number; tax_amount?: number } | undefined;
    const itemTotal = toMinor(item?.total, factor);
    const itemVat = toMinor(item?.tax_amount, factor);
    if (item && itemTotal > 0) return Math.round((amountMinor * itemVat) / itemTotal);
  }
  const base = toMinor(bill.total, factor) - toMinor(bill.round_off, factor);
  const vat = toMinor(bill.tax_amount, factor);
  return base > 0 ? Math.round((amountMinor * vat) / base) : 0;
}

/**
 * Whether bill responses carry the read-only `fiscal` field: while issuance is on, or
 * once any fiscal document exists. Shops that never switched it on see no change.
 */
export function zatcaFiscalStatusVisible(db: Database): boolean {
  if (!hasFiscalTables(db)) return false;
  if ((setting(db, 'zatca_environment') || 'disabled') !== 'disabled') return true;
  return Boolean(db.prepare('SELECT 1 FROM zatca_fiscal_documents LIMIT 1').get());
}

/** True when the bill already has its tax invoice record. */
export function billHasFiscalInvoice(db: Database, billId: string | number): boolean {
  return hasFiscalTables(db) && Boolean(existingInvoice(db, billId));
}

/**
 * Refuses a change to a bill that has been recorded as a tax invoice. ZATCA does not
 * allow an issued invoice to change; the correction is a refund (credit note) and a
 * new bill.
 */
export function assertBillNotFiscallyIssued(db: Database, billId: string | number): void {
  if (billHasFiscalInvoice(db, billId)) {
    throw new FiscalConflictError(
      'This bill has been issued as a tax invoice and cannot change. Refund it and create a new bill instead.',
      'zatca_bill_issued',
    );
  }
}

/** Read-only fiscal status for bills, keyed by bill id. Unpaid bills get no entry. */
export function fiscalStatusesForBills(
  db: Database,
  bills: Array<{ id: unknown; payment_status?: unknown }>,
): Map<number, FiscalBillStatus> {
  const result = new Map<number, FiscalBillStatus>();
  if (bills.length === 0 || !hasFiscalTables(db)) return result;
  const ids = bills.map((bill) => Number(bill.id)).filter(Number.isFinite);
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const marks = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT d.bill_id, d.id, d.counter, d.environment, d.status, j.status AS reporting_status,
           (SELECT COUNT(*) FROM zatca_fiscal_documents c
             WHERE c.original_document_id = d.id) AS credit_notes
         FROM zatca_fiscal_documents d
         LEFT JOIN zatca_reporting_jobs j ON j.document_id = d.id
         WHERE d.document_type = 'simplified_invoice' AND d.bill_id IN (${marks})`,
      )
      .all(...chunk) as Array<{
      bill_id: number;
      id: string;
      counter: number;
      environment: string;
      status: FiscalIssuanceStatus;
      reporting_status: string | null;
      credit_notes: number;
    }>;
    for (const row of rows) {
      result.set(Number(row.bill_id), {
        documentId: row.id,
        counter: row.counter,
        environment: row.environment,
        issuanceStatus: row.status,
        reportingStatus: row.reporting_status,
        creditNotes: Number(row.credit_notes) || 0,
      });
    }
  }
  for (const bill of bills) {
    const id = Number(bill.id);
    if (result.has(id)) continue;
    const status = String(bill.payment_status ?? '');
    if (status === 'unpaid' || status === 'partial' || status === 'partially_paid') continue;
    result.set(id, {
      documentId: null,
      counter: null,
      environment: null,
      issuanceStatus: 'not_issued',
      reportingStatus: null,
      creditNotes: 0,
    });
  }
  return result;
}

/**
 * FactorPOS: the signed ZATCA invoice behind a bill, for printing the Saudi bill format
 * (thermal and browser). Only the Saudi format reads this; other formats are unchanged.
 */
import { getDatabase } from '../../db';
import type { ZatcaSignedReceipt } from '../../../shared/print/zatca-qr';

type Database = ReturnType<typeof getDatabase>;

export function signedReceiptForBill(db: Database, billId: unknown): ZatcaSignedReceipt | null {
  if (billId === undefined || billId === null || billId === '') return null;
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zatca_fiscal_documents'")
    .get();
  if (!hasTable) return null;
  const row = db
    .prepare(
      `SELECT environment, qr_payload, signed_xml FROM zatca_fiscal_documents
       WHERE bill_id = ? AND document_type = 'simplified_invoice' AND status = 'signed'
         AND qr_payload IS NOT NULL AND signed_xml IS NOT NULL
       ORDER BY counter DESC LIMIT 1`,
    )
    .get(billId) as { environment: string; qr_payload: string; signed_xml: string } | undefined;
  if (!row) return null;
  // The printed date must be the one ZATCA received: take it from the signed XML.
  const issueDate = /<cbc:IssueDate>([^<]+)<\/cbc:IssueDate>/.exec(row.signed_xml)?.[1];
  const issueTime = /<cbc:IssueTime>([^<]+)<\/cbc:IssueTime>/.exec(row.signed_xml)?.[1];
  if (!issueDate || !issueTime) return null;
  return {
    qrPayload: row.qr_payload,
    environment: row.environment === 'production' ? 'production' : 'simulation',
    issueDate,
    issueTime,
  };
}

/** For print paths that may run without the database (tests, previews). */
export function signedReceiptForBillSafe(billId: unknown): ZatcaSignedReceipt | null {
  try {
    return signedReceiptForBill(getDatabase(), billId);
  } catch {
    return null;
  }
}

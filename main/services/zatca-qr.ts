/**
 * FactorPOS: ZATCA QR for a stored bill, for the Saudi bill format. A bill with a
 * signed ZATCA invoice gets that invoice's QR (tags 1–9) and issue time; otherwise the
 * preview QR (tags 1–5). The thermal renderer resolves the same way; this is the
 * lookup the browser print path and the API use.
 */
import QRCode from 'qrcode';
import { getDatabase } from '../db';
import {
  encodeZatcaQr,
  zatcaQrFieldsForBill,
  type ZatcaQrFields,
  type ZatcaSignedReceipt,
} from '../../shared/print/zatca-qr';
import { signedReceiptForBill } from './zatca/receipt';

export type BillZatcaQr =
  | { ok: true; payload: string; fields: ZatcaQrFields; signed: ZatcaSignedReceipt | null }
  | { ok: false; status: 404 | 409; error: string };

function setting(db: ReturnType<typeof getDatabase>, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return String(row?.value ?? '').trim();
}

export function buildBillZatcaQr(billId: string | number): BillZatcaQr {
  const db = getDatabase();
  const bill = db
    .prepare('SELECT total, tax_amount, round_off, paid_at, created_at FROM bills WHERE id = ?')
    .get(billId) as Record<string, unknown> | undefined;
  if (!bill) return { ok: false, status: 404, error: 'Bill not found' };
  const name = setting(db, 'business_name');
  const vatNumber = setting(db, 'tax_registration_number');
  if (!name || !vatNumber) {
    return {
      ok: false,
      status: 409,
      error: 'Add the business name and VAT number in Settings to print the ZATCA QR',
    };
  }
  const fields = zatcaQrFieldsForBill(bill, { name, vatNumber });
  const signed = signedReceiptForBill(db, billId);
  if (signed) return { ok: true, payload: signed.qrPayload, fields, signed };
  return { ok: true, payload: encodeZatcaQr(fields), fields, signed: null };
}

export async function zatcaQrDataUrl(payload: string): Promise<string> {
  // A signed QR (tags 1–9) has about four times the modules: render it sharper.
  const width = payload.length > 200 ? 512 : 256;
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', width, margin: 1 });
}

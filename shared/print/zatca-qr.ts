/**
 * FactorPOS: ZATCA simplified tax invoice QR code (TLV, Base64).
 *
 * Tags 1–5 per the ZATCA e-invoicing QR specification: seller name, VAT
 * registration number, invoice timestamp, invoice total with VAT, VAT total.
 * Phase 2 adds tags 6–9 (invoice hash, ECDSA signature, public key,
 * certificate signature); those exist only once invoices are signed with a
 * ZATCA-issued certificate, so they are not produced here.
 *
 * Pure TypeScript so the Electron main process and the browser share one encoder.
 */

/**
 * FactorPOS does not sign or report invoices to ZATCA yet (roadmap phases 4–6), so
 * the Saudi bill format is a preview: it prints a "not a tax invoice" banner and must
 * not be given to customers as their tax invoice. Phase 4 turns this off.
 */
export const ZATCA_PREVIEW_ONLY = true;
export const ZATCA_PREVIEW_BANNER_EN = 'NOT A TAX INVOICE - PREVIEW';
export const ZATCA_PREVIEW_BANNER_AR = 'ليست فاتورة ضريبية - معاينة';

export interface ZatcaQrFields {
  readonly sellerName: string;
  readonly vatNumber: string;
  /** ISO 8601 timestamp, e.g. 2026-11-24T04:00:04Z. */
  readonly timestamp: string;
  /** Invoice total including VAT, two decimals, e.g. "320.00". */
  readonly totalWithVat: string;
  /** VAT total, two decimals, e.g. "41.74". */
  readonly vatTotal: string;
}

export interface ZatcaBillLike {
  readonly total?: unknown;
  readonly tax_amount?: unknown;
  readonly round_off?: unknown;
  readonly paid_at?: unknown;
  readonly created_at?: unknown;
}

const MAX_TLV_VALUE_BYTES = 255;

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63];
    out += b === undefined ? '=' : BASE64_ALPHABET[(n >> 6) & 63];
    out += c === undefined ? '=' : BASE64_ALPHABET[n & 63];
  }
  return out;
}

/** TLV-encodes tags 1–5 and returns the Base64 string the QR code carries. */
export function encodeZatcaQr(fields: ZatcaQrFields): string {
  const values = [
    fields.sellerName,
    fields.vatNumber,
    fields.timestamp,
    fields.totalWithVat,
    fields.vatTotal,
  ];
  const bytes: number[] = [];
  values.forEach((value, index) => {
    const encoded = utf8(value);
    if (encoded.length > MAX_TLV_VALUE_BYTES) {
      throw new Error(`ZATCA QR tag ${index + 1} is longer than ${MAX_TLV_VALUE_BYTES} bytes`);
    }
    bytes.push(index + 1, encoded.length, ...encoded);
  });
  return base64(bytes);
}

/**
 * TLV-encodes tags 1..n in order (Base64). Strings are UTF-8; byte arrays are used as
 * they are (tags 8 and 9 of a signed invoice: public key and certificate signature).
 */
export function encodeZatcaQrTags(values: ReadonlyArray<string | Uint8Array>): string {
  const bytes: number[] = [];
  values.forEach((value, index) => {
    const encoded = typeof value === 'string' ? utf8(value) : Array.from(value);
    if (encoded.length > MAX_TLV_VALUE_BYTES) {
      throw new Error(`ZATCA QR tag ${index + 1} is longer than ${MAX_TLV_VALUE_BYTES} bytes`);
    }
    bytes.push(index + 1, encoded.length, ...encoded);
  });
  return base64(bytes);
}

/** Decodes a ZATCA TLV Base64 string back into tag → value (for tests and checks). */
export function decodeZatcaQr(payload: string): Map<number, string> {
  const binary =
    typeof atob === 'function'
      ? atob(payload)
      : String.fromCharCode(...decodeBase64Fallback(payload));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const decoder = new TextDecoder();
  const tags = new Map<number, string>();
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    tags.set(tag, decoder.decode(bytes.slice(offset + 2, offset + 2 + length)));
    offset += 2 + length;
  }
  return tags;
}

function decodeBase64Fallback(payload: string): number[] {
  const clean = payload.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | BASE64_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}

function toHalalas(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function formatHalalas(halalas: number): string {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(halalas);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** SQLite UTC timestamp ("2026-11-24 04:00:04") → "2026-11-24T04:00:04Z". */
export function zatcaTimestamp(dbTimestamp: string): string {
  const trimmed = dbTimestamp.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(trimmed);
  if (match && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed.slice(19))) {
    return `${match[1]}T${match[2]}Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error('Invoice timestamp is not a valid date');
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the QR fields for a paid bill. The total is the VAT-inclusive invoice
 * amount, without the non-taxable cash round-off (same rule as the VAT report).
 */
export function zatcaQrFieldsForBill(
  bill: ZatcaBillLike,
  seller: { name: string; vatNumber: string },
): ZatcaQrFields {
  const timestamp = String(bill.paid_at || bill.created_at || '');
  const vat = toHalalas(bill.tax_amount);
  const totalWithVat = toHalalas(bill.total) - toHalalas(bill.round_off);
  return {
    sellerName: seller.name.trim(),
    vatNumber: seller.vatNumber.trim(),
    timestamp: zatcaTimestamp(timestamp),
    totalWithVat: formatHalalas(totalWithVat),
    vatTotal: formatHalalas(vat),
  };
}

/**
 * FactorPOS: ZATCA simplified invoice and credit note XML (UBL 2.1), built from the
 * frozen fiscal document snapshot (roadmap phase 4).
 *
 * The XML is written so that it is already in canonical (C14N 1.1) form once the
 * signature extension, the QR reference and cac:Signature are removed: no self-closing
 * elements, text escapes only &, < and >, attributes in a fixed order, namespace
 * declarations on the root sorted as C14N sorts them. That lets the invoice hash be
 * computed with plain string work (see ./canonical.ts).
 */

export interface ZatcaSeller {
  name: string;
  vatNumber: string;
  crn: string;
  street: string;
  buildingNumber: string;
  district: string;
  city: string;
  postalCode: string;
}

export interface ZatcaLine {
  name: string;
  quantity: number;
  /** Line amount before VAT, halalas. */
  netMinor: number;
  /** Line VAT, halalas. */
  vatMinor: number;
  /** VAT rate in percent, e.g. 15. */
  ratePercent: number;
}

export interface ZatcaDocumentInput {
  type: 'invoice' | 'credit_note';
  /** cbc:ID — the bill number (invoices) or a credit note number. */
  number: string;
  uuid: string;
  /** Local (Asia/Riyadh) issue date and time: YYYY-MM-DD and HH:mm:ss. */
  issueDate: string;
  issueTime: string;
  counter: number;
  previousInvoiceHash: string;
  seller: ZatcaSeller;
  lines: ZatcaLine[];
  /** UNTDID 4461 payment means code: 10 cash, 48 bank card, 1 not defined. */
  paymentMeansCode: string;
  /** Credit notes: the original invoice number and the reason. */
  originalInvoiceNumber?: string;
  reason?: string;
}

export interface ZatcaSignatureParts {
  /** Complete ext:UBLExtensions element. */
  extensions: string;
  /** Base64 TLV QR payload. */
  qr: string;
}

export const ROOT_NAMESPACES =
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ' +
  'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ' +
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ' +
  'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"';

/** Escapes text content the way C14N writes it: &, < and > only. */
export function xmlText(value: string): string {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Up to 6 decimals, trailing zeros trimmed to 2 (UBL price and quantity). */
function decimal(value: number): string {
  const fixed = value.toFixed(6).replace(/0+$/, '');
  const [whole, frac = ''] = fixed.split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

const amount = (tag: string, minor: number) =>
  `<cbc:${tag} currencyID="SAR">${money(minor)}</cbc:${tag}>`;

function taxCategory(ratePercent: number): string {
  return (
    `<cbc:ID>S</cbc:ID><cbc:Percent>${ratePercent.toFixed(2)}</cbc:Percent>` +
    '<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>'
  );
}

export const SIGNATURE_ELEMENT =
  '<cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>' +
  '<cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod></cac:Signature>';

export function qrReference(qr: string): string {
  return (
    '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment>' +
    `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject>` +
    '</cac:Attachment></cac:AdditionalDocumentReference>'
  );
}

/** Document totals in halalas, from the lines. */
export function documentTotals(lines: ZatcaLine[]) {
  const net = lines.reduce((sum, line) => sum + line.netMinor, 0);
  const vat = lines.reduce((sum, line) => sum + line.vatMinor, 0);
  return { net, vat, gross: net + vat };
}

/**
 * Builds the document. Without `signature` it is the unsigned form (no extensions,
 * QR or cac:Signature); with it, the signed form. Both have identical text apart from
 * those three elements, which is what the invoice hash relies on.
 */
export function buildZatcaXml(input: ZatcaDocumentInput, signature?: ZatcaSignatureParts): string {
  if (input.lines.length === 0) throw new Error('A ZATCA document needs at least one line');
  const s = input.seller;
  const totals = documentTotals(input.lines);
  const rate = input.lines[0].ratePercent;
  const isCredit = input.type === 'credit_note';
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Invoice ${ROOT_NAMESPACES}>`,
  ];
  if (signature) parts.push(signature.extensions);
  parts.push(
    '<cbc:ProfileID>reporting:1.0</cbc:ProfileID>',
    `<cbc:ID>${xmlText(input.number)}</cbc:ID>`,
    `<cbc:UUID>${input.uuid}</cbc:UUID>`,
    `<cbc:IssueDate>${input.issueDate}</cbc:IssueDate>`,
    `<cbc:IssueTime>${input.issueTime}</cbc:IssueTime>`,
    `<cbc:InvoiceTypeCode name="0200000">${isCredit ? '381' : '388'}</cbc:InvoiceTypeCode>`,
    '<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>',
    '<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>',
  );
  if (isCredit) {
    parts.push(
      '<cac:BillingReference><cac:InvoiceDocumentReference>' +
        `<cbc:ID>${xmlText(input.originalInvoiceNumber ?? '')}</cbc:ID>` +
        '</cac:InvoiceDocumentReference></cac:BillingReference>',
    );
  }
  parts.push(
    `<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${input.counter}</cbc:UUID></cac:AdditionalDocumentReference>`,
    '<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment>' +
      `<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>` +
      '</cac:Attachment></cac:AdditionalDocumentReference>',
  );
  if (signature) parts.push(qrReference(signature.qr), SIGNATURE_ELEMENT);
  parts.push(
    '<cac:AccountingSupplierParty><cac:Party>' +
      `<cac:PartyIdentification><cbc:ID schemeID="CRN">${xmlText(s.crn)}</cbc:ID></cac:PartyIdentification>` +
      '<cac:PostalAddress>' +
      `<cbc:StreetName>${xmlText(s.street)}</cbc:StreetName>` +
      `<cbc:BuildingNumber>${xmlText(s.buildingNumber)}</cbc:BuildingNumber>` +
      `<cbc:CitySubdivisionName>${xmlText(s.district)}</cbc:CitySubdivisionName>` +
      `<cbc:CityName>${xmlText(s.city)}</cbc:CityName>` +
      `<cbc:PostalZone>${xmlText(s.postalCode)}</cbc:PostalZone>` +
      '<cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>' +
      '</cac:PostalAddress>' +
      `<cac:PartyTaxScheme><cbc:CompanyID>${xmlText(s.vatNumber)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` +
      `<cac:PartyLegalEntity><cbc:RegistrationName>${xmlText(s.name)}</cbc:RegistrationName></cac:PartyLegalEntity>` +
      '</cac:Party></cac:AccountingSupplierParty>',
    '<cac:AccountingCustomerParty></cac:AccountingCustomerParty>',
    '<cac:PaymentMeans>' +
      `<cbc:PaymentMeansCode>${input.paymentMeansCode}</cbc:PaymentMeansCode>` +
      (isCredit
        ? `<cbc:InstructionNote>${xmlText(input.reason || 'Refund')}</cbc:InstructionNote>`
        : '') +
      '</cac:PaymentMeans>',
    `<cac:TaxTotal>${amount('TaxAmount', totals.vat)}</cac:TaxTotal>`,
    `<cac:TaxTotal>${amount('TaxAmount', totals.vat)}<cac:TaxSubtotal>${amount('TaxableAmount', totals.net)}${amount('TaxAmount', totals.vat)}<cac:TaxCategory>${taxCategory(rate)}</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`,
    '<cac:LegalMonetaryTotal>' +
      amount('LineExtensionAmount', totals.net) +
      amount('TaxExclusiveAmount', totals.net) +
      amount('TaxInclusiveAmount', totals.gross) +
      amount('PayableAmount', totals.gross) +
      '</cac:LegalMonetaryTotal>',
  );
  input.lines.forEach((line, index) => {
    const quantity = line.quantity > 0 ? line.quantity : 1;
    parts.push(
      '<cac:InvoiceLine>' +
        `<cbc:ID>${index + 1}</cbc:ID>` +
        `<cbc:InvoicedQuantity unitCode="PCE">${decimal(quantity)}</cbc:InvoicedQuantity>` +
        amount('LineExtensionAmount', line.netMinor) +
        `<cac:TaxTotal>${amount('TaxAmount', line.vatMinor)}${amount('RoundingAmount', line.netMinor + line.vatMinor)}</cac:TaxTotal>` +
        `<cac:Item><cbc:Name>${xmlText(line.name)}</cbc:Name><cac:ClassifiedTaxCategory>${taxCategory(line.ratePercent)}</cac:ClassifiedTaxCategory></cac:Item>` +
        `<cac:Price><cbc:PriceAmount currencyID="SAR">${decimal(line.netMinor / 100 / quantity)}</cbc:PriceAmount></cac:Price>` +
        '</cac:InvoiceLine>',
    );
  });
  parts.push('</Invoice>');
  return parts.join('\n');
}

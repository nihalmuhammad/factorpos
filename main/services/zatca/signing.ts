/**
 * FactorPOS: ZATCA invoice hash, ECDSA signature, XAdES signed properties and the
 * 9-tag QR, computed natively (no Java). Each formula reproduces what ZATCA's SDK 3.4.8
 * computes and validates; tests compare against the SDK.
 *
 * - Invoice hash: remove ext:UBLExtensions, the QR reference and cac:Signature, drop the
 *   XML declaration, canonicalize (our XML is already canonical), SHA-256, Base64.
 * - Signature: SHA256withECDSA over the 32 raw bytes of the invoice hash. Electron's
 *   BoringSSL has no secp256k1, so the curve maths uses @noble/curves; hashing and
 *   certificate parsing stay on Node's crypto.
 * - Certificate digest: Base64 of the hex SHA-256 of the certificate's Base64 text.
 * - Signed-properties digest: Base64 of the hex SHA-256 of xades:SignedProperties as
 *   dom4j serializes it: xmlns:xades on the element and xmlns:ds on every ds element.
 */
import crypto from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { encodeZatcaQrTags } from '../../../shared/print/zatca-qr';
import { buildZatcaXml, documentTotals, money, type ZatcaDocumentInput } from './xml';

/** PIH of the first document in a chain: Base64 of the hex SHA-256 of "0". */
export const FIRST_PREVIOUS_INVOICE_HASH =
  'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

const NS_DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const NS_XADES = 'xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"';
const SHA256_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';

export interface ZatcaCredential {
  /** X.509 certificate: PEM, or the bare Base64 body. */
  certificate: string;
  /** EC (secp256k1) private key: PEM (SEC1 or PKCS#8), or the bare SEC1 Base64 body. */
  privateKey: string;
}

export interface SignedZatcaDocument {
  xml: string;
  invoiceHash: string;
  signatureValue: string;
  qr: string;
}

function removeElement(xml: string, start: string, end: string): string {
  const from = xml.indexOf(start);
  if (from < 0) return xml;
  const to = xml.indexOf(end, from);
  if (to < 0) throw new Error(`Unclosed ${start} in ZATCA document`);
  return xml.slice(0, from) + xml.slice(to + end.length);
}

/** The canonical text the invoice hash is taken over (see the module comment). */
export function invoiceHashInput(xml: string): string {
  let body = xml.slice(xml.indexOf('<Invoice'));
  body = removeElement(body, '<ext:UBLExtensions>', '</ext:UBLExtensions>');
  body = removeElement(
    body,
    '<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID>',
    '</cac:AdditionalDocumentReference>',
  );
  body = removeElement(body, '<cac:Signature>', '</cac:Signature>');
  return body.replace(/\r\n?/g, '\n');
}

export function invoiceHash(xml: string): string {
  return crypto.createHash('sha256').update(invoiceHashInput(xml), 'utf8').digest('base64');
}

const hexDigestBase64 = (text: string) =>
  Buffer.from(crypto.createHash('sha256').update(text, 'utf8').digest('hex')).toString('base64');

function certificateBody(certificate: string): string {
  return certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

/** Reads one DER TLV at `offset`: returns tag, content start and end. */
function derItem(buf: Buffer, offset: number) {
  const tag = buf[offset];
  let length = buf[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | buf[start + i];
    start += count;
  }
  return { tag, offset, start, end: start + length };
}

/** The certificate's own signature (from its issuer), DER bytes — QR tag 9. */
function certificateSignature(der: Buffer): Buffer {
  const outer = derItem(der, 0);
  const tbs = derItem(der, outer.start);
  const algorithm = derItem(der, tbs.end);
  const signature = derItem(der, algorithm.end);
  if (signature.tag !== 0x03) throw new Error('Unexpected certificate structure');
  return der.subarray(signature.start + 1, signature.end); // skip the unused-bits byte
}

/**
 * The 32-byte secp256k1 private scalar from a SEC1 (EC PRIVATE KEY) or PKCS#8 key, PEM
 * or bare Base64.
 */
export function privateKeyScalar(privateKey: string): Uint8Array {
  let der = Buffer.from(
    privateKey.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, ''),
    'base64',
  );
  let outer = derItem(der, 0);
  let first = derItem(der, outer.start); // INTEGER version
  let second = derItem(der, first.end);
  if (second.tag === 0x30) {
    // PKCS#8: version, algorithm, OCTET STRING holding the SEC1 key.
    const octets = derItem(der, second.end);
    der = der.subarray(octets.start, octets.end);
    outer = derItem(der, 0);
    first = derItem(der, outer.start);
    second = derItem(der, first.end);
  }
  if (second.tag !== 0x04 || second.end - second.start !== 32) {
    throw new Error('Unsupported ZATCA private key format');
  }
  return new Uint8Array(der.subarray(second.start, second.end));
}

/** subjectPublicKeyInfo (DER) from a certificate — QR tag 8. */
export function certificatePublicKey(der: Buffer): Buffer {
  const outer = derItem(der, 0);
  const tbs = derItem(der, outer.start);
  let item = derItem(der, tbs.start);
  if (item.tag === 0xa0) item = derItem(der, item.end); // explicit version
  // serial → signature algorithm → issuer → validity → subject → subjectPublicKeyInfo
  for (let step = 0; step < 5; step += 1) item = derItem(der, item.end);
  if (item.tag !== 0x30) throw new Error('Unexpected certificate structure');
  return der.subarray(item.offset, item.end);
}

/** SHA256withECDSA over `message` with a secp256k1 key, DER signature (Java-compatible). */
export function signSha256Ecdsa(message: Buffer, privateKey: string): Buffer {
  const digest = crypto.createHash('sha256').update(message).digest();
  const signature = secp256k1.sign(digest, privateKeyScalar(privateKey), { lowS: true });
  return Buffer.from(signature.toDERRawBytes());
}

function issuerName(cert: crypto.X509Certificate): string {
  return cert.issuer.split('\n').reverse().join(', ');
}

function signedPropertiesXml(
  signingTime: string,
  certDigest: string,
  cert: crypto.X509Certificate,
) {
  const serial = BigInt(`0x${cert.serialNumber}`).toString();
  return (
    '<xades:SignedProperties Id="xadesSignedProperties"><xades:SignedSignatureProperties>' +
    `<xades:SigningTime>${signingTime}</xades:SigningTime>` +
    '<xades:SigningCertificate><xades:Cert><xades:CertDigest>' +
    `<ds:DigestMethod Algorithm="${SHA256_URI}"/>` +
    `<ds:DigestValue>${certDigest}</ds:DigestValue>` +
    '</xades:CertDigest><xades:IssuerSerial>' +
    `<ds:X509IssuerName>${issuerName(cert)}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${serial}</ds:X509SerialNumber>` +
    '</xades:IssuerSerial></xades:Cert></xades:SigningCertificate>' +
    '</xades:SignedSignatureProperties></xades:SignedProperties>'
  );
}

/** dom4j's serialization of the signed properties, which ZATCA hashes. */
export function signedPropertiesDigest(signedProperties: string): string {
  const serialized = signedProperties
    .replace('<xades:SignedProperties Id=', `<xades:SignedProperties ${NS_XADES} Id=`)
    .replace(/<ds:(\w+)/g, `<ds:$1 ${NS_DS}`);
  return hexDigestBase64(serialized);
}

function extensions(
  hash: string,
  signedProperties: string,
  signedPropertiesHash: string,
  signatureValue: string,
  certBody: string,
): string {
  return (
    '<ext:UBLExtensions><ext:UBLExtension>' +
    '<ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>' +
    '<ext:ExtensionContent>' +
    '<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">' +
    '<sac:SignatureInformation>' +
    '<cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>' +
    '<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>' +
    `<ds:Signature ${NS_DS} Id="signature">` +
    '<ds:SignedInfo>' +
    '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>' +
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>' +
    '<ds:Reference Id="invoiceSignedData" URI=""><ds:Transforms>' +
    '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform>' +
    '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform>' +
    '<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID=\'QR\'])</ds:XPath></ds:Transform>' +
    '<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>' +
    '</ds:Transforms>' +
    `<ds:DigestMethod Algorithm="${SHA256_URI}"/><ds:DigestValue>${hash}</ds:DigestValue>` +
    '</ds:Reference>' +
    '<ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">' +
    `<ds:DigestMethod Algorithm="${SHA256_URI}"/><ds:DigestValue>${signedPropertiesHash}</ds:DigestValue>` +
    '</ds:Reference>' +
    '</ds:SignedInfo>' +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
    `<ds:Object><xades:QualifyingProperties ${NS_XADES} Target="signature">` +
    signedProperties +
    '</xades:QualifyingProperties></ds:Object>' +
    '</ds:Signature></sac:SignatureInformation></sig:UBLDocumentSignatures>' +
    '</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>'
  );
}

/**
 * Signs a ZATCA document. `signingTime` is local (Asia/Riyadh) yyyy-MM-ddTHH:mm:ss.
 */
export function signZatcaDocument(
  input: ZatcaDocumentInput,
  credential: ZatcaCredential,
  signingTime: string,
): SignedZatcaDocument {
  const certBody = certificateBody(credential.certificate);
  const certDer = Buffer.from(certBody, 'base64');
  const cert = new crypto.X509Certificate(certDer);

  const placeholder = buildZatcaXml(input, {
    extensions: '<ext:UBLExtensions></ext:UBLExtensions>',
    qr: '',
  });
  const hash = invoiceHash(placeholder);
  const signatureValue = signSha256Ecdsa(
    Buffer.from(hash, 'base64'),
    credential.privateKey,
  ).toString('base64');
  const certDigest = hexDigestBase64(certBody);
  const signedProperties = signedPropertiesXml(signingTime, certDigest, cert);
  const totals = documentTotals(input.lines);
  const qr = encodeZatcaQrTags([
    input.seller.name,
    input.seller.vatNumber,
    `${input.issueDate}T${input.issueTime}`,
    money(totals.gross),
    money(totals.vat),
    hash,
    signatureValue,
    certificatePublicKey(certDer),
    certificateSignature(certDer),
  ]);
  const xml = buildZatcaXml(input, {
    extensions: extensions(
      hash,
      signedProperties,
      signedPropertiesDigest(signedProperties),
      signatureValue,
      certBody,
    ),
    qr,
  });
  if (invoiceHash(xml) !== hash) throw new Error('ZATCA invoice hash changed while signing');
  return { xml, invoiceHash: hash, signatureValue, qr };
}

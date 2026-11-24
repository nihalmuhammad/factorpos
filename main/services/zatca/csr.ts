/**
 * FactorPOS: the till's ZATCA key pair and certificate signing request (CSR), built
 * natively (roadmap phase 5). The CSR has the layout ZATCA's SDK 3.4.8 produces
 * (`fatoora -csr`): subject C/OU/O/CN, the certificate-template extension and a
 * subjectAltName directory name with the EGS serial, VAT number, invoice types,
 * location and industry; signed with ECDSA secp256k1 / SHA-256. Tests compare the
 * request body byte for byte with the SDK's.
 */
import crypto from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bits, integer, octets, oid, pem, printable, seq, set, tlv, utf8 } from './der';
import { privateKeyScalar } from './signing';

export type ZatcaPortal = 'developer-portal' | 'simulation' | 'production';

/** Certificate template name ZATCA expects per environment (as the SDK writes it). */
export const CERTIFICATE_TEMPLATE: Record<ZatcaPortal, string> = {
  'developer-portal': 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

export interface CsrFields {
  /** CN: a name unique to this till. */
  commonName: string;
  /** EGS serial: 1-<solution>|2-<model or version>|3-<till uuid>. */
  serialNumber: string;
  /** 15-digit VAT registration number. */
  vatNumber: string;
  /** OU: branch name (the 10-digit TIN for a VAT group member). */
  organizationUnit: string;
  /** O: taxpayer name. */
  organizationName: string;
  /** Four flags: standard, simplified, then two reserved. FactorPOS issues simplified: 0100. */
  invoiceType: string;
  /** Branch location (short address or street). */
  locationAddress: string;
  /** Industry or business category. */
  industry: string;
}

const OID = {
  country: '2.5.4.6',
  organizationUnit: '2.5.4.11',
  organization: '2.5.4.10',
  commonName: '2.5.4.3',
  serialNumber: '2.5.4.4',
  uid: '0.9.2342.19200300.100.1.1',
  title: '2.5.4.12',
  registeredAddress: '2.5.4.26',
  businessCategory: '2.5.4.15',
  ecPublicKey: '1.2.840.10045.2.1',
  secp256k1: '1.3.132.0.10',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  certificateTemplate: '1.3.6.1.4.1.311.20.2',
  subjectAltName: '2.5.29.17',
};

const attribute = (type: string, value: Buffer) => set(seq(oid(type), value));

export class CsrFieldError extends Error {
  readonly code = 'zatca_csr_invalid';
}

export function validateCsrFields(fields: CsrFields): void {
  const empty = Object.entries(fields)
    .filter(([, value]) => !String(value ?? '').trim())
    .map(([key]) => key);
  if (empty.length > 0) {
    throw new CsrFieldError(`Missing ZATCA onboarding details: ${empty.join(', ')}`);
  }
  if (!/^3\d{13}3$/.test(fields.vatNumber)) {
    throw new CsrFieldError('The VAT number must be 15 digits, starting and ending with 3');
  }
  // A VAT group member's number has 1 as its 11th digit; its branch must be its TIN.
  if (fields.vatNumber[10] === '1' && !/^\d{10}$/.test(fields.organizationUnit)) {
    throw new CsrFieldError(
      "This VAT number belongs to a VAT group: the branch name must be the member's 10-digit TIN",
    );
  }
  if (!/^[01]{4}$/.test(fields.invoiceType) || fields.invoiceType === '0000') {
    throw new CsrFieldError('The invoice type must be four 0/1 flags, at least one set');
  }
  if (!/^1-[^|]+\|2-[^|]+\|3-[^|]+$/.test(fields.serialNumber)) {
    throw new CsrFieldError('The EGS serial must look like 1-<solution>|2-<model>|3-<id>');
  }
}

/** A fresh secp256k1 private key, as a SEC1 PEM (what loadSigningCredential reads). */
export function generatePrivateKey(): string {
  const secret = secp256k1.utils.randomPrivateKey();
  const point = Buffer.from(secp256k1.getPublicKey(secret, false));
  const sec1 = seq(
    integer([0x01]),
    octets(Buffer.from(secret)),
    tlv(0xa0, oid(OID.secp256k1)),
    tlv(0xa1, bits(point)),
  );
  return pem('EC PRIVATE KEY', sec1);
}

function publicKeyInfo(privateKey: string): Buffer {
  const point = Buffer.from(secp256k1.getPublicKey(privateKeyScalar(privateKey), false));
  return seq(seq(oid(OID.ecPublicKey), oid(OID.secp256k1)), bits(point));
}

/** The CertificationRequestInfo (the signed body of the CSR), DER. */
export function certificationRequestInfo(
  fields: CsrFields,
  portal: ZatcaPortal,
  privateKey: string,
): Buffer {
  validateCsrFields(fields);
  const subject = seq(
    attribute(OID.country, printable('SA')),
    attribute(OID.organizationUnit, utf8(fields.organizationUnit)),
    attribute(OID.organization, utf8(fields.organizationName)),
    attribute(OID.commonName, utf8(fields.commonName)),
  );
  const directoryName = seq(
    attribute(OID.serialNumber, utf8(fields.serialNumber)),
    attribute(OID.uid, utf8(fields.vatNumber)),
    attribute(OID.title, utf8(fields.invoiceType)),
    attribute(OID.registeredAddress, utf8(fields.locationAddress)),
    attribute(OID.businessCategory, utf8(fields.industry)),
  );
  const extensions = seq(
    seq(oid(OID.certificateTemplate), octets(utf8(CERTIFICATE_TEMPLATE[portal]))),
    seq(oid(OID.subjectAltName), octets(seq(tlv(0xa4, directoryName)))),
  );
  return seq(
    integer([0x00]),
    subject,
    publicKeyInfo(privateKey),
    tlv(0xa0, seq(oid(OID.extensionRequest), set(extensions))),
  );
}

export interface GeneratedCsr {
  /** PEM text of the request. */
  pem: string;
  /** What the FATOORA compliance API takes: Base64 of the PEM text. */
  base64: string;
}

export function buildCsr(fields: CsrFields, portal: ZatcaPortal, privateKey: string): GeneratedCsr {
  const info = certificationRequestInfo(fields, portal, privateKey);
  const digest = crypto.createHash('sha256').update(info).digest();
  const signature = Buffer.from(
    secp256k1.sign(digest, privateKeyScalar(privateKey), { lowS: true }).toDERRawBytes(),
  );
  const der = seq(info, seq(oid(OID.ecdsaSha256)), bits(signature));
  const text = pem('CERTIFICATE REQUEST', der);
  return { pem: text, base64: Buffer.from(text, 'utf8').toString('base64') };
}

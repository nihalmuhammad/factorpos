/**
 * FactorPOS ZATCA engine (roadmap phase 4): invoice XML, hash, ECDSA signature, XAdES
 * signed properties and the 9-tag QR.
 *
 * The first group runs everywhere with a throwaway credential. The second group runs
 * only where ZATCA's SDK is installed for development (`.local-tools/zatca-sdk`, or
 * ZATCA_SDK_LAUNCHER): it validates FactorPOS documents with the official validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FIRST_PREVIOUS_INVOICE_HASH,
  invoiceHash,
  invoiceHashInput,
  privateKeyScalar,
  signZatcaDocument,
  signedPropertiesDigest,
} from '../main/services/zatca/signing';
import type { ZatcaDocumentInput } from '../main/services/zatca/xml';
import { decodeZatcaQr } from '../shared/print/zatca-qr';
import { makeTestCredential } from './helpers/zatca-test-credential';
import { secp256k1 } from '@noble/curves/secp256k1';
import { buildCsr, certificationRequestInfo, generatePrivateKey } from '../main/services/zatca/csr';

const seller = {
  name: 'مطعم رانسي | Rancy Restaurant',
  vatNumber: '399999999900003',
  crn: '1010010000',
  street: 'الامير نايف | Prince Naif',
  buildingNumber: '2322',
  district: 'الخالدية | Al Khalidiyah',
  city: 'الأحساء | Al Ahsa',
  postalCode: '36361',
};

function invoice(overrides: Partial<ZatcaDocumentInput> = {}): ZatcaDocumentInput {
  return {
    type: 'invoice',
    number: 'INV-20261124-0001',
    uuid: crypto.randomUUID(),
    issueDate: '2026-11-24',
    issueTime: '07:00:04',
    counter: 1,
    previousInvoiceHash: FIRST_PREVIOUS_INVOICE_HASH,
    seller,
    lines: [
      {
        name: 'Chicken Mandi | مندي دجاج',
        quantity: 2,
        netMinor: 27826,
        vatMinor: 4174,
        ratePercent: 15,
      },
      { name: 'Karak Tea & <milk>', quantity: 3, netMinor: 700, vatMinor: 105, ratePercent: 15 },
    ],
    paymentMeansCode: '10',
    ...overrides,
  };
}

const pick = (xml: string, re: RegExp) => (xml.match(re) ?? [])[1];

test('signed invoice: hash, signature, certificate and signed-properties digests agree', () => {
  const credential = makeTestCredential();
  const signed = signZatcaDocument(invoice(), credential, '2026-11-24T07:00:05');
  assert.equal(invoiceHash(signed.xml), signed.invoiceHash, 'hash recomputes from the final XML');
  assert.equal(
    pick(signed.xml, /URI=""><ds:Transforms>[\s\S]*?<ds:DigestValue>([^<]+)</),
    signed.invoiceHash,
  );
  const verified = crypto.verify(
    'sha256',
    Buffer.from(signed.invoiceHash, 'base64'),
    {
      key: crypto.createPublicKey({ key: credential.publicKeyDer, format: 'der', type: 'spki' }),
      dsaEncoding: 'der',
    },
    Buffer.from(signed.signatureValue, 'base64'),
  );
  assert.ok(verified, 'the ECDSA signature verifies with the certificate key');
  const certDigest = Buffer.from(
    crypto.createHash('sha256').update(credential.certificate).digest('hex'),
  ).toString('base64');
  assert.equal(pick(signed.xml, /<xades:CertDigest>[\s\S]*?<ds:DigestValue>([^<]+)</), certDigest);
  const sp = signed.xml.slice(
    signed.xml.indexOf('<xades:SignedProperties'),
    signed.xml.indexOf('</xades:SignedProperties>') + '</xades:SignedProperties>'.length,
  );
  assert.equal(
    pick(signed.xml, /URI="#xadesSignedProperties">[\s\S]*?<ds:DigestValue>([^<]+)</),
    signedPropertiesDigest(sp),
  );
});

test('hash input: signature parts removed, canonical form (no self-closing elements)', () => {
  const signed = signZatcaDocument(invoice(), makeTestCredential(), '2026-11-24T07:00:05');
  const input = invoiceHashInput(signed.xml);
  assert.ok(input.startsWith('<Invoice '), 'no XML declaration');
  for (const removed of ['ext:UBLExtensions', '<cbc:ID>QR</cbc:ID>', 'cac:Signature']) {
    assert.ok(!input.includes(removed), `${removed} is not hashed`);
  }
  assert.ok(!/\/>/.test(input), 'no self-closing elements in the hashed part');
  assert.ok(input.includes('Karak Tea &amp; &lt;milk&gt;'), 'text is escaped canonically');
  assert.ok(input.includes('<cbc:UUID>1</cbc:UUID>'), 'ICV is the counter');
  assert.ok(input.includes(FIRST_PREVIOUS_INVOICE_HASH), 'first document carries the initial PIH');
});

test('QR carries all nine ZATCA tags', () => {
  const credential = makeTestCredential();
  const signed = signZatcaDocument(invoice(), credential, '2026-11-24T07:00:05');
  const decoded = Buffer.from(signed.qr, 'base64');
  const tags = new Map<number, Buffer>();
  for (let offset = 0; offset < decoded.length;) {
    tags.set(decoded[offset], decoded.subarray(offset + 2, offset + 2 + decoded[offset + 1]));
    offset += 2 + decoded[offset + 1];
  }
  assert.deepEqual([...tags.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const text = decodeZatcaQr(signed.qr);
  assert.equal(text.get(1), seller.name);
  assert.equal(text.get(2), seller.vatNumber);
  assert.equal(text.get(3), '2026-11-24T07:00:04', 'timestamp matches IssueDate and IssueTime');
  assert.equal(text.get(4), '328.05');
  assert.equal(text.get(5), '42.79');
  assert.equal(text.get(6), signed.invoiceHash);
  assert.equal(text.get(7), signed.signatureValue);
  assert.ok(tags.get(8)!.equals(credential.publicKeyDer), 'tag 8 is the public key');
  assert.ok(tags.get(9)!.length > 60, 'tag 9 is the certificate signature');
  assert.ok(
    signed.xml.includes(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${signed.qr}<`),
  );
});

test('credit note references its invoice and gives a reason', () => {
  const signed = signZatcaDocument(
    invoice({
      type: 'credit_note',
      number: 'INV-20261124-0001-CN2',
      counter: 2,
      previousInvoiceHash: 'Nw2wfwubA/6okLrXSReoPQynK8SeTUqgY+lkxjkOYpE=',
      originalInvoiceNumber: 'INV-20261124-0001',
      reason: 'Customer returned item',
      lines: [{ name: 'Refund: Tea', quantity: 1, netMinor: 1000, vatMinor: 150, ratePercent: 15 }],
    }),
    makeTestCredential(),
    '2026-11-24T07:11:00',
  );
  assert.ok(signed.xml.includes('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>'));
  assert.ok(
    signed.xml.includes(
      '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-20261124-0001</cbc:ID>',
    ),
  );
  assert.ok(
    signed.xml.includes('<cbc:InstructionNote>Customer returned item</cbc:InstructionNote>'),
  );
  assert.ok(
    signed.xml.includes('Nw2wfwubA/6okLrXSReoPQynK8SeTUqgY+lkxjkOYpE='),
    'PIH is the previous hash',
  );
});

// ─── Official ZATCA SDK checks (development machines only) ───

function findSdk(): string | null {
  if (process.env.ZATCA_SDK_LAUNCHER) return process.env.ZATCA_SDK_LAUNCHER;
  for (let dir = path.resolve(__dirname); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.local-tools', 'zatca-sdk');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sdk = findSdk();
const sdkDir = sdk ? path.join(path.dirname(sdk), 'zatca-einvoicing-sdk-Java-238-R3.4.8') : '';

function sdkValidate(xml: string, previousHash: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-zatca-sdk-'));
  const file = path.join(dir, 'document.xml');
  fs.writeFileSync(file, xml);
  fs.writeFileSync(path.join(dir, 'pih.txt'), previousHash);
  const config = JSON.parse(
    fs.readFileSync(path.join(sdkDir, 'Configuration', 'local-config.json'), 'utf8'),
  );
  config.pihPath = path.join(dir, 'pih.txt');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const output = execFileSync(sdk!, ['-validate', '-invoice', file], {
    cwd: dir,
    env: { ...process.env, SDK_CONFIG: path.join(dir, 'config.json') },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return output;
}

test(
  'ZATCA SDK 3.4.8 validates FactorPOS invoices, a credit note and a debit note in one chain',
  { skip: !sdk && 'ZATCA SDK not installed (.local-tools/zatca-sdk)' },
  () => {
    const credential = {
      certificate: fs.readFileSync(path.join(sdkDir, 'Data', 'Certificates', 'cert.pem'), 'utf8'),
      privateKey: fs.readFileSync(
        path.join(sdkDir, 'Data', 'Certificates', 'ec-secp256k1-priv-key.pem'),
        'utf8',
      ),
    };
    const first = signZatcaDocument(invoice(), credential, '2026-11-24T07:00:05');
    const second = signZatcaDocument(
      invoice({
        number: 'INV-20261124-0002',
        counter: 2,
        previousInvoiceHash: first.invoiceHash,
        paymentMeansCode: '48',
        lines: [
          { name: 'Mandi', quantity: 1, netMinor: 5000, vatMinor: 750, ratePercent: 15 },
          { name: 'Service charge', quantity: 1, netMinor: 696, vatMinor: 105, ratePercent: 15 },
        ],
      }),
      credential,
      '2026-11-24T07:05:00',
    );
    const credit = signZatcaDocument(
      invoice({
        type: 'credit_note',
        number: 'INV-20261124-0002-CN3',
        counter: 3,
        previousInvoiceHash: second.invoiceHash,
        originalInvoiceNumber: 'INV-20261124-0002',
        reason: 'Wrong item',
        lines: [
          { name: 'Refund: Mandi', quantity: 1, netMinor: 5000, vatMinor: 750, ratePercent: 15 },
        ],
      }),
      credential,
      '2026-11-24T07:10:00',
    );
    const debit = signZatcaDocument(
      invoice({
        type: 'debit_note',
        number: 'INV-20261124-0002-DN4',
        counter: 4,
        previousInvoiceHash: credit.invoiceHash,
        originalInvoiceNumber: 'INV-20261124-0002',
        reason: 'Price correction',
        lines: [
          { name: 'Price correction', quantity: 1, netMinor: 1000, vatMinor: 150, ratePercent: 15 },
        ],
      }),
      credential,
      '2026-11-24T07:15:00',
    );
    for (const [label, doc, pih] of [
      ['first invoice', first, FIRST_PREVIOUS_INVOICE_HASH],
      ['second invoice', second, first.invoiceHash],
      ['credit note', credit, second.invoiceHash],
      ['debit note', debit, credit.invoiceHash],
    ] as const) {
      const output = sdkValidate(doc.xml, pih);
      for (const check of ['XSD', 'EN', 'KSA', 'QR', 'SIGNATURE', 'PIH']) {
        assert.match(
          output,
          new RegExp(`\\[${check}\\] validation result : PASSED`),
          `${label}: ${check}`,
        );
      }
      assert.match(output, /GLOBAL VALIDATION RESULT = PASSED/, `${label}: overall`);
    }
  },
);

// ─── Onboarding: the till's certificate signing request (CSR) ───

const csrFields = {
  commonName: 'TST-886431145-399999999900003',
  serialNumber: '1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f',
  vatNumber: '399999999900003',
  organizationUnit: 'Riyadh Branch',
  organizationName: 'Maximum Speed Tech Supply LTD',
  invoiceType: '1100',
  locationAddress: 'RRRD2929',
  industry: 'Supply activities',
};

function csrDer(csr: { pem: string }): Buffer {
  return Buffer.from(csr.pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

test('CSR: signed by the till key, template and directory name per environment', () => {
  const key = generatePrivateKey();
  const csr = buildCsr(csrFields, 'simulation', key);
  assert.equal(
    Buffer.from(csr.base64, 'base64').toString('utf8'),
    csr.pem,
    'API form is Base64 of the PEM',
  );
  const der = csrDer(csr);
  // CertificationRequestInfo is the first element; the signature is the last BIT STRING.
  const infoLength = der.readUInt16BE(6);
  const info = der.subarray(4, 8 + infoLength);
  const rest = der.subarray(8 + infoLength);
  // After the algorithm SEQUENCE: BIT STRING tag, length, unused-bits byte, then the signature.
  const sigStart = 2 + rest[1] + 3;
  const point = Buffer.from(secp256k1.getPublicKey(privateKeyScalar(key), false));
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
      point,
    ]),
    format: 'der',
    type: 'spki',
  });
  assert.ok(
    crypto.verify('sha256', info, publicKey, rest.subarray(sigStart)),
    'the CSR signature verifies with the till public key',
  );
  for (const [portal, template] of [
    ['developer-portal', 'TSTZATCA-Code-Signing'],
    ['simulation', 'PREZATCA-Code-Signing'],
    ['production', 'ZATCA-Code-Signing'],
  ] as const) {
    const body = certificationRequestInfo(csrFields, portal, key);
    assert.ok(body.includes(Buffer.from(template)), `${portal} uses ${template}`);
  }
  assert.ok(info.includes(Buffer.from(csrFields.serialNumber)), 'EGS serial in the directory name');
});

test('CSR: refuses malformed onboarding details', () => {
  const key = generatePrivateKey();
  assert.throws(
    () => buildCsr({ ...csrFields, vatNumber: '123' }, 'simulation', key),
    /VAT number/,
  );
  assert.throws(() => buildCsr({ ...csrFields, industry: ' ' }, 'simulation', key), /industry/);
  assert.throws(
    () => buildCsr({ ...csrFields, invoiceType: '0000' }, 'simulation', key),
    /invoice type/,
  );
  assert.throws(
    () => buildCsr({ ...csrFields, serialNumber: 'EGS-1' }, 'simulation', key),
    /EGS serial/,
  );
  assert.throws(
    () => buildCsr({ ...csrFields, vatNumber: '399999999910003' }, 'simulation', key),
    /VAT group/,
  );
});

test(
  "CSR body is byte-identical to the ZATCA SDK's for the same key and details",
  { skip: !sdk && 'ZATCA SDK not installed (.local-tools/zatca-sdk)' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-zatca-csr-'));
    try {
      const config = Object.entries({
        'csr.common.name': csrFields.commonName,
        'csr.serial.number': csrFields.serialNumber,
        'csr.organization.identifier': csrFields.vatNumber,
        'csr.organization.unit.name': csrFields.organizationUnit,
        'csr.organization.name': csrFields.organizationName,
        'csr.country.name': 'SA',
        'csr.invoice.type': csrFields.invoiceType,
        'csr.location.address': csrFields.locationAddress,
        'csr.industry.business.category': csrFields.industry,
      })
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      fs.writeFileSync(path.join(dir, 'csr.properties'), config);
      const args = ['-csr', '-csrConfig', 'csr.properties', '-privateKey', 'key.pem'];
      args.push('-generatedCsr', 'req.csr', '-pem', '-sim');
      execFileSync(sdk!, args, { cwd: dir, encoding: 'utf8' });
      const sdkKey = fs.readFileSync(path.join(dir, 'key.pem'), 'utf8');
      const sdkCsr = csrDer({ pem: fs.readFileSync(path.join(dir, 'req.csr'), 'utf8') });
      const sdkInfo = sdkCsr.subarray(4, 8 + sdkCsr.readUInt16BE(6));
      const ours = certificationRequestInfo(csrFields, 'simulation', sdkKey);
      assert.equal(ours.toString('hex'), sdkInfo.toString('hex'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

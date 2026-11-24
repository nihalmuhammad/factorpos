/**
 * FactorPOS: ZATCA simplified-invoice QR (TLV tags 1–5, Base64).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeZatcaQr,
  encodeZatcaQr,
  zatcaQrFieldsForBill,
  zatcaTimestamp,
} from '../shared/print/zatca-qr';

/** Independent reference encoder using Node's Buffer, to cross-check the shared one. */
function referenceTlv(values: string[]): string {
  return Buffer.concat(
    values.map((value, index) => {
      const bytes = Buffer.from(value, 'utf8');
      return Buffer.concat([Buffer.from([index + 1, bytes.length]), bytes]);
    }),
  ).toString('base64');
}

test('matches the published ZATCA QR example', () => {
  const payload = encodeZatcaQr({
    sellerName: 'Bobs Records',
    vatNumber: '310122393500003',
    timestamp: '2022-04-25T15:30:00Z',
    totalWithVat: '1000.00',
    vatTotal: '150.00',
  });
  assert.equal(
    payload,
    'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA==',
  );
});

test('Arabic seller names are encoded as UTF-8 bytes', () => {
  const values = ['مطعم رانسي', '300000000000003', '2026-11-24T04:00:04Z', '320.00', '41.74'];
  const payload = encodeZatcaQr({
    sellerName: values[0],
    vatNumber: values[1],
    timestamp: values[2],
    totalWithVat: values[3],
    vatTotal: values[4],
  });
  assert.equal(payload, referenceTlv(values));
  const tags = decodeZatcaQr(payload);
  assert.deepEqual([...tags.values()], values);
});

test('bill fields: UTC timestamp, VAT-inclusive total without round-off, two decimals', () => {
  const fields = zatcaQrFieldsForBill(
    { total: 80, tax_amount: 10.43, round_off: 0, paid_at: '2026-11-24 04:02:23' },
    { name: ' nihal cafe ', vatNumber: '300000000000003' },
  );
  assert.deepEqual(fields, {
    sellerName: 'nihal cafe',
    vatNumber: '300000000000003',
    timestamp: '2026-11-24T04:02:23Z',
    totalWithVat: '80.00',
    vatTotal: '10.43',
  });
  const rounded = zatcaQrFieldsForBill(
    { total: 24.25, tax_amount: 3.15, round_off: 0.1, paid_at: '2026-11-24 04:00:00' },
    { name: 'Shop', vatNumber: '300000000000003' },
  );
  assert.equal(rounded.totalWithVat, '24.15');
});

test('timestamps already in ISO form are kept in UTC', () => {
  assert.equal(zatcaTimestamp('2026-11-24T07:00:04+03:00'), '2026-11-24T04:00:04Z');
  assert.equal(zatcaTimestamp('2026-11-24T04:00:04Z'), '2026-11-24T04:00:04Z');
  assert.throws(() => zatcaTimestamp(''));
});

test('a value longer than one TLV length byte is refused', () => {
  assert.throws(() =>
    encodeZatcaQr({
      sellerName: 'x'.repeat(256),
      vatNumber: '300000000000003',
      timestamp: '2026-11-24T04:00:04Z',
      totalWithVat: '1.00',
      vatTotal: '0.13',
    }),
  );
});

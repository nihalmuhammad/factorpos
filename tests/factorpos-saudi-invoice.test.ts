/**
 * FactorPOS: Saudi simplified tax invoice bill format ('saudi') and its ZATCA QR,
 * on thermal (ESC/POS text and raster) and browser printing.
 */
const Module = require('module');
const originalLoad = Module._load;
const os = require('os');
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => os.tmpdir(), getVersion: () => 'test' } };
  return originalLoad.apply(this, [request, ...rest]);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatReceipt,
  escPosToText,
  normalizeReceiptTemplate,
} = require('../main/printers/thermal');
const {
  renderSaudiReceiptLines,
  renderSaudiReceiptViaDocument,
  SAUDI_INVOICE_TITLE_AR,
} = require('../main/printers/document-saudi');
const { capabilitiesForPrinter, resolvePrinterProfile } = require('../main/printers/profiles');
const {
  CORE_BILL_TEMPLATES,
  isAvailableBillTemplate,
} = require('../main/services/print-templates');
const { encodeZatcaQr, decodeZatcaQr } = require('../shared/print/zatca-qr');
const { generateSaudiBillHtml } = require('../frontend/src/lib/printer/saudi-web-print');

function order(): any {
  return {
    order_number: 'ORD-20261124-0001',
    type: 'dine_in',
    created_at: '2026-11-24 04:00:04',
    token_number: 3,
    table: { name: '7' },
    items: [
      { product_name: 'Chicken Mandi', quantity: 2, unit_price: 160, total: 320, addons: [] },
      { product_name: 'مندي لحم', quantity: 1, unit_price: 80, total: 80, addons: [] },
      { product_name: 'Cancelled tea', quantity: 1, unit_price: 5, total: 5, status: 'cancelled' },
    ],
  };
}

function bill(extra: Record<string, unknown> = {}): any {
  return {
    id: 1,
    bill_number: 'INV-20261124-0001',
    subtotal: 400,
    discount_amount: 0,
    tax_amount: 52.17,
    service_charge: 0,
    delivery_charge: 0,
    total: 400,
    round_off: 0,
    paid_at: '2026-11-24 04:00:04',
    payment_details: JSON.stringify([{ method: 'cash', amount: 400 }]),
    ...extra,
  };
}

function business(extra: Record<string, unknown> = {}): any {
  return {
    name: 'nihal cafe',
    address: 'Prince Naif Rd, Hofuf',
    phone: '0500000000',
    taxRegistrationNumber: '300000000000003',
    country: 'SA',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    show_table_number: true,
    footer_note: 'Thank you',
    ...extra,
  };
}

const EXPECTED_QR = encodeZatcaQr({
  sellerName: 'nihal cafe',
  vatNumber: '300000000000003',
  timestamp: '2026-11-24T04:00:04Z',
  totalWithVat: '400.00',
  vatTotal: '52.17',
});

test('saudi is a core bill template', () => {
  assert.ok(CORE_BILL_TEMPLATES.includes('saudi'));
  assert.equal(normalizeReceiptTemplate('saudi'), 'saudi');
  assert.ok(isAvailableBillTemplate(JSON.stringify({ source: 'core', id: 'saudi' })));
});

test('thermal text output carries the ZATCA invoice fields and totals', () => {
  const data: Buffer = formatReceipt(order(), bill(), business(), 'saudi', 48);
  const text = escPosToText(data);
  for (const expected of [
    'nihal cafe',
    'VAT No: 300000000000003',
    'SIMPLIFIED TAX INVOICE',
    'INV-20261124-0001',
    '24/11/2026 07:00:04',
    'Chicken Mandi',
    'Total excl. VAT',
    '347.83',
    'VAT 15%',
    '52.17',
    'SAR 400.00',
  ]) {
    assert.ok(text.includes(expected), `bill shows ${expected}`);
  }
  assert.ok(!text.includes('Cancelled tea'), 'cancelled items are left off');
  assert.ok(!text.includes('TOKEN'), 'the Saudi invoice has no day token');
  assert.ok(!/Powered by/i.test(text), 'no branding footer');
  // Native ESC/POS QR (GS ( k) carrying the exact ZATCA TLV payload.
  const qrStore = Buffer.concat([Buffer.from([0x31, 0x50, 0x30]), Buffer.from(EXPECTED_QR)]);
  assert.ok(data.includes(Buffer.from([0x1d, 0x28, 0x6b])), 'QR command present');
  assert.ok(data.includes(qrStore), 'QR stores the ZATCA payload');
  const tags = decodeZatcaQr(EXPECTED_QR);
  assert.equal(tags.get(4), '400.00');
  assert.equal(tags.get(5), '52.17');
});

test('text-only printers skip the fixed Arabic labels instead of printing ????', () => {
  const { lines } = renderSaudiReceiptLines(order(), bill(), business(), {
    columns: 48,
    isReprint: false,
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
  });
  assert.ok(!lines.some((line: string) => line.includes(SAUDI_INVOICE_TITLE_AR)));
  assert.ok(
    lines.some((line: string) => line.includes('مندي لحم')),
    'shop data still prints',
  );
});

test('raster printers draw the Arabic title and labels as raster groups', () => {
  const capabilities = capabilitiesForPrinter(
    resolvePrinterProfile({ profile_id: 'generic-escpos-80' }),
    '80mm',
  );
  const result = renderSaudiReceiptViaDocument(order(), bill(), business(), {
    columns: 48,
    isReprint: false,
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
    capabilities,
  });
  const titleIndex = result.lines.findIndex((line: string) =>
    line.includes(SAUDI_INVOICE_TITLE_AR),
  );
  assert.ok(titleIndex > 0, 'Arabic title is in the raster lines');
  assert.ok(
    result.rasterGroups.some(
      (group: any) => group.lineIndex === titleIndex && group.lineCount === 1,
    ),
    'Arabic title is a raster group',
  );
  assert.equal(result.qrPayload, EXPECTED_QR);
  assert.ok(!escPosToText(result.data).includes('?????'), 'native fallback has no ???? runs');
});

test('Arabic-shaping printers print the Arabic title as text', () => {
  const capabilities = capabilitiesForPrinter(
    resolvePrinterProfile({ profile_id: 'escpos-impact-76' }),
    '76mm',
    true,
  );
  const { lines } = renderSaudiReceiptLines(order(), bill(), business(), {
    columns: 42,
    isReprint: false,
    useUnicode: false,
    arabicShaping: true,
    cutMode: 'full',
    capabilities,
  });
  assert.ok(lines.some((line: string) => line.includes(SAUDI_INVOICE_TITLE_AR)));
});

test('round-off is shown apart from the VAT-inclusive total', () => {
  const text = escPosToText(
    formatReceipt(order(), bill({ total: 400.05, round_off: 0.05 }), business(), 'saudi', 48),
  );
  assert.ok(text.includes('SAR 400.00'), 'total incl. VAT stays 400.00');
  assert.ok(text.includes('Round-off'));
  assert.ok(text.includes('SAR 400.05'), 'amount payable includes the round-off');
});

test('without a VAT number the bill says so and prints no QR', () => {
  const data: Buffer = formatReceipt(
    order(),
    bill(),
    business({ taxRegistrationNumber: '' }),
    'saudi',
    48,
  );
  assert.ok(!data.includes(Buffer.from([0x1d, 0x28, 0x6b])));
  assert.ok(escPosToText(data).includes('Add the VAT number in Settings'));
});

test('58 mm bills drop the unit price column but keep totals', () => {
  const text = escPosToText(formatReceipt(order(), bill(), business(), 'saudi', 32));
  assert.ok(text.includes('Chicken Mandi'));
  assert.ok(text.includes('SAR 400.00'));
  assert.ok(!text.includes('Price'));
});

test('browser bill shows both titles, VAT split and the QR image', () => {
  const html: string = generateSaudiBillHtml(
    {
      ...bill(),
      payment_details: [{ method: 'cash', amount: 400, timestamp: '' }],
      order: order(),
    },
    {
      paperSize: 'thermal80',
      businessName: 'nihal cafe',
      vatNumber: '300000000000003',
      timezone: 'Asia/Riyadh',
      qrDataUrl: 'data:image/png;base64,AAAA',
    },
  );
  for (const expected of [
    'فاتورة ضريبية مبسطة',
    'SIMPLIFIED TAX INVOICE',
    '300000000000003',
    '24/11/2026 07:00:04',
    '347.83',
    'VAT 15%',
    'SAR 400.00',
    'data:image/png;base64,AAAA',
  ]) {
    assert.ok(html.includes(expected), `browser bill shows ${expected}`);
  }
  assert.ok(!html.includes('Cancelled tea'));
  assert.ok(!html.includes('<script'), 'no script in the print page');
  const escaped: string = generateSaudiBillHtml(
    {
      ...bill(),
      payment_details: [],
      order: {
        ...order(),
        items: [{ product_name: '<b>x</b>', quantity: 1, unit_price: 1, total: 1 }],
      },
    },
    { qrDataUrl: null },
  );
  assert.ok(escaped.includes('&lt;b&gt;x&lt;/b&gt;'), 'item names are escaped');
  assert.ok(escaped.includes('Add the VAT number in Settings'));
});

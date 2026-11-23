/**
 * FactorPOS monthly VAT report, end to end through the real POS flow:
 * Saudi VAT pack (15%, VAT-inclusive prices) → orders → bills → payments → refunds
 * → GET /api/reports/monthly-vat/export, cross-checked against FloCafe's own
 * daily sales export for the same days.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/monthly-vat-export-e2e.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-monthly-vat-e2e-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  closeDatabase,
  now,
  installAndActivateTestTaxPack,
} = require('./helpers/test-setup');
const saudiVatPack = require('../main/tax-packs/community-saudi-arabia.json');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { reportRoutes } = require('../main/routes/reports');
const ExcelJS = require('exceljs');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

const cents = (value: unknown) => Math.round(Number(value) * 100);

async function main() {
  console.log('E2E: monthly VAT report through the real order, bill, payment and refund flow');
  console.log('='.repeat(64));

  const db = initTestDb();
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  setSetting(db, 'taxes_enabled', 'true');
  setSetting(db, 'business_name', 'E2E Shop');
  setSetting(db, 'tax_registration_number', '300000000000003');
  // The shop installs FloCafe's Saudi community VAT pack (15%, VAT-inclusive prices).
  installAndActivateTestTaxPack(db, saudiVatPack);
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-e2e', 'Menu');
  const inclusive = { tax_category_id: 'standard', tax_behavior: 'inclusive' };
  seedProduct(db, 'prod-mandi', 'cat-e2e', 'Mandi', 57.5, inclusive);
  seedProduct(db, 'prod-kabsa', 'cat-e2e', 'Kabsa', 23, inclusive);
  seedProduct(db, 'prod-tea', 'cat-e2e', 'Karak Tea', 1.15, inclusive);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  async function sell(items: Array<{ product_id: string; quantity: number }>, method: string) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items },
      headers: ownerAuth,
    });
    assertEqualOrThrow(
      order.status,
      201,
      `order created (${items.map((i) => i.product_id).join('+')})`,
    );
    const orderId = order.data.order.id;
    // Kitchen delivery is required before billing; mark the items served.
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId);
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: ownerAuth,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const billId = bill.data.bill.id;
    const pay = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method, amount: Number(bill.data.bill.total) },
      headers: ownerAuth,
    });
    assertEqualOrThrow(pay.status, 200, `bill ${bill.data.bill.bill_number} paid by ${method}`);
    return { orderId, billId, bill: pay.data.bill };
  }

  try {
    console.log('\n─── Sales through the POS API ───');
    const one = await sell([{ product_id: 'prod-mandi', quantity: 2 }], 'cash');
    const two = await sell(
      [
        { product_id: 'prod-kabsa', quantity: 1 },
        { product_id: 'prod-tea', quantity: 1 },
      ],
      'card',
    );
    const three = await sell([{ product_id: 'prod-tea', quantity: 3 }], 'cash');
    const bills = [one, two, three].map((sale) =>
      db.prepare('SELECT * FROM bills WHERE id = ?').get(sale.billId),
    );
    console.log(
      '  bills:',
      bills.map((b: any) => `${b.bill_number} total=${b.total} vat=${b.tax_amount}`).join(' | '),
    );
    assertEqualOrThrow(cents(bills[0].total), 11500, 'Mandi ×2 costs 115.00 including VAT');
    assertEqualOrThrow(cents(bills[0].tax_amount), 1500, 'VAT on 115.00 inclusive is 15.00');
    assertEqualOrThrow(cents(bills[1].total), 2415, 'Kabsa + tea costs 24.15');
    assertEqualOrThrow(cents(bills[1].tax_amount), 315, 'VAT on 24.15 inclusive is 3.15');
    assertEqualOrThrow(cents(bills[2].tax_amount), 45, 'VAT on 3.45 inclusive is 0.45');

    console.log('\n─── Refunds through the refund API ───');
    const amountRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: two.billId,
        amount: 11.5,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(amountRefund.status, 201, 'amount refund of 11.50 on the Kabsa bill');
    const teaLine = db
      .prepare("SELECT id FROM order_items WHERE order_id = ? AND product_id = 'prod-tea'")
      .get(three.orderId);
    const itemRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: {
        bill_id: three.billId,
        order_item_id: teaLine.id,
        amount: 3.45,
        method: 'cash',
        override_pin: '1234',
        approver_id: managerId,
      },
      headers: managerAuth,
    });
    assertEqualOrThrow(itemRefund.status, 201, 'item refund of the tea line (3.45)');

    console.log('\n─── VAT report download ───');
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
    const res = await fetch(`${baseUrl}/api/reports/monthly-vat/export?month=${month}`, {
      headers: ownerAuth,
    });
    assertEqualOrThrow(res.status, 200, `VAT report for ${month} downloads`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));

    const table = (name: string) => {
      const sheet = workbook.getWorksheet(name);
      const keys = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
      const rows: Record<string, unknown>[] = [];
      sheet.eachRow((row: any, n: number) => {
        if (n <= 2) return;
        rows.push(Object.fromEntries(keys.map((key, i) => [key, row.getCell(i + 1).value])));
      });
      return rows;
    };
    const invoices = table('Invoices');
    const credits = table('Credit notes');
    const summary: Record<string, unknown> = {};
    workbook.getWorksheet('Summary').eachRow((row: any) => {
      summary[String(row.getCell(1).value)] = row.getCell(3).value;
    });

    assertEqualOrThrow(invoices.length, 3, 'three invoices');
    invoices.forEach((row, i) => {
      const bill: any = bills[i];
      assertEqualOrThrow(
        row['Invoice No.'],
        bill.bill_number,
        `row ${i + 1} is ${bill.bill_number}`,
      );
      assertEqualOrThrow(
        cents(row['VAT']),
        cents(bill.tax_amount),
        `${bill.bill_number}: VAT matches the bill`,
      );
      assertEqualOrThrow(
        cents(row['Amount before VAT']) + cents(row['VAT']),
        cents(row['Total with VAT']),
        `${bill.bill_number}: before VAT + VAT = total`,
      );
      assertEqualOrThrow(
        cents(row['Total with VAT']),
        cents(bill.total),
        `${bill.bill_number}: total matches the bill`,
      );
      assertEqualOrThrow(row['VAT %'], 15, `${bill.bill_number}: effective VAT 15%`);
      assertOrThrow(Number(row['Token']) > 0, `${bill.bill_number}: has a day token`);
    });
    assertEqualOrThrow(credits.length, 2, 'two credit notes');
    assertEqualOrThrow(
      cents(credits[0]['VAT']),
      150,
      'amount refund 11.50 carries 1.50 VAT (invoice share)',
    );
    assertEqualOrThrow(credits[0]['VAT derived from'], 'invoice_ratio', 'amount refund basis');
    assertEqualOrThrow(
      cents(credits[1]['VAT']),
      45,
      'tea refund 3.45 carries 0.45 VAT (item share)',
    );
    assertEqualOrThrow(credits[1]['VAT derived from'], 'item_ratio', 'item refund basis');
    assertEqualOrThrow(cents(summary['Output VAT']), 1500 + 315 + 45, 'summary output VAT 18.60');
    assertEqualOrThrow(cents(summary['Refund VAT']), 195, 'summary refund VAT 1.95');
    assertEqualOrThrow(
      cents(summary['Net output VAT']),
      1860 - 195,
      'summary net output VAT 16.65',
    );

    console.log('\n─── Cross-check with FloCafe daily sales export ───');
    const firstDay = `${month}-01`;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
    const daily = await fetch(
      `${baseUrl}/api/reports/daily-sales/export?from=${firstDay}&to=${today}&format=csv&part=summary`,
      { headers: ownerAuth },
    );
    assertEqualOrThrow(daily.status, 200, 'daily sales summary downloads');
    const metrics: Record<string, string> = {};
    for (const line of (await daily.text()).trim().split('\n').slice(1)) {
      const [key, value] = line.split(',');
      metrics[key] = value;
    }
    assertEqualOrThrow(
      cents(metrics.tax_total),
      cents(summary['Output VAT']),
      'output VAT = daily sales tax_total',
    );
    assertEqualOrThrow(
      cents(metrics.gross_collected),
      cents(summary['Sales with VAT']),
      'sales with VAT = daily sales gross_collected',
    );
    assertEqualOrThrow(
      cents(metrics.refunds_issued),
      cents(summary['Refunds with VAT']),
      'refunds with VAT = daily sales refunds_issued',
    );
  } finally {
    server.close();
    closeDatabase();
  }

  const { passed, failed } = getResults();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

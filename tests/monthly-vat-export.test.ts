/**
 * FactorPOS monthly VAT invoice report — GET /api/reports/monthly-vat/export.
 *
 * Covers role gating, month validation, Asia/Riyadh month boundaries (calendar vs the
 * store's day-close cutoff), VAT split with round-off, halala-exact totals, refunds as
 * credit notes dated when issued (item and invoice VAT ratios), and the XLSX layout.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/monthly-vat-export.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-monthly-vat-export-'));

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
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');
const { buildMonthlyVatDataset } = require('../main/services/monthly-vat-export');
const ExcelJS = require('exceljs');

/** Riyadh is UTC+3 all year; stored timestamps are UTC `YYYY-MM-DD HH:MM:SS`. */
function riyadh(localDateTime: string): string {
  const instant = new Date(`${localDateTime}:00+03:00`);
  return instant.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function setSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

async function main() {
  console.log('Integration Test: FactorPOS monthly VAT invoice report');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-vat', 'VAT Cat');
  seedProduct(db, 'prod-vat', 'cat-vat', 'Mandi', 57.5);
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  setSetting(db, 'business_day_start_time', '04:00');
  setSetting(db, 'business_name', 'Test Shop');
  setSetting(db, 'tax_registration_number', '300000000000003');

  let orderSeq = 0;
  function seedBill(opts: {
    billNumber: string;
    paidAtLocal: string;
    total: number;
    tax: number;
    roundOff?: number;
    token?: number;
    item?: { name: string; total: number; tax: number };
  }): { billId: number; itemId: number | null } {
    const paidAt = riyadh(opts.paidAtLocal);
    orderSeq += 1;
    const order = db
      .prepare(`
      INSERT INTO orders (order_number, token_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'owner-test-001', 'takeaway', 'completed', ?, ?, ?, ?, ?)
    `)
      .run(`ORD-${orderSeq}`, opts.token ?? null, opts.total, opts.total, paidAt, paidAt, paidAt);
    let itemId: number | null = null;
    if (opts.item) {
      const info = db
        .prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'prod-vat', ?, 1, ?, ?, ?, ?, 'ready', ?, ?)
      `)
        .run(
          order.lastInsertRowid,
          opts.item.name,
          opts.item.total,
          opts.item.total - opts.item.tax,
          opts.item.tax,
          opts.item.total,
          paidAt,
          paidAt,
        );
      itemId = Number(info.lastInsertRowid);
    }
    const bill = db
      .prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, round_off, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
    `)
      .run(
        opts.billNumber,
        order.lastInsertRowid,
        opts.total - opts.tax,
        opts.tax,
        opts.roundOff ?? 0,
        opts.total,
        opts.total,
        JSON.stringify([{ method: 'card', amount: opts.total, timestamp: paidAt }]),
        paidAt,
        paidAt,
        paidAt,
      );
    return { billId: Number(bill.lastInsertRowid), itemId };
  }

  function seedRefund(
    billId: number,
    amountCents: number,
    createdAtLocal: string,
    orderItemId: number | null = null,
  ) {
    db.prepare(`
      INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, approved_by, created_by, created_at)
      VALUES (?, ?, ?, 'cash', 'test', 'owner-test-001', 'owner-test-001', ?)
    `).run(billId, orderItemId, amountCents, riyadh(createdAtLocal));
  }

  // October 2026 sales.
  const a = seedBill({
    billNumber: 'INV-A',
    paidAtLocal: '2026-10-05T12:00',
    total: 115,
    tax: 15,
    token: 7,
    item: { name: 'Mandi', total: 57.5, tax: 7.5 },
  });
  const b = seedBill({ billNumber: 'INV-B', paidAtLocal: '2026-10-31T23:30', total: 23, tax: 3 });
  // 02:00 on 1 Nov: November by calendar, but 31 Oct by the 04:00 day-close cutoff.
  seedBill({ billNumber: 'INV-C', paidAtLocal: '2026-11-01T02:00', total: 11.5, tax: 1.5 });
  seedBill({ billNumber: 'INV-OUT', paidAtLocal: '2026-09-30T22:00', total: 46, tax: 6 });
  // Round-off is payable, not taxable: 58.00 paid = 57.50 with VAT + 0.50 round-off.
  seedBill({
    billNumber: 'INV-E',
    paidAtLocal: '2026-10-10T13:00',
    total: 58,
    tax: 7.5,
    roundOff: 0.5,
  });
  // Three VAT amounts of 0.15 must total exactly 0.45 (float addition gives 0.44999…).
  for (const n of [1, 2, 3]) {
    seedBill({ billNumber: `INV-F${n}`, paidAtLocal: '2026-10-12T09:00', total: 1.15, tax: 0.15 });
  }

  seedRefund(a.billId, 5750, '2026-10-06T10:00', a.itemId); // item refund: VAT 7.50 from the item's share
  seedRefund(b.billId, 1150, '2026-10-31T23:45'); // amount refund: VAT 1.50 from the invoice's share
  seedRefund(a.billId, 1000, '2026-11-02T10:00'); // issued in November: not in October

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);
  const url = (query: string) => `${baseUrl}/api/reports/monthly-vat/export?${query}`;

  try {
    console.log('\n─── Role gating and validation ───');
    assertEqualOrThrow(
      (await fetch(url('month=2026-10'), { headers: manager.authHeader })).status,
      403,
      'manager forbidden (403)',
    );
    assertEqualOrThrow(
      (await fetch(url('month=2026-10'))).status,
      401,
      'unauthenticated rejected (401)',
    );
    for (const bad of [
      '',
      'month=2026-13',
      'month=2026-1',
      'month=26-10',
      'month=2026-10&basis=weekly',
    ]) {
      assertEqualOrThrow(
        (await fetch(url(bad), { headers: authHeader })).status,
        400,
        `rejects "${bad}" (400)`,
      );
    }

    console.log('\n─── Calendar month (default) ───');
    const calendar = buildMonthlyVatDataset({ month: '2026-10' }, db);
    const numbers = calendar.invoices.map((row: any) => row.invoice_number);
    assertEqualOrThrow(
      numbers.join(','),
      'INV-A,INV-E,INV-F1,INV-F2,INV-F3,INV-B',
      'October invoices only, in time order (INV-C is 1 Nov, INV-OUT is 30 Sep)',
    );
    const invA = calendar.invoices[0];
    assertEqualOrThrow(invA.amount_before_vat, 100, 'INV-A amount before VAT');
    assertEqualOrThrow(invA.vat_amount, 15, 'INV-A VAT');
    assertEqualOrThrow(invA.effective_vat_percent, 15, 'INV-A effective VAT 15%');
    assertEqualOrThrow(invA.token_number, 7, 'INV-A carries the day token');
    assertEqualOrThrow(invA.invoice_date, '2026-10-05 12:00:00', 'invoice date in Asia/Riyadh');
    assertEqualOrThrow(
      invA.refunded_amount,
      67.5,
      'INV-A shows all refunds against it (57.50 + 10.00)',
    );
    const invE = calendar.invoices[1];
    assertEqualOrThrow(invE.total_with_vat, 57.5, 'round-off excluded from total with VAT');
    assertEqualOrThrow(invE.amount_before_vat, 50, 'round-off excluded from taxable amount');
    assertEqualOrThrow(invE.round_off, 0.5, 'round-off shown separately');
    assertEqualOrThrow(invE.amount_payable, 58, 'amount payable unchanged');

    const s = calendar.summary;
    assertEqualOrThrow(s.invoice_count, 6, 'summary invoice count');
    assertEqualOrThrow(
      s.invoices_vat,
      15 + 3 + 7.5 + 0.45,
      'output VAT summed in halalas (0.15 × 3 = 0.45 exactly)',
    );
    assertEqualOrThrow(s.invoices_before_vat, 100 + 20 + 50 + 3, 'sales before VAT');
    assertEqualOrThrow(s.credit_note_count, 2, 'two October refunds');
    assertEqualOrThrow(s.credit_notes_vat, 9, 'refund VAT 7.50 + 1.50');
    assertEqualOrThrow(s.net_vat, 25.95 - 9, 'net output VAT');
    assertEqualOrThrow(s.round_off_total, 0.5, 'round-off total');
    assertEqualOrThrow(s.vat_registration_number, '300000000000003', 'VAT number from settings');
    assertEqualOrThrow(s.basis, 'calendar', 'calendar basis by default');

    const itemRefund = calendar.creditNotes[0];
    assertEqualOrThrow(
      itemRefund.original_invoice_number,
      'INV-A',
      'credit note links its invoice',
    );
    assertEqualOrThrow(itemRefund.vat_basis, 'item_ratio', 'item refund uses the item VAT share');
    assertEqualOrThrow(itemRefund.vat_amount, 7.5, 'item refund VAT');
    assertEqualOrThrow(itemRefund.refunded_item, 'Mandi', 'refunded item named');
    const amountRefund = calendar.creditNotes[1];
    assertEqualOrThrow(
      amountRefund.vat_basis,
      'invoice_ratio',
      'amount refund uses the invoice VAT share',
    );
    assertEqualOrThrow(amountRefund.vat_amount, 1.5, 'amount refund VAT');
    assertEqualOrThrow(amountRefund.amount_before_vat, 10, 'amount refund before VAT');

    const days = calendar.daily.map((row: any) => row.day);
    assertEqualOrThrow(
      days.join(','),
      '2026-10-05,2026-10-06,2026-10-10,2026-10-12,2026-10-31',
      'daily rows',
    );
    const dailyVat = calendar.daily.reduce(
      (sum: number, row: any) => sum + Math.round(row.net_vat * 100),
      0,
    );
    assertEqualOrThrow(
      dailyVat,
      Math.round(s.net_vat * 100),
      'daily net VAT adds up to the summary',
    );

    console.log('\n─── Day-close (business_day) basis ───');
    const business = buildMonthlyVatDataset({ month: '2026-10', basis: 'business_day' }, db);
    const businessNumbers = business.invoices.map((row: any) => row.invoice_number);
    assertOrThrow(
      businessNumbers.includes('INV-C'),
      '02:00 on 1 Nov belongs to the 31 Oct business day',
    );
    assertEqualOrThrow(business.summary.invoice_count, 7, 'business-day month has seven invoices');
    const november = buildMonthlyVatDataset({ month: '2026-11' }, db);
    assertEqualOrThrow(
      november.invoices.map((row: any) => row.invoice_number).join(','),
      'INV-C',
      'INV-C is in November by calendar',
    );
    assertEqualOrThrow(
      november.summary.credit_note_count,
      1,
      'November refund counted in November',
    );

    console.log('\n─── XLSX download ───');
    const res = await fetch(url('month=2026-10'), { headers: authHeader });
    assertEqualOrThrow(res.status, 200, 'xlsx → 200');
    assertIncludesOrThrow(
      res.headers.get('content-disposition') || '',
      'vat-invoices-2026-10.xlsx',
      'filename',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
    assertEqualOrThrow(
      workbook.worksheets.map((sheet: any) => sheet.name).join(','),
      'Summary,Invoices,Credit notes,Daily',
      'sheet order',
    );
    const invoices = workbook.getWorksheet('Invoices');
    assertEqualOrThrow(invoices.getRow(1).getCell(1).value, 'Invoice No.', 'English header row');
    assertEqualOrThrow(invoices.getRow(2).getCell(1).value, 'رقم الفاتورة', 'Arabic header row');
    assertEqualOrThrow(invoices.rowCount, 2 + 6, 'two header rows + six invoices');
    assertEqualOrThrow(invoices.getRow(3).getCell(1).value, 'INV-A', 'first invoice row');
    const vatCell = invoices.getRow(3).getCell(12);
    assertEqualOrThrow(vatCell.value, 15, 'VAT cell is numeric');
    assertEqualOrThrow(vatCell.numFmt, '#,##0.00', 'VAT cell uses a 2-decimal money format');
    const summarySheet = workbook.getWorksheet('Summary');
    const summaryValues: Record<string, unknown> = {};
    summarySheet.eachRow((row: any) => {
      summaryValues[String(row.getCell(1).value)] = row.getCell(3).value;
    });
    assertEqualOrThrow(summaryValues['Net output VAT'], 16.95, 'summary sheet net output VAT');
    assertEqualOrThrow(workbook.getWorksheet('Credit notes').rowCount, 2 + 2, 'two credit notes');

    const empty = await fetch(url('month=2026-01'), { headers: authHeader });
    assertEqualOrThrow(empty.status, 200, 'empty month still downloads');

    console.log('\n─── VAT % is the applied rate, not the rounded ratio ───');
    {
      // 80.00 incl. VAT → 69.57 + 10.43: the ratio is 14.99%, the rate applied is 15%.
      const snap = JSON.stringify([
        {
          lines: [
            {
              lineId: 'line-0001:prod-vat',
              taxableBase: 69.57,
              taxAmount: 10.43,
              components: [{ rate: 15 }],
            },
          ],
        },
      ]);
      const withSnapshot = seedBill({
        billNumber: 'INV-R1',
        paidAtLocal: '2026-08-10T12:00',
        total: 80,
        tax: 10.43,
      });
      db.prepare('UPDATE bills SET tax_snapshot = ? WHERE id = ?').run(snap, withSnapshot.billId);
      seedBill({ billNumber: 'INV-R2', paidAtLocal: '2026-08-10T13:00', total: 80, tax: 10.43 });
      const august = buildMonthlyVatDataset({ month: '2026-08' }, db);
      const byNumber = (n: string) => august.invoices.find((row: any) => row.invoice_number === n);
      assertEqualOrThrow(
        byNumber('INV-R1')?.effective_vat_percent,
        15,
        'a 15% bill shows 15, not 14.99',
      );
      assertEqualOrThrow(
        byNumber('INV-R2')?.effective_vat_percent,
        14.99,
        'without a tax breakdown it falls back to VAT ÷ amount before VAT',
      );
    }
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

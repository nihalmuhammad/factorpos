/**
 * FactorPOS ZATCA fiscal records (roadmap phase 3), through the real POS flow:
 * orders → bills → payments → refunds, with ZATCA issuance off and in simulation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-zatca-fiscal-records.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-zatca-fiscal-'));

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
const {
  assertBillNotFiscallyIssued,
  recordPaidBillInvoice,
  FiscalConflictError,
} = require('../main/services/zatca-fiscal');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

function throwsWith(fn: () => unknown, pattern: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return pattern.test(String((error as Error)?.message ?? error));
  }
}

async function main() {
  console.log('ZATCA fiscal records: invoices and credit notes from real payments and refunds');
  console.log('='.repeat(72));

  const db = initTestDb();
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  setSetting(db, 'taxes_enabled', 'true');
  setSetting(db, 'business_name', 'Fiscal Test Shop');
  setSetting(db, 'business_address', 'Prince Naif Rd, Hofuf');
  setSetting(db, 'tax_registration_number', '300000000000003');
  installAndActivateTestTaxPack(db, saudiVatPack);
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-fiscal', 'Menu');
  const inclusive = { tax_category_id: 'standard', tax_behavior: 'inclusive' };
  seedProduct(db, 'prod-mandi', 'cat-fiscal', 'Mandi', 57.5, inclusive);
  seedProduct(db, 'prod-tea', 'cat-fiscal', 'Karak Tea', 1.15, inclusive);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const documents = () =>
    db.prepare('SELECT * FROM zatca_fiscal_documents ORDER BY counter').all() as any[];

  async function billFor(items: Array<{ product_id: string; quantity: number }>) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items },
      headers: ownerAuth,
    });
    assertEqualOrThrow(order.status, 201, 'order created');
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(
      order.data.order.id,
    );
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.data.order.id },
      headers: ownerAuth,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    return bill.data.bill;
  }

  async function pay(bill: any, method = 'cash') {
    return api(baseUrl, `/api/bills/${bill.id}/payment`, {
      method: 'POST',
      body: { method, amount: Number(bill.total) },
      headers: ownerAuth,
    });
  }

  try {
    console.log('\n─── Off by default: nothing changes for shops ───');
    {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'zatca_environment'").get();
      assertEqualOrThrow(row?.value, 'disabled', 'zatca_environment defaults to disabled');
      const bill = await billFor([{ product_id: 'prod-mandi', quantity: 1 }]);
      const paid = await pay(bill);
      assertEqualOrThrow(paid.status, 200, 'payment works with issuance off');
      assertEqualOrThrow(documents().length, 0, 'no fiscal document is recorded while off');
      assertOrThrow(!('fiscal' in paid.data), 'payment response has no fiscal field while off');
      const read = await api(baseUrl, `/api/bills/${bill.id}`, { headers: ownerAuth });
      assertOrThrow(!('fiscal' in read.data.bill), 'bill response has no fiscal field while off');
    }
    const paidBeforeSwitch = db
      .prepare("SELECT * FROM bills WHERE payment_status = 'paid' ORDER BY id LIMIT 1")
      .get() as any;

    console.log('\n─── Simulation: each paid bill gets one numbered invoice ───');
    setSetting(db, 'zatca_environment', 'simulation');
    const one = await billFor([{ product_id: 'prod-mandi', quantity: 2 }]);
    const two = await billFor([
      { product_id: 'prod-mandi', quantity: 1 },
      { product_id: 'prod-tea', quantity: 1 },
    ]);
    const payOne = await pay(one);
    assertEqualOrThrow(payOne.status, 200, 'first bill paid');
    assertEqualOrThrow(payOne.data.fiscal?.issuanceStatus, 'recorded', 'payment reports recorded');
    assertEqualOrThrow(payOne.data.fiscal?.counter, 1, 'first invoice counter is 1');
    const payTwo = await pay(two, 'card');
    assertEqualOrThrow(payTwo.data.fiscal?.counter, 2, 'second invoice counter is 2');
    let docs = documents();
    assertEqualOrThrow(docs.length, 2, 'two invoices recorded');
    assertEqualOrThrow(docs[0].document_type, 'simplified_invoice', 'document type');
    assertEqualOrThrow(docs[0].environment, 'simulation', 'environment is simulation');
    assertEqualOrThrow(docs[0].total_with_vat_minor, 11500, 'invoice total 115.00 in halalas');
    assertEqualOrThrow(docs[0].vat_minor, 1500, 'invoice VAT 15.00 in halalas');
    assertEqualOrThrow(docs[1].total_with_vat_minor, 5865, 'second invoice total 58.65');
    const snapshot = JSON.parse(docs[0].snapshot_json);
    assertEqualOrThrow(snapshot.seller.vat_number, '300000000000003', 'seller VAT number frozen');
    assertEqualOrThrow(snapshot.seller.name, 'Fiscal Test Shop', 'seller name frozen');
    assertEqualOrThrow(snapshot.bill.bill_number, one.bill_number, 'bill frozen');
    assertEqualOrThrow(snapshot.order.items.length, 1, 'order items frozen');
    assertEqualOrThrow(snapshot.order.items[0].product_name, 'Mandi', 'item name frozen');

    console.log('\n─── Bill reads show the read-only status ───');
    {
      const read = await api(baseUrl, `/api/bills/${one.id}`, { headers: ownerAuth });
      assertEqualOrThrow(read.data.bill.fiscal?.issuanceStatus, 'recorded', 'bill detail status');
      assertEqualOrThrow(read.data.bill.fiscal?.counter, 1, 'bill detail counter');
      const list = await api(baseUrl, '/api/bills?limit=50', { headers: ownerAuth });
      const before = list.data.bills.find((b: any) => b.id === paidBeforeSwitch.id);
      assertEqualOrThrow(
        before?.fiscal?.issuanceStatus,
        'not_issued',
        'a bill paid while off shows not_issued',
      );
      const unpaid = await billFor([{ product_id: 'prod-tea', quantity: 1 }]);
      const unpaidRead = await api(baseUrl, `/api/bills/${unpaid.id}`, { headers: ownerAuth });
      assertEqualOrThrow(unpaidRead.data.bill.fiscal, null, 'an unpaid bill has no fiscal status');
      await pay(unpaid);
    }

    console.log('\n─── No duplicates on retry ───');
    {
      const countBefore = documents().length;
      const again = recordPaidBillInvoice(db, one.id, () => {
        throw new Error('projection must not run for an existing invoice');
      });
      assertEqualOrThrow(again.counter, 1, 'recording again returns the same invoice');
      assertEqualOrThrow(documents().length, countBefore, 'no second invoice for the same bill');
      const sequence = db.prepare('SELECT last_counter FROM zatca_fiscal_sequence').get() as any;
      assertEqualOrThrow(sequence.last_counter, countBefore, 'counter did not move on retry');
    }

    console.log('\n─── Refunds become credit notes linked to the invoice ───');
    {
      const refund = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        body: {
          bill_id: two.id,
          amount: 11.5,
          method: 'cash',
          override_pin: '1234',
          approver_id: managerId,
        },
        headers: managerAuth,
      });
      assertEqualOrThrow(refund.status, 201, 'refund on an invoiced bill succeeds');
      docs = documents();
      const credit = docs[docs.length - 1];
      const invoiceTwo = docs.find((d: any) => d.bill_id === two.id && !d.refund_id);
      assertEqualOrThrow(credit.document_type, 'simplified_credit_note', 'credit note recorded');
      assertEqualOrThrow(credit.original_document_id, invoiceTwo.id, 'linked to the invoice');
      assertEqualOrThrow(credit.counter, docs.length, 'credit note takes the next counter');
      assertEqualOrThrow(credit.total_with_vat_minor, 1150, 'credit note amount 11.50');
      assertEqualOrThrow(credit.vat_minor, 150, 'credit note VAT 1.50 (invoice share)');
      const read = await api(baseUrl, `/api/bills/${two.id}`, { headers: ownerAuth });
      assertEqualOrThrow(read.data.bill.fiscal?.creditNotes, 1, 'bill shows one credit note');

      const countBefore = documents().length;
      const noInvoice = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        body: {
          bill_id: paidBeforeSwitch.id,
          amount: 1,
          method: 'cash',
          override_pin: '1234',
          approver_id: managerId,
        },
        headers: managerAuth,
      });
      assertEqualOrThrow(noInvoice.status, 409, 'refund on a bill without an invoice is refused');
      // FloCafe's refund route forwards only registered diagnostic codes, so the
      // refusal is identified by its status and message.
      assertOrThrow(
        /no tax invoice record/.test(String(noInvoice.data?.error ?? '')),
        'refusal says the original invoice is missing',
      );
      const saved = db
        .prepare('SELECT COUNT(*) AS n FROM refunds WHERE bill_id = ?')
        .get(paidBeforeSwitch.id) as any;
      assertEqualOrThrow(saved.n, 0, 'the refused refund was not saved');
      assertEqualOrThrow(documents().length, countBefore, 'no document for a refused refund');
    }

    console.log('\n─── Fiscal documents are frozen ───');
    {
      const doc = documents()[0];
      assertOrThrow(
        throwsWith(
          () =>
            db
              .prepare('UPDATE zatca_fiscal_documents SET snapshot_json = ? WHERE id = ?')
              .run('{}', doc.id),
          /frozen/,
        ),
        'the frozen copy cannot be edited',
      );
      assertOrThrow(
        throwsWith(
          () =>
            db
              .prepare('UPDATE zatca_fiscal_documents SET total_with_vat_minor = 1 WHERE id = ?')
              .run(doc.id),
          /frozen/,
        ),
        'the total cannot be edited',
      );
      assertOrThrow(
        throwsWith(
          () => db.prepare('DELETE FROM zatca_fiscal_documents WHERE id = ?').run(doc.id),
          /cannot be deleted/,
        ),
        'a fiscal document cannot be deleted',
      );
      assertOrThrow(
        throwsWith(
          () => db.prepare('UPDATE zatca_fiscal_sequence SET last_counter = 0').run(),
          /backwards/,
        ),
        'the counter cannot go backwards',
      );
      db.prepare(
        "UPDATE zatca_fiscal_documents SET status = 'signed', invoice_hash = 'h1', signed_at = ? WHERE id = ?",
      ).run(now(), doc.id);
      assertOrThrow(
        throwsWith(
          () =>
            db
              .prepare("UPDATE zatca_fiscal_documents SET invoice_hash = 'h2' WHERE id = ?")
              .run(doc.id),
          /frozen/,
        ),
        'signing fields are written once',
      );
    }

    console.log('\n─── Issued bills are locked ───');
    {
      assertOrThrow(
        throwsWith(() => assertBillNotFiscallyIssued(db, one.id), /issued as a tax invoice/),
        'an issued bill refuses changes',
      );
      let threw: unknown = null;
      try {
        assertBillNotFiscallyIssued(db, one.id);
      } catch (error) {
        threw = error;
      }
      assertOrThrow(
        threw instanceof FiscalConflictError && (threw as any).statusCode === 409,
        'the refusal is a 409 conflict',
      );
      assertBillNotFiscallyIssued(db, paidBeforeSwitch.id);
      assertOrThrow(true, 'a bill without an invoice is not locked');
    }

    console.log('\n─── Production stays blocked, and the payment rolls back ───');
    {
      setSetting(db, 'zatca_environment', 'production');
      const bill = await billFor([{ product_id: 'prod-tea', quantity: 2 }]);
      const countBefore = documents().length;
      const res = await pay(bill);
      assertEqualOrThrow(res.status, 409, 'paying is refused while production is selected');
      const after = db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(bill.id) as any;
      assertOrThrow(after.payment_status !== 'paid', 'the bill did not become paid');
      assertEqualOrThrow(documents().length, countBefore, 'no document was recorded');
      setSetting(db, 'zatca_environment', 'simulation');
      const retry = await pay(bill);
      assertEqualOrThrow(retry.status, 200, 'the same bill pays once simulation is back');
      const counters = documents().map((d: any) => d.counter);
      assertOrThrow(
        counters.every((c: number, i: number) => c === i + 1),
        `counters stay gapless after the refused payment (${counters.join(',')})`,
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

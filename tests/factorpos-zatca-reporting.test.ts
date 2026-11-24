/**
 * FactorPOS ZATCA reporting (roadmap phase 6): signed invoices and credit notes are
 * queued in the same transaction, reported to ZATCA with retries, and reviewed per day.
 * FATOORA is replaced by a local server whose answers the test controls.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-zatca-reporting.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-zatca-reporting-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.14.1-test' } };
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
// These run as the ZATCA edition (the KOT edition has no ZATCA features).
require('../main/edition').setEditionForTests('zatca');
const saudiVatPack = require('../main/tax-packs/community-saudi-arabia.json');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { zatcaRoutes } = require('../main/routes/zatca');
const { createFatooraClient } = require('../main/services/zatca/fatoora');
const { saveSigningCredential } = require('../main/services/zatca/credentials');
const { invoiceHash } = require('../main/services/zatca/signing');
const { setReportingClientForTests } = require('../main/services/zatca/reporting-worker');
const { backoffMs, reportingSummary } = require('../main/services/zatca/reporting');
const { makeTestCredential } = require('./helpers/zatca-test-credential');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

type Mode = 'ok' | 'warning' | 'reject' | 'down' | 'auth';

/** A stand-in for FATOORA's reporting endpoint. */
function fakeFatoora(credential: { certificate: string }, secret: string) {
  const state = { mode: 'ok' as Mode, received: [] as Array<{ uuid: string; xml: string }> };
  const expectedAuth = () => {
    const token = Buffer.from(credential.certificate, 'utf8').toString('base64');
    return `Basic ${Buffer.from(`${token}:${secret}`).toString('base64')}`;
  };
  const server = http.createServer((req: any, res: any) => {
    let raw = '';
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url !== '/invoices/reporting/single') return send(404, {});
      if (req.headers['clearance-status'] !== '0' || req.headers['accept-version'] !== 'V2') {
        return send(400, { message: 'bad headers' });
      }
      if (state.mode === 'auth' || req.headers.authorization !== expectedAuth()) {
        return send(401, {});
      }
      if (state.mode === 'down') return send(503, { message: 'Service unavailable' });
      const body = JSON.parse(raw);
      const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
      state.received.push({ uuid: body.uuid, xml });
      if (invoiceHash(xml) !== body.invoiceHash || !xml.includes(body.uuid)) {
        return send(400, {
          validationResults: {
            status: 'ERROR',
            errorMessages: [{ code: 'invoiceHash_QRCODE_INVALID', message: 'hash mismatch' }],
            warningMessages: [],
          },
          reportingStatus: 'NOT_REPORTED',
        });
      }
      if (state.mode === 'reject') {
        return send(400, {
          validationResults: {
            status: 'ERROR',
            errorMessages: [{ code: 'BR-KSA-37', message: 'The seller address is invalid' }],
            warningMessages: [],
          },
          reportingStatus: 'NOT_REPORTED',
        });
      }
      if (state.mode === 'warning') {
        return send(202, {
          validationResults: {
            status: 'WARNING',
            errorMessages: [],
            warningMessages: [{ code: 'BR-KSA-F-06', message: 'Check the item name' }],
          },
          reportingStatus: 'REPORTED',
        });
      }
      send(200, {
        validationResults: { status: 'PASS', errorMessages: [], warningMessages: [] },
        reportingStatus: 'REPORTED',
      });
    });
  });
  return { state, server };
}

async function main() {
  console.log('ZATCA reporting: queue, retries, verdicts, alerts and the daily review');
  console.log('='.repeat(72));

  const db = initTestDb();
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  setSetting(db, 'taxes_enabled', 'true');
  setSetting(db, 'business_name', 'Reporting Test Shop');
  setSetting(db, 'tax_registration_number', '399999999900003');
  for (const [key, value] of Object.entries({
    zatca_seller_crn: '1010010000',
    zatca_seller_street: 'Prince Naif Road',
    zatca_seller_building_number: '2322',
    zatca_seller_district: 'Al Khalidiyah',
    zatca_seller_city: 'Al Ahsa',
    zatca_seller_postal_code: '36361',
  }))
    setSetting(db, key, value);
  installAndActivateTestTaxPack(db, saudiVatPack);
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-rep', 'Menu');
  seedProduct(db, 'prod-mandi', 'cat-rep', 'Mandi', 57.5, {
    tax_category_id: 'standard',
    tax_behavior: 'inclusive',
  });

  const credential = makeTestCredential();
  const secret = 'reporting-secret';
  const fatoora = fakeFatoora(credential, secret);
  await new Promise<void>((resolve) => fatoora.server.listen(0, '127.0.0.1', resolve));
  const fatooraUrl = `http://127.0.0.1:${fatoora.server.address().port}`;
  setReportingClientForTests(() => createFatooraClient(fatooraUrl));

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/zatca': zatcaRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const zatca = (route: string, method = 'GET', body?: unknown) =>
    api(baseUrl, `/api/zatca${route}`, { method, body, headers: ownerAuth });
  const jobs = () =>
    db
      .prepare(
        `SELECT j.*, d.counter, d.document_type FROM zatca_reporting_jobs j
         JOIN zatca_fiscal_documents d ON d.id = j.document_id ORDER BY d.counter`,
      )
      .all() as any[];

  async function sale() {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-mandi', quantity: 1 }] },
      headers: ownerAuth,
    });
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(
      order.data.order.id,
    );
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.data.order.id },
      headers: ownerAuth,
    });
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: Number(bill.data.bill.total) },
      headers: ownerAuth,
    });
    assertEqualOrThrow(paid.status, 200, 'sale paid');
    return bill.data.bill;
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());

  try {
    console.log('\n─── Backoff ───');
    assertEqualOrThrow(backoffMs(1), 60_000, 'first retry after 1 minute');
    assertEqualOrThrow(backoffMs(3), 240_000, 'third retry after 4 minutes');
    assertEqualOrThrow(backoffMs(12), 3_600_000, 'retries are at most an hour apart');

    console.log('\n─── A till without an API secret keeps documents waiting ───');
    setSetting(db, 'zatca_environment', 'simulation');
    saveSigningCredential(db, { ...credential, environment: 'simulation' }, 'plain_test', now());
    const first = await sale();
    assertEqualOrThrow(jobs().length, 1, 'the signed invoice is queued');
    assertEqualOrThrow(jobs()[0].status, 'pending', 'queued as pending');
    {
      const res = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(res.status, 200, 'send runs');
      assertEqualOrThrow(res.data.result.retrying, 1, 'not sent without an API secret');
      assertOrThrow(
        /no ZATCA API secret/.test(res.data.documents[0].lastError),
        'the day view explains why',
      );
      assertEqualOrThrow(fatoora.state.received.length, 0, 'nothing reached ZATCA');
    }
    saveSigningCredential(db, { ...credential, environment: 'simulation' }, 'plain_test', now(), {
      apiSecret: secret,
    });

    console.log('\n─── ZATCA unavailable: retried with backoff ───');
    fatoora.state.mode = 'down';
    {
      const res = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(res.data.result.retrying, 1, 'kept for a retry');
      const job = jobs()[0];
      assertEqualOrThrow(job.status, 'pending', 'still pending');
      assertOrThrow(job.attempt_count >= 2, 'attempts counted');
      assertOrThrow(/unavailable/i.test(res.data.documents[0].lastError), 'ZATCA error shown');
      const scheduled = await api(baseUrl, '/api/zatca/reporting', { headers: ownerAuth });
      assertEqualOrThrow(scheduled.data.waiting, 1, 'still waiting');
      fatoora.state.mode = 'auth';
      await zatca('/reporting/send', 'POST', {});
      assertEqualOrThrow(jobs()[0].status, 'pending', 'refused credentials are retried too');
    }

    console.log('\n─── Accepted, accepted with warnings, rejected ───');
    fatoora.state.mode = 'ok';
    {
      const res = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(res.data.result.reported, 1, 'reported');
      assertEqualOrThrow(jobs()[0].status, 'reported', 'job reported');
      const bill = await api(baseUrl, `/api/bills/${first.id}`, { headers: ownerAuth });
      assertEqualOrThrow(bill.data.bill.fiscal?.reportingStatus, 'reported', 'bill shows reported');
      const sent = fatoora.state.received.at(-1)!;
      assertOrThrow(
        sent.xml.includes('<cbc:InvoiceTypeCode name="0200000">388<'),
        'the signed invoice was sent',
      );
    }
    fatoora.state.mode = 'warning';
    await sale();
    fatoora.state.mode = 'reject';
    const rejectedBill = await sale();
    {
      fatoora.state.mode = 'warning';
      await zatca('/reporting/send', 'POST', { document_ids: [jobs()[1].document_id] });
      fatoora.state.mode = 'reject';
      const res = await zatca('/reporting/send', 'POST', { date: today });
      const statuses = jobs().map((j) => j.status);
      assertEqualOrThrow(statuses.join(','), 'reported,warning,rejected', 'verdicts stored');
      const rejected = res.data.documents.find((d: any) => d.status === 'rejected');
      assertOrThrow(/BR-KSA-37/.test(rejected.errors.join(' ')), "ZATCA's errors are kept");
      const warned = res.data.documents.find((d: any) => d.status === 'warning');
      assertOrThrow(/BR-KSA-F-06/.test(warned.warnings.join(' ')), 'warnings are kept');
      assertEqualOrThrow(res.data.summary.rejected, 1, 'summary counts the rejection');
      const again = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(
        again.data.result.attempted,
        0,
        'rejected documents are not resent automatically',
      );
      fatoora.state.mode = 'ok';
      const resend = await zatca('/reporting/send', 'POST', {
        date: today,
        document_ids: [rejected.id],
      });
      assertEqualOrThrow(
        resend.data.result.reported,
        1,
        'the accountant can send a rejected one again',
      );
      void rejectedBill;
    }

    console.log('\n─── Refunds: the credit note is queued and reported ───');
    {
      const refund = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        body: {
          bill_id: first.id,
          amount: 11.5,
          method: 'cash',
          reason: 'Wrong item',
          override_pin: '1234',
          approver_id: managerId,
        },
        headers: managerAuth,
      });
      assertEqualOrThrow(refund.status, 201, 'refund created');
      const credit = jobs().find((j) => j.document_type === 'simplified_credit_note');
      assertEqualOrThrow(credit?.status, 'pending', 'credit note queued');
      const res = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(res.data.result.reported, 1, 'credit note reported');
      assertOrThrow(
        fatoora.state.received.at(-1)!.xml.includes('>381</cbc:InvoiceTypeCode>'),
        'the credit note itself was sent',
      );
      const note = res.data.documents.find((d: any) => d.type === 'simplified_credit_note');
      assertOrThrow(/-CN\d+$/.test(note.number), 'credit note number shown');
    }

    console.log('\n─── 24-hour limit alerts ───');
    {
      fatoora.state.mode = 'down';
      await sale();
      const issued = Date.now();
      assertEqualOrThrow(reportingSummary(db, new Date(issued)).nearLimit, 0, 'fresh: no alert');
      const at13h = reportingSummary(db, new Date(issued + 13 * 3_600_000));
      assertEqualOrThrow(at13h.waiting, 1, 'one waiting');
      assertEqualOrThrow(at13h.nearLimit, 1, 'alert after 12 hours');
      const at25h = reportingSummary(db, new Date(issued + 25 * 3_600_000));
      assertEqualOrThrow(at25h.overdue, 1, 'overdue after 24 hours');
      assertEqualOrThrow(at25h.nearLimit, 0, 'not double-counted');
      const res = await zatca('/reporting');
      assertEqualOrThrow(res.status, 200, 'summary endpoint works');
      assertEqualOrThrow(res.data.waiting, 1, 'summary endpoint reports the waiting document');
      fatoora.state.mode = 'ok';
    }

    console.log('\n─── Daily review ───');
    {
      const day = await zatca(`/reporting/day?date=${today}`);
      assertEqualOrThrow(day.status, 200, 'day view');
      assertEqualOrThrow(day.data.documents.length, 5, "today's 4 invoices and 1 credit note");
      assertEqualOrThrow(day.data.reviewed, null, 'not reviewed yet');
      const bad = await zatca('/reporting/day?date=yesterday');
      assertEqualOrThrow(bad.status, 400, 'date is validated');
      const empty = await zatca('/reporting/review', 'POST', { date: '2020-01-01' });
      assertEqualOrThrow(empty.status, 409, 'an empty day cannot be marked reviewed');
      const reviewed = await zatca('/reporting/review', 'POST', { date: today });
      assertEqualOrThrow(reviewed.status, 200, 'day marked reviewed');
      assertOrThrow(Boolean(reviewed.data.reviewed?.by), 'reviewer recorded');
      assertOrThrow(
        reviewed.data.documents.some((d: any) => d.status === 'pending'),
        'reviewing does not change reporting',
      );
      const send = await zatca('/reporting/send', 'POST', { date: today });
      assertEqualOrThrow(send.data.result.reported, 1, 'waiting document sent by hand');
      assertEqualOrThrow(send.data.summary.waiting, 0, 'nothing waiting');
    }

    console.log('\n─── Off: nothing new is queued, and reporting endpoints need a login ───');
    {
      setSetting(db, 'zatca_environment', 'disabled');
      const before = jobs().length;
      await sale();
      assertEqualOrThrow(jobs().length, before, 'no job while issuance is off');
      const anon = await api(baseUrl, '/api/zatca/reporting');
      assertEqualOrThrow(anon.status, 401, 'login required');
    }
  } finally {
    server.close();
    fatoora.server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed } = getResults();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

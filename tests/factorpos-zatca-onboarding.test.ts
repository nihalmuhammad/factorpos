/**
 * FactorPOS ZATCA onboarding (roadmap phase 5): seller details, OTP → compliance CSID,
 * compliance checks, production CSID, then switching simulation invoices on and selling.
 * FATOORA is replaced by a local server that issues test certificates for the till's key.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-zatca-onboarding.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-zatca-onboarding-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => '3.14.1-test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
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
const { zatcaRoutes, setFatooraClientForTests } = require('../main/routes/zatca');
const { createFatooraClient } = require('../main/services/zatca/fatoora');
const { invoiceHash } = require('../main/services/zatca/signing');
const { certificateForPublicKey, csrPublicKey } = require('./helpers/zatca-test-credential');
const { execFileSync } = require('child_process');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

function findSdk(): string | null {
  if (process.env.ZATCA_SDK_LAUNCHER) return process.env.ZATCA_SDK_LAUNCHER;
  for (let dir = path.resolve(__dirname); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.local-tools', 'zatca-sdk');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The SDK checks the signature's issuer and serial against the certificate in its
// config, so each run is given the certificate the document was signed with.
function sdkValidate(sdk: string, xml: string, previousHash: string, certificate: string): string {
  const sdkDir = path.join(path.dirname(sdk), 'zatca-einvoicing-sdk-Java-238-R3.4.8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-onboarding-sdk-'));
  fs.writeFileSync(path.join(dir, 'document.xml'), xml);
  fs.writeFileSync(path.join(dir, 'pih.txt'), previousHash);
  const config = JSON.parse(
    fs.readFileSync(path.join(sdkDir, 'Configuration', 'local-config.json'), 'utf8'),
  );
  config.pihPath = path.join(dir, 'pih.txt');
  fs.writeFileSync(path.join(dir, 'cert.pem'), certificate); // the SDK reads bare Base64
  config.certPath = path.join(dir, 'cert.pem');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  try {
    return execFileSync(sdk, ['-validate', '-invoice', path.join(dir, 'document.xml')], {
      cwd: dir,
      env: { ...process.env, SDK_CONFIG: path.join(dir, 'config.json') },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in for the FATOORA API: checks what FactorPOS sends, issues test certificates. */
function fakeFatoora() {
  const state = {
    otp: '123456',
    failNextCheck: false,
    publicKey: null as Buffer | null,
    compliance: {
      certificate: '',
      secret: 'compliance-secret',
      requestId: '1234567890123',
    },
    production: {
      certificate: '',
      secret: 'production-secret',
      requestId: '30368',
    },
    submitted: [] as Array<{ xml: string; uuid: string; invoiceHash: string }>,
    calls: [] as string[],
  };
  const token = (certificate: string) => Buffer.from(certificate, 'utf8').toString('base64');
  const authOk = (header: string, issued: { certificate: string; secret: string }) =>
    header ===
    `Basic ${Buffer.from(`${token(issued.certificate)}:${issued.secret}`).toString('base64')}`;

  const server = http.createServer((req: any, res: any) => {
    let raw = '';
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      state.calls.push(req.url);
      if (req.headers['accept-version'] !== 'V2')
        return send(400, { message: 'Accept-Version V2 required' });
      if (req.url === '/compliance') {
        if (req.headers.otp !== state.otp) {
          return send(400, {
            errors: [{ code: 'Invalid-OTP', message: 'The provided OTP is invalid' }],
          });
        }
        state.publicKey = csrPublicKey(body.csr);
        state.compliance.certificate = certificateForPublicKey(state.publicKey, 'compliance');
        return send(200, {
          requestID: Number(state.compliance.requestId),
          dispositionMessage: 'ISSUED',
          binarySecurityToken: token(state.compliance.certificate),
          secret: state.compliance.secret,
        });
      }
      if (req.url === '/compliance/invoices') {
        if (!authOk(req.headers.authorization, state.compliance)) return send(401, {});
        const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
        state.submitted.push({
          xml,
          uuid: body.uuid,
          invoiceHash: body.invoiceHash,
        });
        const hashOk = invoiceHash(xml) === body.invoiceHash && xml.includes(body.uuid);
        if (!hashOk || state.failNextCheck) {
          state.failNextCheck = false;
          return send(400, {
            validationResults: {
              status: 'ERROR',
              errorMessages: [
                {
                  code: 'invalid-invoice-hash',
                  message: 'The invoice hash is wrong',
                },
              ],
              warningMessages: [],
            },
            reportingStatus: 'NOT_REPORTED',
          });
        }
        return send(200, {
          validationResults: {
            status: 'PASS',
            errorMessages: [],
            warningMessages: [],
          },
          reportingStatus: 'REPORTED',
        });
      }
      if (req.url === '/production/csids') {
        if (!authOk(req.headers.authorization, state.compliance)) return send(401, {});
        if (String(body.compliance_request_id) !== state.compliance.requestId) return send(400, {});
        state.production.certificate = certificateForPublicKey(state.publicKey!, 'production');
        return send(200, {
          requestID: Number(state.production.requestId),
          dispositionMessage: 'ISSUED',
          binarySecurityToken: token(state.production.certificate),
          secret: state.production.secret,
        });
      }
      send(404, {});
    });
  });
  return { state, server };
}

async function main() {
  console.log('ZATCA onboarding: seller details, OTP, compliance checks, production certificate');
  console.log('='.repeat(72));

  const db = initTestDb();
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  setSetting(db, 'taxes_enabled', 'true');
  setSetting(db, 'business_name', 'Onboarding Test Shop');
  setSetting(db, 'tax_registration_number', '399999999900003');
  installAndActivateTestTaxPack(db, saudiVatPack);
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  seedCategory(db, 'cat-onb', 'Menu');
  seedProduct(db, 'prod-mandi', 'cat-onb', 'Mandi', 57.5, {
    tax_category_id: 'standard',
    tax_behavior: 'inclusive',
  });

  const fatoora = fakeFatoora();
  await new Promise<void>((resolve) => fatoora.server.listen(0, '127.0.0.1', resolve));
  const fatooraUrl = `http://127.0.0.1:${fatoora.server.address().port}`;
  setFatooraClientForTests(() => createFatooraClient(fatooraUrl));

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/zatca': zatcaRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const zatca = (route: string, method = 'GET', body?: unknown) =>
    api(baseUrl, `/api/zatca${route}`, { method, body, headers: ownerAuth });

  try {
    console.log('\n─── Overview before anything is set ───');
    {
      const res = await zatca('');
      assertEqualOrThrow(res.status, 200, 'GET /api/zatca works');
      assertEqualOrThrow(res.data.environment, 'disabled', 'issuance is off');
      assertEqualOrThrow(res.data.onboarding.status, 'not_started', 'not onboarded');
      assertEqualOrThrow(res.data.certificate, null, 'no certificate');
      assertEqualOrThrow(res.data.seller_check.complete, false, 'seller details incomplete');
      assertEqualOrThrow(res.data.seller.vat_number, '399999999900003', 'shows the VAT number');
      const noAuth = await api(baseUrl, '/api/zatca');
      assertEqualOrThrow(noAuth.status, 401, 'needs a signed-in user');
    }

    console.log('\n─── Seller details are validated and saved ───');
    {
      const bad = await zatca('/seller', 'PUT', { building_number: '12' });
      assertEqualOrThrow(bad.status, 400, 'a 2-digit building number is refused');
      assertEqualOrThrow(bad.data.field, 'building_number', 'the refusal names the field');
      const badCrn = await zatca('/seller', 'PUT', { crn: 'ABC' });
      assertEqualOrThrow(badCrn.status, 400, 'a malformed CR number is refused');
      const early = await zatca('/onboarding', 'POST', { otp: '123456' });
      assertEqualOrThrow(early.status, 400, 'onboarding refused while seller details are missing');
      assertOrThrow(/incomplete/.test(early.data.error), 'refusal says the details are incomplete');
      assertEqualOrThrow(fatoora.state.calls.length, 0, 'ZATCA was not called');
      const saved = await zatca('/seller', 'PUT', {
        crn: '1010010000',
        street: 'Prince Naif Road',
        building_number: '2322',
        district: 'Al Khalidiyah',
        city: 'Al Ahsa',
        postal_code: '36361',
        branch_name: 'Khalidiyah Branch',
        industry: 'Restaurant',
      });
      assertEqualOrThrow(saved.status, 200, 'seller details saved');
      assertEqualOrThrow(saved.data.seller_check.complete, true, 'seller details complete');
      assertEqualOrThrow(saved.data.seller.city, 'Al Ahsa', 'city echoed back');
    }

    console.log('\n─── Switching invoices on needs onboarding first ───');
    {
      const res = await zatca('/environment', 'PUT', {
        environment: 'simulation',
      });
      assertEqualOrThrow(res.status, 409, 'simulation refused before onboarding');
      assertEqualOrThrow(res.data.code, 'zatca_not_onboarded', 'refusal code');
      const prod = await zatca('/environment', 'PUT', {
        environment: 'production',
      });
      assertEqualOrThrow(prod.status, 409, 'production is refused');
    }

    console.log('\n─── Keys need secure storage outside tests ───');
    {
      delete process.env.FACTORPOS_ZATCA_PLAIN_TEST_KEYS;
      const res = await zatca('/onboarding', 'POST', { otp: '123456' });
      assertEqualOrThrow(res.status, 409, 'refused without secure storage');
      assertOrThrow(/Secure storage is unavailable/.test(res.data.error), 'explains why');
      assertEqualOrThrow(fatoora.state.calls.length, 0, 'ZATCA was not called');
      process.env.FACTORPOS_ZATCA_PLAIN_TEST_KEYS = '1';
    }

    console.log('\n─── OTP is required and checked ───');
    {
      const none = await zatca('/onboarding', 'POST', {});
      assertEqualOrThrow(none.status, 400, 'missing OTP refused');
      assertEqualOrThrow(none.data.code, 'zatca_otp_required', 'refusal code');
      const short = await zatca('/onboarding', 'POST', { otp: '12' });
      assertEqualOrThrow(short.status, 400, 'a short OTP is refused');
      const wrong = await zatca('/onboarding', 'POST', { otp: '654321' });
      assertEqualOrThrow(wrong.status, 422, 'ZATCA refusing the OTP is shown to the user');
      assertOrThrow(/OTP is invalid/.test(wrong.data.error), "ZATCA's message is passed on");
      const state = await zatca('');
      assertEqualOrThrow(state.data.onboarding.status, 'started', 'request kept for a retry');
      assertOrThrow(/OTP is invalid/.test(state.data.onboarding.lastError), 'last error saved');
    }

    console.log('\n─── A failed compliance check resumes without a new OTP ───');
    {
      fatoora.state.failNextCheck = true;
      const res = await zatca('/onboarding', 'POST', { otp: '123456' });
      assertEqualOrThrow(res.status, 422, 'failed compliance check reported');
      assertOrThrow(/compliance checks failed/.test(res.data.error), 'explains the failure');
      const state = await zatca('');
      assertEqualOrThrow(state.data.onboarding.status, 'compliance_issued', 'compliance CSID kept');
      assertEqualOrThrow(state.data.onboarding.checks[0].passed, false, 'failed check recorded');
      assertEqualOrThrow(state.data.certificate, null, 'no signing certificate yet');

      const row = db
        .prepare('SELECT * FROM zatca_onboarding ORDER BY id DESC LIMIT 1')
        .get() as any;
      const csr = Buffer.from(row.csr, 'base64').toString('utf8');
      assertOrThrow(
        csr.startsWith('-----BEGIN CERTIFICATE REQUEST-----'),
        'CSR stored as PEM Base64',
      );
      const settings = db
        .prepare("SELECT value FROM settings WHERE key = 'zatca_egs_uuid'")
        .get() as any;
      assertEqualOrThrow(row.egs_uuid, settings.value, 'the till keeps one EGS id');

      const resumed = await zatca('/onboarding', 'POST', {});
      assertEqualOrThrow(resumed.status, 200, 'resumed without an OTP');
      assertEqualOrThrow(resumed.data.onboarding.status, 'active', 'onboarding complete');
      assertEqualOrThrow(resumed.data.onboarding.lastError, null, 'error cleared');
      const checks = resumed.data.onboarding.checks.map((c: any) => `${c.document}:${c.passed}`);
      assertEqualOrThrow(
        checks.join(','),
        'invoice:true,credit_note:true,debit_note:true',
        'invoice, credit note and debit note all passed',
      );
      assertEqualOrThrow(resumed.data.certificate.onboarded, true, 'certificate from onboarding');
      assertOrThrow(
        /^2036-01-01/.test(resumed.data.certificate.expiresAt),
        'expiry read from the certificate',
      );
      assertEqualOrThrow(
        resumed.data.certificate.egsUuid,
        row.egs_uuid,
        'certificate belongs to this till',
      );
      assertOrThrow(!JSON.stringify(resumed.data).includes('secret'), 'no secret in the response');
    }

    console.log('\n─── What was sent to ZATCA ───');
    {
      const sent = fatoora.state.submitted.slice(-3);
      const codes = sent.map((s) => /<cbc:InvoiceTypeCode name="0200000">(\d+)</.exec(s.xml)?.[1]);
      assertEqualOrThrow(
        codes.join(','),
        '388,381,383',
        'simplified invoice, credit note, debit note',
      );
      assertOrThrow(
        sent.every((s) => s.xml.includes(fatoora.state.compliance.certificate)),
        'samples are signed with the compliance certificate',
      );
      assertOrThrow(
        sent[1].xml.includes(`<cbc:UUID>2</cbc:UUID>`) &&
          sent[2].xml.includes('<cbc:UUID>3</cbc:UUID>'),
        'samples are numbered 1, 2, 3',
      );
      const sdk = findSdk();
      if (sdk) {
        let previous =
          'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
        for (const doc of sent) {
          const out = sdkValidate(sdk, doc.xml, previous, fatoora.state.compliance.certificate);
          previous = doc.invoiceHash;
          if (!/GLOBAL VALIDATION RESULT = PASSED/.test(out)) {
            console.log(
              out
                .split('\n')
                .filter((l: string) => /ERROR|FAILED/.test(l))
                .join('\n'),
            );
          }
          assertOrThrow(
            /GLOBAL VALIDATION RESULT = PASSED/.test(out),
            `SDK passes the ${doc.uuid.slice(0, 8)} sample`,
          );
        }
      } else {
        console.log('  (ZATCA SDK not installed: SDK validation skipped)');
      }
      const row = db.prepare('SELECT * FROM zatca_credentials WHERE active = 1').get() as any;
      assertEqualOrThrow(
        row.certificate,
        fatoora.state.production.certificate,
        'production certificate stored',
      );
      assertEqualOrThrow(
        row.api_secret,
        'production-secret',
        'API secret stored (plain only in tests)',
      );
      assertEqualOrThrow(row.request_id, '30368', 'request id stored');
    }

    console.log('\n─── Invoices on: a sale is signed with the new certificate ───');
    {
      const on = await zatca('/environment', 'PUT', {
        environment: 'simulation',
      });
      assertEqualOrThrow(on.status, 200, 'simulation switched on');
      assertEqualOrThrow(on.data.environment, 'simulation', 'environment is simulation');
      const order = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: {
          type: 'takeaway',
          items: [{ product_id: 'prod-mandi', quantity: 1 }],
        },
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
      assertEqualOrThrow(paid.data.fiscal?.issuanceStatus, 'signed', 'invoice signed');
      const doc = db.prepare('SELECT signed_xml FROM zatca_fiscal_documents').get() as any;
      assertOrThrow(
        doc.signed_xml.includes(fatoora.state.production.certificate),
        'signed with the production certificate',
      );
      assertOrThrow(
        !doc.signed_xml.includes('Compliance check'),
        'compliance samples are not part of the real invoice chain',
      );
      const off = await zatca('/environment', 'PUT', {
        environment: 'disabled',
      });
      assertEqualOrThrow(off.data.environment, 'disabled', 'switched off again');
    }

    console.log('\n─── Renewal starts a new request and needs a new OTP ───');
    {
      const none = await zatca('/onboarding', 'POST', {});
      assertEqualOrThrow(none.status, 400, 'renewal needs an OTP');
      const renewed = await zatca('/onboarding', 'POST', { otp: '123456' });
      assertEqualOrThrow(renewed.status, 200, 'renewed');
      const active = db
        .prepare('SELECT COUNT(*) AS n FROM zatca_credentials WHERE active = 1')
        .get() as any;
      assertEqualOrThrow(active.n, 1, 'one active certificate after renewal');
      const all = db.prepare('SELECT COUNT(*) AS n FROM zatca_credentials').get() as any;
      assertEqualOrThrow(all.n, 2, 'the earlier certificate is kept, inactive');
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

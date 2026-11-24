/**
 * FactorPOS Submit Ticket delivery: the POS relay (main/services/factorpos-ticket-relay.ts) and
 * the Apps Script receiver (scripts/support-ticket-apps-script/Code.gs), run in Node with fake
 * Google services.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-ticket-relay.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-ticket-relay-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.JWT_SECRET = 'ticket-relay-secret';

const H = require('./helpers/test-setup');
const { getDatabase, closeDatabase, upsertSettings } = require('../main/db');
const relayModule = require('../main/services/factorpos-ticket-relay');
const { supportTicketRoutes } = require('../main/routes/support-ticket');

const { FactorposTicketRelay, parseTicketRelayConfig, isTicketRelayConfigured } = relayModule;
const { assertOrThrow, assertEqualOrThrow } = H;

const GOOD_URL = 'https://script.google.com/macros/s/AKfycbTestDeployment123/exec';

// ── Apps Script sandbox ──────────────────────────────────────────────────────
function loadAppsScript(props: Record<string, string>, deployer = 'deployer@example.com') {
  const sent: any[] = [];
  const rows: any[][] = [];
  const files: { name: string; content: string }[] = [];
  const store = { ...props };
  const sheet = { appendRow: (r: any[]) => rows.push(r), setFrozenRows: () => {} };
  const context: any = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k: string) => (k in store ? store[k] : null),
        setProperty: (k: string, v: string) => {
          store[k] = v;
        },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => deployer }) },
    MailApp: {
      sendEmail: (to: string, subject: string, body: string, options: any) =>
        sent.push({ to, subject, body, options }),
    },
    Utilities: {
      formatDate: () => '20261124',
      newBlob: (content: string, type: string, name: string) => ({ content, type, name }),
    },
    DriveApp: {
      getFolderById: () => ({
        createFile: (name: string, content: string) => {
          files.push({ name, content });
          return { getUrl: () => `https://drive.google.com/file/d/${name}` };
        },
      }),
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    SpreadsheetApp: {
      openById: () => ({ getSheetByName: () => null, insertSheet: () => sheet }),
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text: string) => ({
        text,
        setMimeType() {
          return this;
        },
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../scripts/support-ticket-apps-script/Code.gs'), 'utf8'),
    context,
  );
  const post = (body: unknown) =>
    JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { post, sent, rows, files, store, context };
}

async function main() {
  console.log('FactorPOS Submit Ticket delivery');
  console.log('='.repeat(50));

  console.log('\n--- Apps Script receiver ---');
  const script = loadAppsScript({
    TICKET_SECRET: 's3cret',
    SHEET_ID: 'sheet',
    LOG_FOLDER_ID: 'folder',
  });
  const ticket = {
    client_ticket_id: '0f8c2b6e-1111-4222-8333-944455556666',
    subject: 'Printer stopped',
    message: '=HYPERLINK("x") the kitchen printer stopped',
    severity: 'high',
    event_code: 'support.printer',
    contact: { name: 'Sinan', email: 'sinan@example.com', phone: '+966500000000' },
    app_version: '3.14.1-beta.2',
    diagnostics: { restaurant_name: 'Test Cafe', device_name: 'TEST-POS', category: 'printer' },
    log_tail: '[Print] failed',
  };
  assertEqualOrThrow(
    script.post({ secret: 'wrong', ticket }).ok,
    false,
    'a wrong secret is refused',
  );
  assertEqualOrThrow(script.sent.length, 0, 'a refused ticket sends no email');
  const first = script.post({ secret: 's3cret', ticket });
  assertEqualOrThrow(first.ok, true, 'a ticket with the right secret is accepted');
  assertOrThrow(
    /^FP-20261124-0F8C2B$/.test(first.support_code),
    `support code ${first.support_code}`,
  );
  assertEqualOrThrow(script.sent.length, 1, 'one email is sent');
  const mail = script.sent[0];
  assertEqualOrThrow(
    mail.to,
    'deployer@example.com',
    'without NOTIFY_EMAIL the email goes to the account that deployed the script',
  );
  {
    const configured = loadAppsScript({
      TICKET_SECRET: 's3cret',
      NOTIFY_EMAIL: 'owner@example.com',
    });
    configured.post({ secret: 's3cret', ticket });
    assertEqualOrThrow(
      configured.sent[0]?.to,
      'owner@example.com',
      'NOTIFY_EMAIL is used when set',
    );
    const nowhere = loadAppsScript({ TICKET_SECRET: 's3cret' }, '');
    const refused = nowhere.post({ secret: 's3cret', ticket });
    assertEqualOrThrow(refused.ok, false, 'with no address at all the ticket is not accepted');
    assertOrThrow(
      /NOTIFY_EMAIL/.test(String(refused.error)),
      'and the error says to set NOTIFY_EMAIL',
    );
    assertEqualOrThrow(
      nowhere.store[`ticket:${ticket.client_ticket_id}`],
      undefined,
      'so the POS retries it',
    );
  }
  assertOrThrow(
    mail.subject.includes('Test Cafe') && mail.subject.includes('HIGH'),
    `subject names store and severity (${mail.subject})`,
  );
  assertOrThrow(
    mail.body.includes('TEST-POS') && mail.body.includes('3.14.1-beta.2'),
    'body names the PC and version',
  );
  assertEqualOrThrow(mail.options.replyTo, 'sinan@example.com', 'replies go to the ticket contact');
  assertOrThrow(
    mail.options.attachments.some(
      (a: any) => a.name.endsWith('-log.txt') && a.content === '[Print] failed',
    ),
    'the log is attached',
  );
  assertEqualOrThrow(script.rows.length, 2, 'the Sheet gets a header and one ticket row');
  assertOrThrow(
    String(script.rows[1][9]).startsWith("'="),
    'a message starting with = is stored as text, not a formula',
  );
  assertEqualOrThrow(script.files.length, 1, 'the log is saved in Drive');
  const retry = script.post({ secret: 's3cret', ticket });
  assertEqualOrThrow(retry.support_code, first.support_code, 'a retry gets the same support code');
  assertEqualOrThrow(script.sent.length, 1, 'a retry sends no second email');
  const custom = loadAppsScript({ TICKET_SECRET: 'x', NOTIFY_EMAIL: 'other@example.com' });
  custom.post({ secret: 'x', ticket });
  assertEqualOrThrow(
    custom.sent[0].to,
    'other@example.com',
    'NOTIFY_EMAIL overrides the recipient',
  );
  assertEqualOrThrow(custom.rows.length, 0, 'no Sheet configured: no rows, still emailed');
  const noSecret = loadAppsScript({});
  assertEqualOrThrow(
    noSecret.post({ secret: '', ticket }).ok,
    false,
    'no TICKET_SECRET set: everything is refused',
  );

  console.log('\n--- endpoint validation ---');
  assertOrThrow(
    parseTicketRelayConfig(GOOD_URL, 'k') !== null,
    'an Apps Script /exec URL is accepted',
  );
  for (const bad of [
    'http://script.google.com/macros/s/abc/exec',
    'https://evil.example.com/macros/s/abc/exec',
    'https://script.google.com.evil.com/macros/s/abc/exec',
    'https://script.google.com/macros/s/abc/dev',
  ]) {
    assertEqualOrThrow(parseTicketRelayConfig(bad, 'k'), null, `rejected: ${bad}`);
  }
  assertEqualOrThrow(
    parseTicketRelayConfig(GOOD_URL, ''),
    null,
    'a URL without a secret is rejected',
  );

  console.log('\n--- POS relay ---');
  const db = H.initTestDb();
  const { authHeader } = H.seedOwnerUser(db);
  const app = H.createApp({ '/api/support-ticket': supportTicketRoutes });
  const { baseUrl, server } = await H.startServer(app);
  try {
    assertEqualOrThrow(isTicketRelayConfigured(), false, 'unconfigured by default in a dev build');
    const submit = async (subject: string) => {
      const res = await H.api(baseUrl, '/api/support-ticket', {
        method: 'POST',
        headers: authHeader,
        body: { subject, message: 'Something broke', category: 'general', log_tail: 'line 1' },
      });
      assertEqualOrThrow(res.status, 202, `ticket "${subject}" is queued (202)`);
      return res.data.client_ticket_id as string;
    };
    const status = (id: string) =>
      getDatabase()
        .prepare(
          'SELECT status, support_code, attempt_count, last_error, next_attempt_at FROM support_ticket_outbox WHERE client_ticket_id = ?',
        )
        .get(id) as any;

    const calls: { url: string; body: any }[] = [];
    let reply: () => Response = () =>
      new Response(JSON.stringify({ ok: true, support_code: 'FP-TEST-1' }), { status: 200 });
    const relay = new FactorposTicketRelay(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return reply();
    });

    const idUnconfigured = await submit('before config');
    await relay.flush();
    assertEqualOrThrow(calls.length, 0, 'without an endpoint nothing is sent');
    assertEqualOrThrow(status(idUnconfigured).status, 'pending', 'the ticket stays queued');

    upsertSettings({
      factorpos_support_ticket_url: GOOD_URL,
      factorpos_support_ticket_secret: 'pos-secret',
    });
    assertEqualOrThrow(isTicketRelayConfigured(), true, 'a settings override configures the relay');
    await relay.flush();
    assertEqualOrThrow(calls.length, 1, 'the queued ticket is sent once configured');
    assertEqualOrThrow(calls[0].url, GOOD_URL, 'it goes to the Apps Script URL');
    assertEqualOrThrow(calls[0].body.secret, 'pos-secret', 'the shared secret travels in the body');
    assertEqualOrThrow(
      calls[0].body.ticket.subject,
      'before config',
      'the ticket is the queued payload',
    );
    assertOrThrow(
      typeof calls[0].body.ticket.diagnostics?.device_name === 'string',
      'diagnostics include the PC name',
    );
    assertEqualOrThrow(calls[0].body.ticket.log_tail, 'line 1', 'the attached log is sent');
    const delivered = status(idUnconfigured);
    assertEqualOrThrow(delivered.status, 'delivered', 'the ticket is marked delivered');
    assertEqualOrThrow(
      delivered.support_code,
      'FP-TEST-1',
      'the support code is stored for the Support screen',
    );

    reply = () => new Response('<html>Sign in</html>', { status: 200 });
    const idHtml = await submit('wrong access');
    await relay.flush();
    const htmlRow = status(idHtml);
    assertEqualOrThrow(
      htmlRow.status,
      'failed',
      'an HTML answer (deployment not public) is a failure',
    );
    assertOrThrow(
      String(htmlRow.last_error).includes('Apps Script deployment access'),
      `error explains it (${htmlRow.last_error})`,
    );
    assertEqualOrThrow(htmlRow.attempt_count, 1, 'one attempt is counted');
    const callsBefore = calls.length;
    await relay.flush();
    assertEqualOrThrow(
      calls.length,
      callsBefore,
      'a failed ticket waits for its backoff before retrying',
    );

    getDatabase()
      .prepare(`UPDATE support_ticket_outbox SET next_attempt_at = NULL WHERE client_ticket_id = ?`)
      .run(idHtml);
    reply = () =>
      new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 200 });
    await relay.flush();
    const refused = status(idHtml);
    assertEqualOrThrow(refused.status, 'failed', 'a refused ticket stays queued as failed');
    assertEqualOrThrow(refused.attempt_count, 2, 'its attempts keep counting');
    assertOrThrow(
      String(refused.last_error).includes('unauthorized'),
      'the refusal reason is stored',
    );

    getDatabase()
      .prepare(`UPDATE support_ticket_outbox SET next_attempt_at = NULL WHERE client_ticket_id = ?`)
      .run(idHtml);
    reply = () =>
      new Response(JSON.stringify({ ok: true, support_code: 'FP-TEST-2' }), { status: 200 });
    await relay.flush();
    assertEqualOrThrow(
      status(idHtml).status,
      'delivered',
      'it is delivered once the endpoint accepts it',
    );

    getDatabase()
      .prepare(`UPDATE support_ticket_outbox SET status = 'sending' WHERE client_ticket_id = ?`)
      .run(idHtml);
    const restarted = new FactorposTicketRelay(async () => reply());
    restarted.start();
    await restarted.stop();
    assertOrThrow(
      ['failed', 'delivered'].includes(status(idHtml).status),
      'a ticket left "sending" by a crash is retried on start',
    );

    const statusRes = await H.api(baseUrl, `/api/support-ticket/${idUnconfigured}/status`, {
      headers: authHeader,
    });
    assertEqualOrThrow(statusRes.status, 200, 'the Support screen status route answers');
    assertEqualOrThrow(statusRes.data.support_code, 'FP-TEST-1', 'and shows the support code');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  const results = H.getResults();
  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

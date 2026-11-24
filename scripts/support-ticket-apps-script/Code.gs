/**
 * FactorPOS Submit Ticket receiver (Google Apps Script web app).
 *
 * The POS posts {"secret": "...", "ticket": {...}} here. Each new ticket is emailed to
 * NOTIFY_EMAIL with its log and diagnostics attached, appended to a Sheet, and its log saved in
 * a Drive folder. Retries of a ticket that already arrived get the same support code back and
 * send no second email.
 *
 * Script properties (Project Settings → Script properties):
 *   TICKET_SECRET   required; the same value as the FACTORPOS_SUPPORT_TICKET_SECRET repo secret
 *   NOTIFY_EMAIL    optional; defaults to the Google account that deployed this script
 *   SHEET_ID        optional; a Google Sheet to log tickets in (a "Tickets" tab is created)
 *   LOG_FOLDER_ID   optional; a Drive folder for each ticket's log file
 *
 * Setup steps: scripts/support-ticket-apps-script/README.md
 */

var MAX_FIELD = 20000;

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var expected = props.getProperty('TICKET_SECRET') || '';
    if (!expected || !safeEquals_(String(body.secret || ''), expected)) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    var ticket = body.ticket;
    if (!ticket || typeof ticket !== 'object') return json_({ ok: false, error: 'missing ticket' });
    var ticketId = String(ticket.client_ticket_id || '').slice(0, 64);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(ticketId)) return json_({ ok: false, error: 'bad ticket id' });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var seenKey = 'ticket:' + ticketId;
      var seen = props.getProperty(seenKey);
      if (seen) return json_({ ok: true, support_code: seen, duplicate: true });

      var code = supportCode_(ticketId);
      var logUrl = saveLog_(props, code, ticket);
      sendEmail_(props, code, ticket, logUrl);
      appendRow_(props, code, ticket, logUrl);
      props.setProperty(seenKey, code);
      return json_({ ok: true, support_code: code });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

/** Lets you open the /exec URL in a browser to confirm the deployment answers. */
function doGet() {
  return json_({ ok: true, service: 'factorpos-support-ticket' });
}

/** NOTIFY_EMAIL, or the account that deployed the script; the address never lives in code. */
function notifyEmail_(props) {
  var address = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
  if (!address) throw new Error('Set the NOTIFY_EMAIL script property');
  return address;
}

function sendEmail_(props, code, t, logUrl) {
  var d = t.diagnostics || {};
  var contact = t.contact || {};
  var store = text_(d.restaurant_name) || 'Unknown store';
  var subject =
    '[FactorPOS ' + code + '] ' + String(t.severity || 'normal').toUpperCase() + ' · ' + store +
    ' · ' + text_(t.subject).slice(0, 150);
  var lines = [
    'Support code: ' + code,
    'Store: ' + store + '   PC: ' + text_(d.device_name) + '   Version: ' + text_(t.app_version || d.app_version),
    'Severity: ' + text_(t.severity) + '   Category: ' + text_(d.category) + '   Event: ' + text_(t.event_code),
    'Correlation id: ' + text_(t.correlation_id),
    'Contact: ' + [text_(contact.name), text_(contact.email), text_(contact.phone)].filter(Boolean).join(' · '),
    'Submitted by role: ' + text_(d.submitted_by_role),
    '',
    'Subject: ' + text_(t.subject),
    '',
    text_(t.message).slice(0, MAX_FIELD),
    '',
    logUrl ? 'Log in Drive: ' + logUrl : 'Log: ' + (t.log_tail ? 'attached' : 'not attached by the user'),
  ];
  var attachments = [
    Utilities.newBlob(JSON.stringify(d, null, 2), 'application/json', code + '-diagnostics.json'),
  ];
  if (t.log_tail) {
    attachments.push(Utilities.newBlob(String(t.log_tail), 'text/plain', code + '-log.txt'));
  }
  var options = { attachments: attachments, name: 'FactorPOS Support' };
  if (contact.email) options.replyTo = String(contact.email);
  MailApp.sendEmail(notifyEmail_(props), subject, lines.join('\n'), options);
}

function saveLog_(props, code, t) {
  var folderId = props.getProperty('LOG_FOLDER_ID');
  if (!folderId) return '';
  var content = [
    'Support code: ' + code,
    'Received: ' + new Date().toISOString(),
    '',
    JSON.stringify(t.diagnostics || {}, null, 2),
    '',
    '--- log tail ---',
    String(t.log_tail || '(not attached)'),
  ].join('\n');
  var file = DriveApp.getFolderById(folderId).createFile(code + '.txt', content, MimeType.PLAIN_TEXT);
  return file.getUrl();
}

function appendRow_(props, code, t, logUrl) {
  var sheetId = props.getProperty('SHEET_ID');
  if (!sheetId) return;
  var book = SpreadsheetApp.openById(sheetId);
  var sheet = book.getSheetByName('Tickets');
  if (!sheet) {
    sheet = book.insertSheet('Tickets');
    sheet.appendRow([
      'Received', 'Support code', 'Store', 'PC', 'Version', 'Severity', 'Category', 'Event',
      'Subject', 'Message', 'Contact', 'Correlation id', 'Log', 'Status',
    ]);
    sheet.setFrozenRows(1);
  }
  var d = t.diagnostics || {};
  var contact = t.contact || {};
  sheet.appendRow([
    new Date(), code, text_(d.restaurant_name), text_(d.device_name), text_(t.app_version || d.app_version),
    text_(t.severity), text_(d.category), text_(t.event_code), text_(t.subject).slice(0, 500),
    text_(t.message).slice(0, 5000),
    [text_(contact.name), text_(contact.email), text_(contact.phone)].filter(Boolean).join(' · '),
    text_(t.correlation_id), logUrl, 'New',
  ].map(noFormula_));
}

function supportCode_(ticketId) {
  var day = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyyMMdd');
  return 'FP-' + day + '-' + ticketId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

function text_(value) {
  return value === undefined || value === null ? '' : String(value);
}

/** Sheet cells starting with = + - @ would run as formulas; prefix them so they stay text. */
function noFormula_(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
}

function safeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

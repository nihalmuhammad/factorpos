/**
 * FactorPOS: reporting signed simplified invoices and credit notes to ZATCA (roadmap
 * phase 6). Decided 2026-11-24: reporting is automatic and cannot be switched off; the
 * accountant reviews each day afterwards and can send waiting documents by hand.
 *
 * Every signed document gets a row in zatca_reporting_jobs in the same transaction that
 * records it. The worker (./reporting-worker.ts) sends due rows; a document without a
 * verdict (offline, ZATCA down, rate limited, credentials refused) is retried with
 * backoff. ZATCA's verdict is final for the row: reported, reported with warnings, or
 * rejected (fix with a credit note). Simplified documents must be reported within
 * 24 hours of issue (BR-KSA-98), so the summary flags documents approaching that limit.
 */
import type { getDatabase } from '../../db';
import { loadSigningCredential, loadReportingAuth } from './credentials';
import { localIssueDateTime } from './document';
import { FatooraError, type FatooraClient, type ReportingResult } from './fatoora';

type Database = ReturnType<typeof getDatabase>;

export type ReportingStatus = 'pending' | 'reported' | 'warning' | 'rejected' | 'review';

const HOUR_MS = 3_600_000;
/** Warn this long after issue when a document is still not reported (limit: 24 h). */
export const REPORTING_WARN_AFTER_MS = 12 * HOUR_MS;
export const REPORTING_LIMIT_MS = 24 * HOUR_MS;
const MAX_BACKOFF_MS = HOUR_MS;

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO → Date. */
export function parseUtc(value: string): Date {
  const text = String(value).trim();
  return new Date(/^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

const sqlTime = (date: Date) => date.toISOString().replace('T', ' ').replace(/\..*$/, '');

function hasJobsTable(db: Database): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'zatca_reporting_jobs'")
      .get(),
  );
}

/** Queues a newly signed document; call inside the transaction that records it. */
export function enqueueReport(db: Database, documentId: string, createdAt: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO zatca_reporting_jobs (document_id, status, attempt_count, next_attempt_at, updated_at)
     VALUES (?, 'pending', 0, ?, ?)`,
  ).run(documentId, createdAt, createdAt);
}

/** Delay before the next try after `attempts` failed tries: 1, 2, 4 … minutes, at most 1 h. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

interface DueJob {
  document_id: string;
  attempt_count: number;
  environment: string;
  invoice_hash: string;
  signed_xml: string;
  counter: number;
}

export interface ReportRunResult {
  attempted: number;
  reported: number;
  warnings: number;
  rejected: number;
  retrying: number;
}

function verdictStatus(result: ReportingResult): ReportingStatus {
  if (result.reportingStatus === 'REPORTED') {
    return result.status === 'WARNING' || result.warnings.length > 0 ? 'warning' : 'reported';
  }
  if (result.httpStatus === 409) return 'review'; // a conflict ZATCA did not explain as reported
  return 'rejected';
}

/**
 * Sends due documents (oldest counter first). With `documentIds`, sends those now,
 * rejected or review ones included (the accountant's retry).
 */
export async function reportDueDocuments(
  db: Database,
  clientFor: (environment: string) => FatooraClient,
  options: {
    now?: Date;
    limit?: number;
    documentIds?: string[];
    /** Send every waiting document now, ignoring the retry schedule (sent by hand). */
    ignoreSchedule?: boolean;
  } = {},
): Promise<ReportRunResult> {
  const result: ReportRunResult = {
    attempted: 0,
    reported: 0,
    warnings: 0,
    rejected: 0,
    retrying: 0,
  };
  if (!hasJobsTable(db)) return result;
  const now = options.now ?? new Date();
  const ids = options.documentIds ?? [];
  const jobs = (
    ids.length > 0
      ? db
          .prepare(
            `SELECT j.document_id, j.attempt_count, d.environment, d.invoice_hash, d.signed_xml, d.counter
             FROM zatca_reporting_jobs j JOIN zatca_fiscal_documents d ON d.id = j.document_id
             WHERE j.status IN ('pending', 'rejected', 'review') AND d.signed_xml IS NOT NULL
               AND j.document_id IN (${ids.map(() => '?').join(',')})
             ORDER BY d.counter`,
          )
          .all(...ids)
      : db
          .prepare(
            `SELECT j.document_id, j.attempt_count, d.environment, d.invoice_hash, d.signed_xml, d.counter
             FROM zatca_reporting_jobs j JOIN zatca_fiscal_documents d ON d.id = j.document_id
             WHERE j.status = 'pending' AND d.signed_xml IS NOT NULL
               AND (? = 1 OR j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
             ORDER BY d.counter LIMIT ?`,
          )
          .all(options.ignoreSchedule ? 1 : 0, sqlTime(now), options.limit ?? 50)
  ) as DueJob[];

  const update = db.prepare(
    `UPDATE zatca_reporting_jobs
     SET status = ?, attempt_count = attempt_count + 1, next_attempt_at = ?, response_json = ?, updated_at = ?
     WHERE document_id = ?`,
  );
  const auths = new Map<string, { certificate: string; secret: string } | null>();
  for (const job of jobs) {
    result.attempted += 1;
    if (!auths.has(job.environment))
      auths.set(job.environment, loadReportingAuth(db, job.environment));
    const auth = auths.get(job.environment);
    const uuid =
      /<cbc:UUID>([0-9a-f-]{36})<\/cbc:UUID>/.exec(job.signed_xml)?.[1] ?? job.document_id;
    const stamp = sqlTime(new Date());
    if (!auth) {
      const message = loadSigningCredential(db, job.environment)
        ? 'This till has a signing certificate but no ZATCA API secret; onboard it to report'
        : 'This till is not onboarded with ZATCA';
      update.run(
        'pending',
        sqlTime(new Date(now.getTime() + MAX_BACKOFF_MS)),
        JSON.stringify({ error: message }),
        stamp,
        job.document_id,
      );
      result.retrying += 1;
      continue;
    }
    try {
      const verdict = await clientFor(job.environment).reportInvoice(auth, {
        invoiceHash: job.invoice_hash,
        uuid,
        xml: job.signed_xml,
      });
      const status = verdictStatus(verdict);
      update.run(status, null, JSON.stringify(verdict), stamp, job.document_id);
      if (status === 'reported') result.reported += 1;
      else if (status === 'warning') result.warnings += 1;
      else result.rejected += 1;
    } catch (error: any) {
      const message = String(error?.message || error);
      const httpStatus = error instanceof FatooraError ? error.status : null;
      const retryAt = new Date(now.getTime() + backoffMs(job.attempt_count + 1));
      update.run(
        'pending',
        sqlTime(retryAt),
        JSON.stringify({ error: message, httpStatus }),
        stamp,
        job.document_id,
      );
      result.retrying += 1;
    }
  }
  return result;
}

export interface ReportingDocument {
  id: string;
  counter: number;
  type: 'simplified_invoice' | 'simplified_credit_note';
  number: string;
  billId: number | null;
  environment: string;
  issuedAt: string;
  issueDate: string;
  issueTime: string;
  totalWithVatMinor: number;
  vatMinor: number;
  status: ReportingStatus;
  attempts: number;
  nextAttemptAt: string | null;
  errors: string[];
  warnings: string[];
  lastError: string | null;
  hoursSinceIssue: number;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

function documentNumber(xml: string): string {
  const afterProfile = xml.indexOf('<cbc:ProfileID>');
  return /<cbc:ID>([^<]*)<\/cbc:ID>/.exec(xml.slice(afterProfile))?.[1] ?? '';
}

function toDocument(row: any, timezone: string, now: Date): ReportingDocument {
  const response = row.response_json ? JSON.parse(row.response_json) : {};
  const local = localIssueDateTime(row.issued_at, timezone);
  return {
    id: row.id,
    counter: row.counter,
    type: row.document_type,
    number: documentNumber(row.signed_xml ?? ''),
    billId: row.bill_id ?? null,
    environment: row.environment,
    issuedAt: row.issued_at,
    issueDate: local.date,
    issueTime: local.time,
    totalWithVatMinor: row.total_with_vat_minor,
    vatMinor: row.vat_minor,
    status: (row.status ?? 'pending') as ReportingStatus,
    attempts: row.attempt_count ?? 0,
    nextAttemptAt: row.next_attempt_at ?? null,
    errors: Array.isArray(response.errors) ? response.errors : [],
    warnings: Array.isArray(response.warnings) ? response.warnings : [],
    lastError: typeof response.error === 'string' ? response.error : null,
    hoursSinceIssue: Math.max(0, (now.getTime() - parseUtc(row.issued_at).getTime()) / HOUR_MS),
    reviewedAt: row.reviewed_at ?? null,
    reviewedBy: row.reviewed_by ?? null,
  };
}

const DOCUMENT_COLUMNS = `d.id, d.counter, d.document_type, d.bill_id, d.environment, d.issued_at,
  d.total_with_vat_minor, d.vat_minor, d.signed_xml, j.status, j.attempt_count, j.next_attempt_at,
  j.response_json, j.reviewed_at, j.reviewed_by`;

/** The documents issued on a local calendar day (the ZATCA issue date), in counter order. */
export function documentsForDay(
  db: Database,
  date: string,
  timezone: string,
  now = new Date(),
): ReportingDocument[] {
  if (!hasJobsTable(db)) return [];
  // Issue dates are local; take a UTC window a day wider each side, then filter exactly.
  const start = new Date(`${date}T00:00:00Z`);
  const from = sqlTime(new Date(start.getTime() - 24 * HOUR_MS));
  const to = sqlTime(new Date(start.getTime() + 48 * HOUR_MS));
  const rows = db
    .prepare(
      `SELECT ${DOCUMENT_COLUMNS} FROM zatca_fiscal_documents d
       LEFT JOIN zatca_reporting_jobs j ON j.document_id = d.id
       WHERE d.issued_at >= ? AND d.issued_at < ? ORDER BY d.counter`,
    )
    .all(from, to);
  return rows.map((row) => toDocument(row, timezone, now)).filter((doc) => doc.issueDate === date);
}

export interface ReportingSummary {
  waiting: number;
  /** Waiting for more than 12 hours: report before the 24-hour limit. */
  nearLimit: number;
  /** Waiting for more than 24 hours: past ZATCA's limit. */
  overdue: number;
  rejected: number;
  warnings: number;
  oldestWaitingIssuedAt: string | null;
  lastError: string | null;
}

/** What needs attention across all days (for alerts). */
export function reportingSummary(db: Database, now = new Date()): ReportingSummary {
  const summary: ReportingSummary = {
    waiting: 0,
    nearLimit: 0,
    overdue: 0,
    rejected: 0,
    warnings: 0,
    oldestWaitingIssuedAt: null,
    lastError: null,
  };
  if (!hasJobsTable(db)) return summary;
  const waiting = db
    .prepare(
      `SELECT d.issued_at, j.response_json FROM zatca_reporting_jobs j
       JOIN zatca_fiscal_documents d ON d.id = j.document_id
       WHERE j.status = 'pending' ORDER BY d.counter`,
    )
    .all() as Array<{ issued_at: string; response_json: string | null }>;
  for (const row of waiting) {
    summary.waiting += 1;
    const age = now.getTime() - parseUtc(row.issued_at).getTime();
    if (age > REPORTING_LIMIT_MS) summary.overdue += 1;
    else if (age > REPORTING_WARN_AFTER_MS) summary.nearLimit += 1;
    summary.oldestWaitingIssuedAt ??= row.issued_at;
    if (row.response_json) {
      const error = JSON.parse(row.response_json)?.error;
      if (typeof error === 'string') summary.lastError = error;
    }
  }
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM zatca_reporting_jobs
       WHERE status IN ('rejected', 'review', 'warning') AND reviewed_at IS NULL GROUP BY status`,
    )
    .all() as Array<{ status: string; n: number }>;
  for (const row of counts) {
    if (row.status === 'warning') summary.warnings += row.n;
    else summary.rejected += row.n;
  }
  return summary;
}

/** Marks every document issued on `date` as reviewed by `reviewer`. Returns how many. */
export function markDayReviewed(
  db: Database,
  date: string,
  timezone: string,
  reviewer: string,
  now = new Date(),
): number {
  const ids = documentsForDay(db, date, timezone, now).map((doc) => doc.id);
  if (ids.length === 0) return 0;
  const stamp = sqlTime(now);
  const update = db.prepare(
    `UPDATE zatca_reporting_jobs SET reviewed_at = ?, reviewed_by = ?, updated_at = ?
     WHERE document_id = ?`,
  );
  db.transaction(() => {
    for (const id of ids) update.run(stamp, reviewer, stamp, id);
  })();
  return ids.length;
}

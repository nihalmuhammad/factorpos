/**
 * FactorPOS: delivers Submit Ticket requests to the owner's Google Apps Script web app
 * (scripts/support-ticket-apps-script), which emails them to the owner and logs them in a Sheet
 * and Drive. FloCafe's cloud flush stands down while this relay is configured, so FactorPOS
 * tickets never go to FloCafe's server.
 *
 * Tickets stay in the existing support_ticket_outbox, so the queue, retries and the status the
 * Support screen shows are unchanged; only the destination differs.
 */
import { getDatabase, getSettingValue, now } from '../db';
import { readBuildSupportTicketSettings } from './build-identity';
import { isOfflineMode } from './offline-mode';

export const SUPPORT_TICKET_URL_SETTING = 'factorpos_support_ticket_url';
export const SUPPORT_TICKET_SECRET_SETTING = 'factorpos_support_ticket_secret';

const FLUSH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const BATCH_SIZE = 10;

export interface TicketRelayConfig {
  url: string;
  secret: string;
}

/** Only an https Google Apps Script web app is accepted, so a settings row cannot redirect tickets elsewhere. */
export function parseTicketRelayConfig(url?: string, secret?: string): TicketRelayConfig | null {
  const rawUrl = url?.trim();
  const rawSecret = secret?.trim();
  if (!rawUrl || !rawSecret) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'script.google.com') return null;
    if (!/^\/macros\/s\/[\w-]+\/exec$/.test(parsed.pathname)) return null;
    return { url: parsed.toString(), secret: rawSecret };
  } catch {
    return null;
  }
}

/** A settings row (for testing a new deployment on one PC) wins over the URL baked into the build. */
export function readTicketRelayConfig(): TicketRelayConfig | null {
  try {
    const build = readBuildSupportTicketSettings();
    const url = getSettingValue(SUPPORT_TICKET_URL_SETTING)?.trim() || build.url;
    const secret = getSettingValue(SUPPORT_TICKET_SECRET_SETTING)?.trim() || build.secret;
    return parseTicketRelayConfig(url, secret);
  } catch {
    return null;
  }
}

export function isTicketRelayConfigured(): boolean {
  return readTicketRelayConfig() !== null;
}

type OutboxRow = { client_ticket_id: string; payload: string; attempt_count: number };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\..*$/, '');
}

export class FactorposTicketRelay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private started = false;
  private stopping = false;

  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  start(): void {
    this.started = true;
    this.stopping = false;
    try {
      // A ticket left 'sending' by a crash or power cut is retried, never lost.
      getDatabase()
        .prepare(
          "UPDATE support_ticket_outbox SET status = 'failed', updated_at = ? WHERE status = 'sending'",
        )
        .run(now());
    } catch (err) {
      console.warn('[Support] Ticket outbox reset failed:', (err as Error).message);
    }
    this.flushSoon();
    this.timer = setInterval(() => this.flushSoon(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushing?.catch(() => undefined);
  }

  /** Starts a flush unless one is already running; never throws. */
  flushSoon(): void {
    if (!this.started || this.stopping || this.flushing) return;
    this.flushing = this.flush()
      .catch((err) => console.warn('[Support] Ticket relay flush failed:', (err as Error).message))
      .finally(() => {
        this.flushing = null;
      });
  }

  /** Sends every due ticket once. Exposed for tests. */
  async flush(): Promise<void> {
    if (isOfflineMode()) return;
    const config = readTicketRelayConfig();
    if (!config) return;
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT client_ticket_id, payload, attempt_count FROM support_ticket_outbox
          WHERE status IN ('pending', 'failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(now(), BATCH_SIZE) as OutboxRow[];
    for (const row of rows) {
      if (this.stopping) return;
      db.prepare(
        `UPDATE support_ticket_outbox SET status = 'sending', updated_at = ? WHERE client_ticket_id = ?`,
      ).run(now(), row.client_ticket_id);
      try {
        const supportCode = await this.send(config, row);
        db.prepare(
          `UPDATE support_ticket_outbox
              SET status = 'delivered', support_code = ?, delivered_at = ?, updated_at = ?, last_error = NULL
            WHERE client_ticket_id = ?`,
        ).run(supportCode, now(), now(), row.client_ticket_id);
        console.log(
          `[Support] Ticket ${row.client_ticket_id} delivered (${supportCode ?? 'no code'})`,
        );
      } catch (err) {
        const attempts = row.attempt_count + 1;
        const delayMs = Math.min(MAX_BACKOFF_MS, Math.pow(2, Math.min(attempts, 8)) * 1000);
        const message = String((err as Error).message || err).slice(0, 500);
        db.prepare(
          `UPDATE support_ticket_outbox
              SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE client_ticket_id = ?`,
        ).run(
          attempts,
          sqliteTimestamp(Date.now() + delayMs),
          message,
          now(),
          row.client_ticket_id,
        );
        console.warn(`[Support] Ticket ${row.client_ticket_id} not delivered: ${message}`);
      }
    }
  }

  private async send(config: TicketRelayConfig, row: OutboxRow): Promise<string | null> {
    let ticket: unknown;
    try {
      ticket = JSON.parse(row.payload);
    } catch {
      throw new Error('stored ticket payload is not valid JSON');
    }
    // Apps Script web apps cannot read request headers, so the shared secret travels in the body.
    // text/plain keeps the request "simple"; the script parses the body itself.
    const res = await this.fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: config.secret, ticket }),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ticket endpoint answered ${res.status}`);
    let data: { ok?: unknown; support_code?: unknown; error?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        'ticket endpoint did not answer JSON (check the Apps Script deployment access)',
      );
    }
    if (data.ok !== true)
      throw new Error(`ticket endpoint refused: ${String(data.error || 'unknown')}`);
    return typeof data.support_code === 'string' ? data.support_code.slice(0, 64) : null;
  }
}

export const factorposTicketRelay = new FactorposTicketRelay();

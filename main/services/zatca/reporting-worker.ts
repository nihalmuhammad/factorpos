/**
 * FactorPOS: background worker that reports signed ZATCA documents (roadmap phase 6).
 * Runs every minute while the app is open; ./reporting.ts decides what is due.
 */
import { getDatabase } from '../../db';
import { createFatooraClient, FATOORA_BASE_URL, type FatooraClient } from './fatoora';
import { reportDueDocuments, type ReportRunResult } from './reporting';

const INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 15_000;

let clientFactory = (environment: string): FatooraClient =>
  createFatooraClient(
    environment === 'production' ? FATOORA_BASE_URL.production : FATOORA_BASE_URL.simulation,
  );

/** Tests replace the FATOORA client with a local stand-in. */
export function setReportingClientForTests(factory: (environment: string) => FatooraClient): void {
  clientFactory = factory;
}

class ZatcaReportingWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ReportRunResult> | null = null;
  private stopping = false;

  start(): void {
    this.stopping = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.runNow().catch(() => undefined), INTERVAL_MS);
    this.timer.unref?.();
    this.startupTimer = setTimeout(
      () => void this.runNow().catch(() => undefined),
      STARTUP_DELAY_MS,
    );
    this.startupTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    await this.running?.catch(() => undefined);
  }

  /**
   * Sends what is due now (or the given documents; `ignoreSchedule` sends every waiting
   * one). Overlapping calls wait for the run in progress and then run again, so a
   * hand-pressed "send" is never lost.
   */
  async runNow(
    documentIds?: string[],
    options: { ignoreSchedule?: boolean } = {},
  ): Promise<ReportRunResult> {
    while (this.running) await this.running.catch(() => undefined);
    if (this.stopping) {
      return { attempted: 0, reported: 0, warnings: 0, rejected: 0, retrying: 0 };
    }
    this.running = reportDueDocuments(getDatabase(), clientFactory, {
      documentIds,
      ignoreSchedule: options.ignoreSchedule,
      limit: options.ignoreSchedule ? 500 : undefined,
    })
      .catch((error) => {
        console.warn('[ZATCA] Reporting run failed:', error);
        throw error;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}

export const zatcaReporting = new ZatcaReportingWorker();

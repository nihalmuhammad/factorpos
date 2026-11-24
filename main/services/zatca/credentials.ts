/**
 * FactorPOS: the ZATCA signing credential (certificate + private key) of this till.
 *
 * The private key is stored encrypted with Electron's safeStorage (Windows DPAPI on the
 * shop PC). A plain key is accepted only in the simulation environment, for ZATCA's
 * published SDK test credential; production refuses it. Onboarding (roadmap phase 5,
 * ./onboarding.ts) creates real credentials.
 */
import type { getDatabase } from '../../db';
import type { ZatcaCredential } from './signing';

type Database = ReturnType<typeof getDatabase>;

export type KeyProtection = 'safe_storage' | 'plain_test';

interface CredentialRow {
  id: number;
  environment: string;
  certificate: string;
  private_key: string;
  key_protection: KeyProtection;
}

function safeStorage(): {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    return electron?.safeStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Encrypts a secret (private key, API secret) for storage. `plain_test` keeps it as is
 * and is only accepted for simulation.
 */
export function protectSecret(text: string, protection: KeyProtection): string {
  if (protection === 'plain_test') return text;
  const storage = safeStorage();
  if (!storage?.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable, so the ZATCA secret cannot be saved');
  }
  return storage.encryptString(text).toString('base64');
}

export function revealSecret(stored: string, protection: KeyProtection): string {
  if (protection === 'plain_test') return stored;
  const storage = safeStorage();
  if (!storage?.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable, so the ZATCA secret cannot be read');
  }
  return storage.decryptString(Buffer.from(stored, 'base64'));
}

/**
 * How this till protects new ZATCA secrets: Electron safeStorage (DPAPI on Windows).
 * Plain storage only for simulation, and only when FACTORPOS_ZATCA_PLAIN_TEST_KEYS=1
 * (automated tests, where the OS keychain cannot be used).
 */
export function keyProtectionFor(environment: 'simulation' | 'production'): KeyProtection {
  if (environment === 'simulation' && process.env.FACTORPOS_ZATCA_PLAIN_TEST_KEYS === '1') {
    return 'plain_test';
  }
  if (!safeStorage()?.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this computer, so ZATCA keys cannot be kept');
  }
  return 'safe_storage';
}

/** The active credential for an environment, or null when the till is not onboarded. */
export function loadSigningCredential(db: Database, environment: string): ZatcaCredential | null {
  const row = db
    .prepare(
      `SELECT id, environment, certificate, private_key, key_protection FROM zatca_credentials
       WHERE environment = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(environment) as CredentialRow | undefined;
  if (!row) return null;
  if (row.key_protection === 'plain_test') {
    if (environment !== 'simulation') {
      throw new Error('A plain test key cannot sign outside the ZATCA simulation environment');
    }
    return { certificate: row.certificate, privateKey: row.private_key };
  }
  return {
    certificate: row.certificate,
    privateKey: revealSecret(row.private_key, row.key_protection),
  };
}

/**
 * Saves a credential as the active one for its environment (earlier ones are kept,
 * inactive). Production keys must use safe storage.
 */
export interface CredentialDetails {
  /** FATOORA API secret that goes with the certificate (production CSID). */
  apiSecret?: string;
  requestId?: string;
  egsUuid?: string;
  /** Certificate expiry, ISO UTC. */
  expiresAt?: string;
}

export function saveSigningCredential(
  db: Database,
  credential: ZatcaCredential & { environment: 'simulation' | 'production' },
  protection: KeyProtection,
  createdAt: string,
  details: CredentialDetails = {},
): number {
  if (protection === 'plain_test' && credential.environment !== 'simulation') {
    throw new Error('Production ZATCA keys must be stored with secure storage');
  }
  const privateKey = protectSecret(credential.privateKey, protection);
  const apiSecret = details.apiSecret ? protectSecret(details.apiSecret, protection) : null;
  db.prepare('UPDATE zatca_credentials SET active = 0 WHERE environment = ?').run(
    credential.environment,
  );
  const result = hasCredentialDetailColumns(db)
    ? db
        .prepare(
          `INSERT INTO zatca_credentials (environment, certificate, private_key, key_protection, active, created_at,
             api_secret, request_id, egs_uuid, expires_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          credential.environment,
          credential.certificate,
          privateKey,
          protection,
          createdAt,
          apiSecret,
          details.requestId ?? null,
          details.egsUuid ?? null,
          details.expiresAt ?? null,
        )
    : db
        .prepare(
          `INSERT INTO zatca_credentials (environment, certificate, private_key, key_protection, active, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(credential.environment, credential.certificate, privateKey, protection, createdAt);
  return Number(result.lastInsertRowid);
}

function hasCredentialDetailColumns(db: Database): boolean {
  const columns = db.prepare('PRAGMA table_info(zatca_credentials)').all() as { name: string }[];
  return columns.some((column) => column.name === 'api_secret');
}

/**
 * The certificate and API secret that authenticate reporting for an environment, or
 * null when the till has no onboarded credential (no API secret).
 */
export function loadReportingAuth(
  db: Database,
  environment: string,
): { certificate: string; secret: string } | null {
  if (!hasCredentialDetailColumns(db)) return null;
  const row = db
    .prepare(
      `SELECT certificate, api_secret, key_protection FROM zatca_credentials
       WHERE environment = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(environment) as
    | { certificate: string; api_secret: string | null; key_protection: KeyProtection }
    | undefined;
  if (!row?.api_secret) return null;
  return {
    certificate: row.certificate
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
      .replace(/\s+/g, ''),
    secret: revealSecret(row.api_secret, row.key_protection),
  };
}

export interface CredentialSummary {
  environment: string;
  egsUuid: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Issued by onboarding (has an API secret) rather than loaded for tests. */
  onboarded: boolean;
}

/** What the settings screen shows about the active credential; no secrets. */
export function credentialSummary(db: Database, environment: string): CredentialSummary | null {
  if (!hasCredentialDetailColumns(db)) return null;
  const row = db
    .prepare(
      `SELECT environment, egs_uuid, expires_at, created_at, api_secret FROM zatca_credentials
       WHERE environment = ? AND active = 1 ORDER BY id DESC LIMIT 1`,
    )
    .get(environment) as
    | {
        environment: string;
        egs_uuid: string | null;
        expires_at: string | null;
        created_at: string;
        api_secret: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    environment: row.environment,
    egsUuid: row.egs_uuid,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    onboarded: Boolean(row.api_secret),
  };
}

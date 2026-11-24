/**
 * FactorPOS: the ZATCA signing credential (certificate + private key) of this till.
 *
 * The private key is stored encrypted with Electron's safeStorage (Windows DPAPI on the
 * shop PC). A plain key is accepted only in the simulation environment, for ZATCA's
 * published SDK test credential; production refuses it. Onboarding (roadmap phase 5)
 * creates real credentials.
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
  const storage = safeStorage();
  if (!storage?.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable, so the ZATCA signing key cannot be read');
  }
  return {
    certificate: row.certificate,
    privateKey: storage.decryptString(Buffer.from(row.private_key, 'base64')),
  };
}

/**
 * Saves a credential as the active one for its environment (earlier ones are kept,
 * inactive). Production keys must use safe storage.
 */
export function saveSigningCredential(
  db: Database,
  credential: ZatcaCredential & { environment: 'simulation' | 'production' },
  protection: KeyProtection,
  createdAt: string,
): number {
  if (protection === 'plain_test' && credential.environment !== 'simulation') {
    throw new Error('Production ZATCA keys must be stored with secure storage');
  }
  let privateKey = credential.privateKey;
  if (protection === 'safe_storage') {
    const storage = safeStorage();
    if (!storage?.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable, so the ZATCA signing key cannot be saved');
    }
    privateKey = storage.encryptString(credential.privateKey).toString('base64');
  }
  db.prepare('UPDATE zatca_credentials SET active = 0 WHERE environment = ?').run(
    credential.environment,
  );
  const result = db
    .prepare(
      `INSERT INTO zatca_credentials (environment, certificate, private_key, key_protection, active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(credential.environment, credential.certificate, privateKey, protection, createdAt);
  return Number(result.lastInsertRowid);
}

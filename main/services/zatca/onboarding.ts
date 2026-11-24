/**
 * FactorPOS: ZATCA onboarding of this till (EGS), roadmap phase 5.
 *
 *   1. Generate a key and CSR; send the CSR with the owner's FATOORA OTP → compliance CSID.
 *   2. Sign a sample simplified invoice, credit note and debit note with the compliance
 *      certificate and have ZATCA check each one.
 *   3. Exchange the compliance CSID for the production CSID → the till's signing credential.
 *
 * Progress is saved after every step, so a failed step is retried without a new OTP
 * (except step 1, which needs one). Keys and API secrets are encrypted (safeStorage).
 */
import crypto, { randomUUID } from 'crypto';
import type { getDatabase } from '../../db';
import { now } from '../../db';
import { sellerSnapshot, setting, signingTime } from '../zatca-fiscal';
import { buildCsr, generatePrivateKey, type CsrFields, type ZatcaPortal } from './csr';
import {
  keyProtectionFor,
  protectSecret,
  revealSecret,
  saveSigningCredential,
  type KeyProtection,
} from './credentials';
import { localIssueDateTime, zatcaSeller } from './document';
import type { ComplianceCheckResult, FatooraAuth, FatooraClient } from './fatoora';
import { FIRST_PREVIOUS_INVOICE_HASH, signZatcaDocument } from './signing';
import type { ZatcaDocumentInput } from './xml';

type Database = ReturnType<typeof getDatabase>;
export type OnboardingEnvironment = 'simulation' | 'production';
export type OnboardingStatus = 'started' | 'compliance_issued' | 'checks_passed' | 'active';

export class OnboardingError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode = 409) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface OnboardingRow {
  id: number;
  environment: OnboardingEnvironment;
  portal: ZatcaPortal;
  egs_uuid: string;
  status: OnboardingStatus;
  csr: string;
  private_key: string;
  key_protection: KeyProtection;
  compliance_request_id: string | null;
  compliance_certificate: string | null;
  compliance_secret: string | null;
  checks_json: string | null;
  last_error: string | null;
  credential_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CheckOutcome extends ComplianceCheckResult {
  document: 'invoice' | 'credit_note' | 'debit_note';
  passed: boolean;
}

export interface OnboardingState {
  environment: OnboardingEnvironment;
  status: OnboardingStatus | 'not_started';
  egsUuid: string | null;
  checks: CheckOutcome[];
  lastError: string | null;
  updatedAt: string | null;
}

/** The till's stable EGS id, created on first use. */
export function egsUuid(db: Database): string {
  const existing = setting(db, 'zatca_egs_uuid');
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('zatca_egs_uuid', ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run(id, now());
  return setting(db, 'zatca_egs_uuid');
}

/** CSR fields from the shop's settings; refuses when seller details are incomplete. */
export function onboardingFields(db: Database, solutionVersion: string): CsrFields {
  const seller = zatcaSeller(sellerSnapshot(db));
  const egs = egsUuid(db);
  return {
    commonName: `FactorPOS-${seller.vatNumber}-${egs.slice(0, 8)}`,
    serialNumber: `1-FactorPOS|2-${solutionVersion || 'POS'}|3-${egs}`,
    vatNumber: seller.vatNumber,
    organizationUnit: setting(db, 'zatca_seller_branch_name') || seller.name,
    organizationName: seller.name,
    invoiceType: '0100',
    locationAddress: `${seller.buildingNumber} ${seller.street}, ${seller.city}`,
    industry: setting(db, 'zatca_seller_industry') || 'Restaurant',
  };
}

function latestRow(db: Database, environment: OnboardingEnvironment): OnboardingRow | undefined {
  return db
    .prepare('SELECT * FROM zatca_onboarding WHERE environment = ? ORDER BY id DESC LIMIT 1')
    .get(environment) as OnboardingRow | undefined;
}

export function onboardingState(db: Database, environment: OnboardingEnvironment): OnboardingState {
  const row = latestRow(db, environment);
  return {
    environment,
    status: row?.status ?? 'not_started',
    egsUuid: row?.egs_uuid ?? (setting(db, 'zatca_egs_uuid') || null),
    checks: row?.checks_json ? (JSON.parse(row.checks_json) as CheckOutcome[]) : [],
    lastError: row?.last_error ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

function update(db: Database, id: number, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE zatca_onboarding SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).run(...keys.map((k) => fields[k] ?? null), now(), id);
}

/** Sample documents for the compliance checks, chained like real ones. */
export function complianceSamples(
  db: Database,
  egs: string,
): Array<{ kind: CheckOutcome['document']; input: ZatcaDocumentInput }> {
  const snapshot = sellerSnapshot(db);
  const seller = zatcaSeller(snapshot);
  const issued = localIssueDateTime(new Date().toISOString(), snapshot.timezone);
  const invoiceNumber = `CHK-${egs.slice(0, 8)}-1`;
  const base = {
    issueDate: issued.date,
    issueTime: issued.time,
    seller,
    lines: [
      {
        name: 'Compliance check item',
        quantity: 1,
        netMinor: 10000,
        vatMinor: 1500,
        ratePercent: 15,
      },
    ],
    paymentMeansCode: '10',
  };
  return [
    {
      kind: 'invoice',
      input: {
        ...base,
        type: 'invoice',
        number: invoiceNumber,
        uuid: randomUUID(),
        counter: 1,
        previousInvoiceHash: '',
      },
    },
    {
      kind: 'credit_note',
      input: {
        ...base,
        type: 'credit_note',
        number: `CHK-${egs.slice(0, 8)}-2`,
        uuid: randomUUID(),
        counter: 2,
        previousInvoiceHash: '',
        originalInvoiceNumber: invoiceNumber,
        reason: 'Compliance check: returned item',
      },
    },
    {
      kind: 'debit_note',
      input: {
        ...base,
        type: 'debit_note',
        number: `CHK-${egs.slice(0, 8)}-3`,
        uuid: randomUUID(),
        counter: 3,
        previousInvoiceHash: '',
        originalInvoiceNumber: invoiceNumber,
        reason: 'Compliance check: price adjustment',
      },
    },
  ];
}

function certificateExpiry(certificate: string): string | null {
  try {
    const cert = new crypto.X509Certificate(Buffer.from(certificate.replace(/\s+/g, ''), 'base64'));
    return new Date(cert.validTo).toISOString();
  } catch {
    return null;
  }
}

const running = new Set<OnboardingEnvironment>();

export interface OnboardingOptions {
  environment: OnboardingEnvironment;
  /** Six-digit OTP from the FATOORA portal; needed only to get the compliance CSID. */
  otp?: string;
  client: FatooraClient;
  solutionVersion: string;
}

/**
 * Runs or resumes onboarding. Returns the state after the last step that completed;
 * a step's failure is saved as `lastError` and the error is rethrown.
 */
export async function runOnboarding(
  db: Database,
  options: OnboardingOptions,
): Promise<OnboardingState> {
  const { environment, client } = options;
  if (running.has(environment)) {
    throw new OnboardingError(
      'ZATCA onboarding is already running on this till',
      'zatca_onboarding_busy',
    );
  }
  running.add(environment);
  try {
    let row = latestRow(db, environment);
    if (!row || row.status === 'active') {
      // A new onboarding (first time, or renewing an active certificate).
      if (!options.otp) {
        throw new OnboardingError(
          'Enter the OTP from the FATOORA portal',
          'zatca_otp_required',
          400,
        );
      }
      const fields = onboardingFields(db, options.solutionVersion);
      let protection: KeyProtection;
      try {
        protection = keyProtectionFor(environment);
      } catch (error: any) {
        throw new OnboardingError(
          String(error?.message || error),
          'zatca_secure_storage_unavailable',
        );
      }
      const privateKey = generatePrivateKey();
      const portal: ZatcaPortal = environment === 'production' ? 'production' : 'simulation';
      const csr = buildCsr(fields, portal, privateKey);
      const stamp = now();
      const result = db
        .prepare(
          `INSERT INTO zatca_onboarding (environment, portal, egs_uuid, status, csr, private_key, key_protection, created_at, updated_at)
           VALUES (?, ?, ?, 'started', ?, ?, ?, ?, ?)`,
        )
        .run(
          environment,
          portal,
          egsUuid(db),
          csr.base64,
          protectSecret(privateKey, protection),
          protection,
          stamp,
          stamp,
        );
      row = latestRow(db, environment)!;
      if (row.id !== Number(result.lastInsertRowid)) throw new Error('Onboarding row mismatch');
    }

    const step = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (error: any) {
        update(db, row!.id, { last_error: String(error?.message || error) });
        throw error;
      }
    };

    if (row.status === 'started') {
      if (!options.otp) {
        throw new OnboardingError(
          'Enter the OTP from the FATOORA portal',
          'zatca_otp_required',
          400,
        );
      }
      if (!/^\d{6}$/.test(options.otp)) {
        throw new OnboardingError('The OTP is 6 digits', 'zatca_otp_invalid', 400);
      }
      await step(async () => {
        const csid = await client.complianceCsid(row!.csr, options.otp!);
        update(db, row!.id, {
          status: 'compliance_issued',
          compliance_request_id: csid.requestId,
          compliance_certificate: csid.certificate,
          compliance_secret: protectSecret(csid.secret, row!.key_protection),
          last_error: null,
        });
      });
      row = latestRow(db, environment)!;
    }

    const privateKey = () => revealSecret(row!.private_key, row!.key_protection);
    const complianceAuth = (): FatooraAuth => ({
      certificate: row!.compliance_certificate!,
      secret: revealSecret(row!.compliance_secret!, row!.key_protection),
    });

    if (row.status === 'compliance_issued') {
      await step(async () => {
        const credential = {
          certificate: row!.compliance_certificate!,
          privateKey: privateKey(),
        };
        const outcomes: CheckOutcome[] = [];
        let previousHash = FIRST_PREVIOUS_INVOICE_HASH;
        const time = signingTime(String(sellerSnapshot(db).timezone ?? ''));
        for (const sample of complianceSamples(db, row!.egs_uuid)) {
          const signed = signZatcaDocument(
            { ...sample.input, previousInvoiceHash: previousHash },
            credential,
            time,
          );
          previousHash = signed.invoiceHash;
          const result = await client.checkCompliance(complianceAuth(), {
            invoiceHash: signed.invoiceHash,
            uuid: sample.input.uuid,
            xml: signed.xml,
          });
          const passed =
            (result.status === 'PASS' || result.status === 'WARNING') &&
            result.reportingStatus === 'REPORTED';
          outcomes.push({ ...result, document: sample.kind, passed });
        }
        const failed = outcomes.filter((o) => !o.passed);
        update(db, row!.id, {
          checks_json: JSON.stringify(outcomes),
          ...(failed.length === 0 ? { status: 'checks_passed', last_error: null } : {}),
        });
        if (failed.length > 0) {
          const detail = failed
            .map((o) => `${o.document}: ${o.errors.join('; ') || o.status}`)
            .join(' | ');
          throw new OnboardingError(
            `ZATCA's compliance checks failed — ${detail}`,
            'zatca_compliance_failed',
            422,
          );
        }
      });
      row = latestRow(db, environment)!;
    }

    if (row.status === 'checks_passed') {
      await step(async () => {
        const csid = await client.productionCsid(complianceAuth(), row!.compliance_request_id!);
        const credentialId = db.transaction(() => {
          const id = saveSigningCredential(
            db,
            {
              environment,
              certificate: csid.certificate,
              privateKey: privateKey(),
            },
            row!.key_protection,
            now(),
            {
              apiSecret: csid.secret,
              requestId: csid.requestId,
              egsUuid: row!.egs_uuid,
              expiresAt: certificateExpiry(csid.certificate) ?? undefined,
            },
          );
          update(db, row!.id, {
            status: 'active',
            credential_id: id,
            last_error: null,
          });
          return id;
        })();
        if (!credentialId) throw new Error('The ZATCA credential was not saved');
      });
    }
    return onboardingState(db, environment);
  } finally {
    running.delete(environment);
  }
}

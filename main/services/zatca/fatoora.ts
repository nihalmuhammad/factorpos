/**
 * FactorPOS: the FATOORA (ZATCA e-invoicing) API calls onboarding needs: compliance
 * CSID from an OTP, compliance invoice checks, production CSID. API version V2.
 * Reporting (roadmap phase 6) will add the reporting call here.
 */
import type { ZatcaPortal } from './csr';

export const FATOORA_BASE_URL: Record<ZatcaPortal, string> = {
  'developer-portal': 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

const TIMEOUT_MS = 30_000;

export class FatooraError extends Error {
  readonly status: number;
  readonly code = 'zatca_api_error';
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FatooraError';
    this.status = status;
  }
}

export interface IssuedCsid {
  requestId: string;
  /** Base64 DER certificate (the API's binarySecurityToken, decoded once). */
  certificate: string;
  secret: string;
}

export interface FatooraAuth {
  certificate: string;
  secret: string;
}

export interface ComplianceCheckResult {
  status: string;
  reportingStatus: string | null;
  errors: string[];
  warnings: string[];
}

export interface FatooraClient {
  complianceCsid(csrBase64: string, otp: string): Promise<IssuedCsid>;
  checkCompliance(
    auth: FatooraAuth,
    doc: { invoiceHash: string; uuid: string; xml: string },
  ): Promise<ComplianceCheckResult>;
  productionCsid(auth: FatooraAuth, complianceRequestId: string): Promise<IssuedCsid>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function basicAuth(auth: FatooraAuth): string {
  // The username is the binarySecurityToken: Base64 of the certificate's Base64 text.
  const token = Buffer.from(auth.certificate, 'utf8').toString('base64');
  return `Basic ${Buffer.from(`${token}:${auth.secret}`, 'utf8').toString('base64')}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The parts of a FATOORA JSON response FactorPOS reads. */
interface FatooraBody {
  errors?: unknown;
  message?: string;
  dispositionMessage?: string;
  binarySecurityToken?: string;
  secret?: string;
  requestID?: string | number;
  requestId?: string | number;
  reportingStatus?: string | null;
  validationResults?: {
    status?: string;
    errorMessages?: unknown;
    warningMessages?: unknown;
  };
}

function messages(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((item: unknown) => {
    const entry = (item ?? {}) as { code?: unknown; message?: unknown };
    return [entry.code, entry.message].filter(Boolean).join(': ') || String(item);
  });
}

/** The most useful error text FATOORA returned. */
function errorText(body: FatooraBody | null, status: number): string {
  const parts = [
    ...messages(body?.errors),
    ...messages(body?.validationResults?.errorMessages),
    body?.message,
    body?.dispositionMessage && body.dispositionMessage !== 'ISSUED' ? body.dispositionMessage : '',
  ].filter(Boolean);
  if (parts.length > 0) return parts.join('; ');
  if (status === 401) return 'ZATCA refused the request (check the OTP or certificate)';
  return `ZATCA returned HTTP ${status}`;
}

function issued(body: FatooraBody | null): IssuedCsid {
  const token = String(body?.binarySecurityToken ?? '');
  const secret = String(body?.secret ?? '');
  const requestId = String(body?.requestID ?? body?.requestId ?? '');
  if (!token || !secret || !requestId) {
    throw new FatooraError('ZATCA did not return a certificate', 502);
  }
  return {
    requestId,
    certificate: Buffer.from(token, 'base64').toString('utf8'),
    secret,
  };
}

export function createFatooraClient(baseUrl: string, fetchImpl: FetchLike = fetch): FatooraClient {
  async function call(
    path: string,
    init: { method: string; headers: Record<string, string>; body: unknown },
  ) {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
          'Accept-Version': 'V2',
          'Content-Type': 'application/json',
          ...init.headers,
        },
        body: JSON.stringify(init.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new FatooraError(`Could not reach ZATCA: ${errorMessage(error)}`, 503);
    }
    const text = await response.text();
    let body: FatooraBody | null = null;
    try {
      body = text ? (JSON.parse(text) as FatooraBody) : null;
    } catch {
      body = { message: text.slice(0, 300) };
    }
    return { status: response.status, ok: response.ok, body };
  }

  return {
    async complianceCsid(csrBase64, otp) {
      const res = await call('/compliance', {
        method: 'POST',
        headers: { OTP: otp },
        body: { csr: csrBase64 },
      });
      if (!res.ok) throw new FatooraError(errorText(res.body, res.status), res.status);
      return issued(res.body);
    },

    async checkCompliance(auth, doc) {
      const res = await call('/compliance/invoices', {
        method: 'POST',
        headers: { Authorization: basicAuth(auth) },
        body: {
          invoiceHash: doc.invoiceHash,
          uuid: doc.uuid,
          invoice: Buffer.from(doc.xml, 'utf8').toString('base64'),
        },
      });
      const results = res.body?.validationResults;
      if (!results) throw new FatooraError(errorText(res.body, res.status), res.status);
      return {
        status: String(results.status ?? ''),
        reportingStatus: res.body?.reportingStatus ?? null,
        errors: messages(results.errorMessages),
        warnings: messages(results.warningMessages),
      };
    },

    async productionCsid(auth, complianceRequestId) {
      const res = await call('/production/csids', {
        method: 'POST',
        headers: { Authorization: basicAuth(auth) },
        body: { compliance_request_id: complianceRequestId },
      });
      if (!res.ok) throw new FatooraError(errorText(res.body, res.status), res.status);
      return issued(res.body);
    },
  };
}

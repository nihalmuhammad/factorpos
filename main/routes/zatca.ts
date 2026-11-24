/**
 * FactorPOS: ZATCA settings, onboarding and the issuance switch (roadmap phase 5).
 *
 *   GET  /api/zatca              seller details, issuance environment, onboarding state, certificate
 *   PUT  /api/zatca/seller       save the structured seller details
 *   POST /api/zatca/onboarding   run or resume onboarding (body: { otp })
 *   PUT  /api/zatca/environment  switch issuance: disabled | simulation
 *
 * Only the simulation environment can be onboarded and switched on for now; production
 * waits for reporting (phase 6) and the pilot.
 */
import { Router, Request, Response } from 'express';
import { app } from 'electron';
import { getDatabase, now } from '../db';
import { requirePermission } from '../services/authorization';
import { sellerSnapshot, setting } from '../services/zatca-fiscal';
import { credentialSummary, loadSigningCredential } from '../services/zatca/credentials';
import { zatcaSeller, ZatcaDocumentError } from '../services/zatca/document';
import {
  createFatooraClient,
  FATOORA_BASE_URL,
  FatooraError,
  type FatooraClient,
} from '../services/zatca/fatoora';
import { onboardingState, OnboardingError, runOnboarding } from '../services/zatca/onboarding';
import { CsrFieldError } from '../services/zatca/csr';

const router = Router();

/** Seller settings the screen edits, with the request field each comes from. */
const SELLER_FIELDS = {
  crn: 'zatca_seller_crn',
  street: 'zatca_seller_street',
  building_number: 'zatca_seller_building_number',
  district: 'zatca_seller_district',
  city: 'zatca_seller_city',
  postal_code: 'zatca_seller_postal_code',
  branch_name: 'zatca_seller_branch_name',
  industry: 'zatca_seller_industry',
} as const;

const FIELD_RULES: Partial<Record<keyof typeof SELLER_FIELDS, [RegExp, string]>> = {
  crn: [/^\d{10}$/, 'The commercial registration number is 10 digits'],
  building_number: [/^\d{4}$/, 'The building number is 4 digits'],
  postal_code: [/^\d{5}$/, 'The postal code is 5 digits'],
};

function sellerCheck(db: ReturnType<typeof getDatabase>): {
  complete: boolean;
  problem: string | null;
} {
  try {
    zatcaSeller(sellerSnapshot(db));
    return { complete: true, problem: null };
  } catch (error: any) {
    return { complete: false, problem: String(error?.message || error) };
  }
}

function overview(db: ReturnType<typeof getDatabase>) {
  const snapshot = sellerSnapshot(db);
  const environment = setting(db, 'zatca_environment') || 'disabled';
  return {
    environment,
    seller: {
      name: snapshot.name,
      vat_number: snapshot.vat_number,
      ...Object.fromEntries(
        Object.entries(SELLER_FIELDS).map(([field, key]) => [field, setting(db, key)]),
      ),
    },
    seller_check: sellerCheck(db),
    onboarding: onboardingState(db, 'simulation'),
    certificate: credentialSummary(db, 'simulation'),
  };
}

function sendError(res: Response, error: any) {
  if (error instanceof OnboardingError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error instanceof FatooraError) {
    // ZATCA's own refusal (400/401) is the user's to fix; anything else is a gateway problem.
    const status = error.status === 400 || error.status === 401 ? 422 : 502;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  if (error instanceof ZatcaDocumentError || error instanceof CsrFieldError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  res.locals.postHogError = error;
  console.error('[API] ZATCA error:', error);
  return res.status(500).json({ error: String(error?.message || 'Internal server error') });
}

router.get('/', requirePermission('settings.view'), (_req: Request, res: Response) => {
  try {
    res.json(overview(getDatabase()));
  } catch (error) {
    sendError(res, error);
  }
});

router.put(
  '/seller',
  requirePermission('tax-configuration.manage'),
  (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updates: Array<[string, string]> = [];
      for (const [field, key] of Object.entries(SELLER_FIELDS)) {
        if (body[field] === undefined) continue;
        const value = String(body[field] ?? '').trim();
        const rule = FIELD_RULES[field as keyof typeof SELLER_FIELDS];
        if (value && rule && !rule[0].test(value)) {
          return res.status(400).json({ error: rule[1], code: 'zatca_seller_invalid', field });
        }
        if (value.length > 200) {
          return res.status(400).json({ error: 'Too long', code: 'zatca_seller_invalid', field });
        }
        updates.push([key, value]);
      }
      const db = getDatabase();
      const stmt = db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      db.transaction(() => {
        for (const [key, value] of updates) stmt.run(key, value, now());
      })();
      res.json(overview(db));
    } catch (error) {
      sendError(res, error);
    }
  },
);

let fatooraClient = (): FatooraClient => createFatooraClient(FATOORA_BASE_URL.simulation);

/** Tests replace the FATOORA client with a local stand-in. */
export function setFatooraClientForTests(factory: () => FatooraClient): void {
  fatooraClient = factory;
}

router.post(
  '/onboarding',
  requirePermission('tax-configuration.manage'),
  async (req: Request, res: Response) => {
    const db = getDatabase();
    try {
      const otp = req.body?.otp === undefined ? undefined : String(req.body.otp).trim();
      await runOnboarding(db, {
        environment: 'simulation',
        otp: otp || undefined,
        client: fatooraClient(),
        solutionVersion: app.getVersion(),
      });
      res.json(overview(db));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.put(
  '/environment',
  requirePermission('tax-configuration.manage'),
  (req: Request, res: Response) => {
    try {
      const target = String(req.body?.environment ?? '');
      const db = getDatabase();
      if (target === 'production') {
        return res.status(409).json({
          error: 'ZATCA production issuance is not available yet',
          code: 'zatca_production_not_enabled',
        });
      }
      if (target !== 'disabled' && target !== 'simulation') {
        return res.status(400).json({
          error: 'Unknown ZATCA environment',
          code: 'zatca_environment_invalid',
        });
      }
      if (target === 'simulation') {
        const check = sellerCheck(db);
        if (!check.complete) {
          return res.status(409).json({ error: check.problem, code: 'zatca_seller_incomplete' });
        }
        if (!loadSigningCredential(db, 'simulation')) {
          return res.status(409).json({
            error: 'Onboard this till with ZATCA before switching invoices on',
            code: 'zatca_not_onboarded',
          });
        }
      }
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('zatca_environment', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(target, now());
      res.json(overview(db));
    } catch (error) {
      sendError(res, error);
    }
  },
);

export { router as zatcaRoutes };

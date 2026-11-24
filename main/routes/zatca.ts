/**
 * FactorPOS: ZATCA settings, onboarding and the issuance switch (roadmap phase 5).
 *
 *   GET  /api/zatca              seller details, issuance environment, onboarding state, certificate
 *   PUT  /api/zatca/seller       save the structured seller details
 *   POST /api/zatca/onboarding   run or resume onboarding (body: { otp })
 *   PUT  /api/zatca/environment  switch issuance: disabled | simulation
 *   GET  /api/zatca/reporting           reporting summary (alerts)
 *   GET  /api/zatca/reporting/day       one day's documents and their reporting status
 *   POST /api/zatca/reporting/send      send waiting documents now (or the ones given)
 *   POST /api/zatca/reporting/review    mark a day reviewed
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
import {
  getActiveCountryPack,
  isTaxModuleActiveForCountry,
  previewCategoryRate,
} from '../services/tax';
import { documentsForDay, markDayReviewed, reportingSummary } from '../services/zatca/reporting';
import { zatcaReporting } from '../services/zatca/reporting-worker';
import { currentEdition } from '../edition';
import { editionFeatures } from '../../shared/edition';

const router = Router();

// The KOT edition has no ZATCA features: every ZATCA route is absent there.
router.use((_req, res, next) => {
  if (editionFeatures(currentEdition()).zatca) return next();
  res.status(404).json({ error: 'Not available in this edition', code: 'zatca_not_in_edition' });
});

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

/**
 * ZATCA invoices need Saudi VAT at 15% on every sale: the official Saudi Arabia tax pack
 * must be on. Without it bills carry no VAT breakdown and cannot be issued.
 */
function vatCheck(db: ReturnType<typeof getDatabase>): { ok: boolean; problem: string | null } {
  const problem =
    'Switch on Saudi VAT first: Settings → Tax → Official Tax Pack. ZATCA invoices need 15% VAT on every sale.';
  try {
    const country = setting(db, 'country') || 'SA';
    if (country !== 'SA' || !isTaxModuleActiveForCountry(country)) return { ok: false, problem };
    const rate = previewCategoryRate(
      getActiveCountryPack(country),
      setting(db, 'business_type') || 'restaurant',
      'standard',
    );
    return rate?.percent === 15 ? { ok: true, problem: null } : { ok: false, problem };
  } catch {
    return { ok: false, problem };
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
    vat_check: vatCheck(db),
    onboarding: onboardingState(db, 'simulation'),
    certificate: credentialSummary(db, 'simulation'),
    reporting: reportingSummary(db),
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
        const vat = vatCheck(db);
        if (!vat.ok) {
          return res.status(409).json({ error: vat.problem, code: 'zatca_vat_not_configured' });
        }
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

// ─── Reporting review (roadmap phase 6) ───

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayView(db: ReturnType<typeof getDatabase>, date: string) {
  const documents = documentsForDay(db, date, sellerSnapshot(db).timezone);
  const reviewed = documents.length > 0 && documents.every((doc) => doc.reviewedAt);
  return {
    date,
    documents,
    reviewed: reviewed ? { at: documents[0].reviewedAt, by: documents[0].reviewedBy } : null,
    summary: reportingSummary(db),
  };
}

function reviewerName(db: ReturnType<typeof getDatabase>, req: Request): string {
  const userId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  const row = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as
    | { name: string }
    | undefined;
  return row?.name || userId || 'unknown';
}

router.get('/reporting', requirePermission('reports.view'), (_req: Request, res: Response) => {
  try {
    res.json(reportingSummary(getDatabase()));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/reporting/day', requirePermission('reports.view'), (req: Request, res: Response) => {
  try {
    const date = String(req.query.date ?? '');
    if (!DATE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    res.json(dayView(getDatabase(), date));
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  '/reporting/send',
  requirePermission('reports.view'),
  async (req: Request, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.document_ids)
        ? req.body.document_ids.map((id: unknown) => String(id)).slice(0, 500)
        : undefined;
      // Sent by hand: the given documents, or every waiting one regardless of backoff.
      const result =
        ids && ids.length > 0
          ? await zatcaReporting.runNow(ids)
          : await zatcaReporting.runNow(undefined, { ignoreSchedule: true });
      const date = String(req.body?.date ?? '');
      const db = getDatabase();
      res.json({
        result,
        ...(DATE.test(date) ? dayView(db, date) : { summary: reportingSummary(db) }),
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  '/reporting/review',
  requirePermission('reports.view'),
  (req: Request, res: Response) => {
    try {
      const date = String(req.body?.date ?? '');
      if (!DATE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      const db = getDatabase();
      const count = markDayReviewed(db, date, sellerSnapshot(db).timezone, reviewerName(db, req));
      if (count === 0) {
        return res
          .status(409)
          .json({ error: 'No ZATCA documents were issued that day', code: 'zatca_day_empty' });
      }
      res.json(dayView(db, date));
    } catch (error) {
      sendError(res, error);
    }
  },
);

export { router as zatcaRoutes };

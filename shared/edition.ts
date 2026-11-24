/**
 * FactorPOS editions. One codebase, two products:
 *
 * - `kot`: the token shop. Customer bill is the compact ORDER NOTE (or FloCafe's
 *   classic bill, or an installed/merchant template); the day token is shown on the
 *   order screens; no ZATCA.
 * - `zatca`: the Saudi Phase 2 shop. Customer bill is the ZATCA simplified tax invoice
 *   only (signed, QR tags 1–9, reported); no token on screens; ZATCA settings, review
 *   page and alerts.
 *
 * Both print kitchen KOT tickets as FloCafe does. The edition is fixed when the
 * installer is built (`factorposEdition` in the packaged package.json, see
 * main/edition.ts). Each edition is its own app (app ID, data folder, update feed), so a
 * till never changes edition on update. Pure TypeScript, shared by the main process and
 * the frontend.
 */

export const FACTORPOS_EDITIONS = ['kot', 'zatca'] as const;
export type FactorposEdition = (typeof FACTORPOS_EDITIONS)[number];

export function isFactorposEdition(value: unknown): value is FactorposEdition {
  return (FACTORPOS_EDITIONS as readonly unknown[]).includes(value);
}

/** Unknown or missing values are the KOT edition: what every shop ran before editions. */
export function normalizeEdition(value: unknown): FactorposEdition {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return isFactorposEdition(text) ? text : 'kot';
}

export interface BillTemplateRef {
  source: 'core' | 'pack' | 'merchant' | null | undefined;
  id: string;
}

/** Whether the customer bill may use this template in this edition. */
export function billTemplateAllowed(edition: FactorposEdition, template: BillTemplateRef): boolean {
  const core = !template.source || template.source === 'core';
  if (edition === 'zatca') return core && template.id === 'saudi';
  return !(core && template.id === 'saudi');
}

/** The bill template a till of this edition uses when none (or a disallowed one) is set. */
export function defaultBillTemplate(edition: FactorposEdition): 'saudi' | 'compact' {
  return edition === 'zatca' ? 'saudi' : 'compact';
}

export interface EditionFeatures {
  /** "TOKEN #n" on the dashboard and order screens. */
  showsOrderToken: boolean;
  /** ZATCA signing, reporting, settings card, review page and alerts. */
  zatca: boolean;
}

export function editionFeatures(edition: FactorposEdition): EditionFeatures {
  return edition === 'zatca'
    ? { showsOrderToken: false, zatca: true }
    : { showsOrderToken: true, zatca: false };
}

/** Short product name for titles: "FactorPOS" or "FactorPOS ZATCA". */
export function editionProductName(edition: FactorposEdition): string {
  return edition === 'zatca' ? 'FactorPOS ZATCA' : 'FactorPOS';
}

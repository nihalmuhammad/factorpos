'use client';

// FactorPOS: the edition of this till (KOT or ZATCA) and what it allows, from the
// signed-in tenant. See shared/edition.ts.

import { useAuthStore } from '@/store/auth';
import {
  editionFeatures,
  normalizeEdition,
  type EditionFeatures,
  type FactorposEdition,
} from '@shared/edition';

export function useEdition(): { edition: FactorposEdition } & EditionFeatures {
  const raw = useAuthStore((s) => s.currentTenant?.edition);
  const edition = normalizeEdition(raw);
  return { edition, ...editionFeatures(edition) };
}

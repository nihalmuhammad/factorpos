/**
 * FactorPOS: which edition this build is (see shared/edition.ts).
 *
 * Packaged builds read `factorposEdition` from the app's own package.json, which the
 * ZATCA installer build sets (electron-builder extraMetadata). Development runs may set
 * FACTORPOS_EDITION; packaged builds ignore it, so a shop PC cannot be switched by an
 * environment variable.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { normalizeEdition, type FactorposEdition } from '../shared/edition';

let cached: FactorposEdition | null = null;

function readPackagedEdition(): unknown {
  try {
    const file = path.join(app.getAppPath(), 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.factorposEdition;
  } catch {
    return undefined;
  }
}

export function currentEdition(): FactorposEdition {
  if (cached) return cached;
  const packaged = Boolean(app?.isPackaged);
  const fromEnv = packaged ? undefined : process.env.FACTORPOS_EDITION;
  cached = normalizeEdition(fromEnv ?? readPackagedEdition());
  return cached;
}

/** Tests choose the edition; pass null to read it again from the build. */
export function setEditionForTests(edition: FactorposEdition | null): void {
  cached = edition;
}

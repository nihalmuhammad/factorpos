/**
 * FactorPOS customization guard.
 *
 * FactorPOS merges FloCafe updates from `upstream`. A merge must never undo a
 * FactorPOS customization silently, so each one is pinned here. If an
 * upstream merge breaks this test, resolve the merge in FactorPOS's favour, or
 * change the customization on purpose and update this test (and
 * docs/FACTORPOS_CUSTOMIZATIONS.md) in the same commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FACTORPOS_DEFAULTS } from '../shared/factorpos-defaults';
import { formatCurrencyForTenant, formatDateForTenant, formatNumberForTenant, getCountryByCode } from '../main/countries';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(root, relativePath), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

/** UI languages offered in the language picker. FactorPOS doesn't widen this list (plan §5). */
const FACTORPOS_SELECTABLE_LANGUAGES = ['de', 'en', 'es', 'fa', 'fil', 'fr', 'pt', 'tr'];

test('product identity stays FactorPOS', () => {
  assert.equal(pkg.name, 'factorpos');
  assert.equal(pkg.build.appId, 'com.factorpos.desktop', 'unique app ID keeps FactorPOS apart from FloCafe installs');
  assert.equal(pkg.build.productName, 'FactorPOS');
  assert.match(pkg.build.win.artifactName, /^factorpos-/);
  assert.match(pkg.build.mac.artifactName, /^factorpos-/);
  assert.equal(pkg.build.win.target.some((target: { target: string }) => target.target === 'nsis'), true, 'Windows NSIS installer stays a build target');

  const indexTs = read('main/index.ts');
  assert.match(indexTs, /app\.name = 'factorpos';/);
  assert.match(indexTs, /app\.setPath\('userData', path\.join\(os\.homedir\(\), '\.config', 'factorpos'\)\)/,
    'shop data stays in the factorpos data folder');
  assert.match(indexTs, /label: 'About FactorPOS'/);

  for (const html of ['renderer/index.html', 'renderer/kds.html']) {
    assert.match(read(html), /<title>FactorPOS - /, `${html} title`);
  }
  assert.equal(findKey(read('frontend/src/lib/i18n/messages/en.json'), 'aboutFloCafe'), 'About FactorPOS');
  assert.match(read('main/services/google-drive.ts'), /DRIVE_BACKUP_FOLDER_NAME = 'FactorPOS Backups'/);
  assert.match(read('frontend/src/lib/printer/branding.ts'), /RECEIPT_BRANDING = 'Powered by FactorPOS'/);
  assert.match(read('main/printers/formatting-helpers.ts'), /RECEIPT_BRANDING = 'Powered by FactorPOS'/);
});

test('shop PCs update from FactorPOS releases only', () => {
  assert.deepEqual(
    { provider: pkg.build.publish.provider, owner: pkg.build.publish.owner, repo: pkg.build.publish.repo },
    { provider: 'github', owner: 'nihalmuhammad', repo: 'factorpos' },
    'the updater feed must point at the FactorPOS repository, never FloCafe',
  );

  const release = read('.github/workflows/factorpos-release.yml');
  assert.match(release, /tags:\s*\n\s*- 'v\*'/, 'FactorPOS releases are cut from v* tags');
  assert.match(release, /--win nsis --x64 --publish never/);
  assert.match(release, /channel=beta; PRERELEASE=true|CHANNEL=beta; PRERELEASE=true/);

  const upstreamRelease = read('.github/workflows/release.yml');
  assert.doesNotMatch(upstreamRelease, /- 'v\*'|- "v\*"/, "upstream release.yml must not also fire on FactorPOS's v* tags");

  assert.match(read('.github/workflows/factorpos-upstream-sync.yml'), /^on:\s*\n\s*workflow_dispatch:\s*$/m,
    'the FloCafe review workflow is kept and runs only on demand');
  assert.match(read('.github/workflows/nightly-release.yml'), /^on:\s*\n\s*workflow_dispatch:\s*$/m,
    'the cross-platform matrix stays manual-only (Actions usage policy)');
});

test('an update is never installed without a fresh database backup', () => {
  assert.match(read('main/updater-shutdown.ts'), /backupBeforeInstall\?: \(\) => Promise<void>;/);
  assert.match(read('main/updater-shutdown.ts'), /await backupBeforeInstall\(\);/);
  const indexTs = read('main/index.ts');
  const handler = indexTs.slice(indexTs.indexOf("ipcMain.handle('restart-and-install'"));
  assert.match(handler.slice(0, 800), /backupBeforeInstall: async \(\) => \{\s*const backup = await createBackup\(\);/,
    'restart-and-install wires the pre-install backup');
});

test('Saudi defaults: English UI, SAR, Riyadh time, digits 0-9', () => {
  assert.deepEqual({ ...FACTORPOS_DEFAULTS }, {
    country: 'SA',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    language: 'en',
    numberDigits: 'latin',
  });
  assert.match(read('main/routes/auth.ts'), /FACTORPOS_DEFAULTS/, 'first-run setup API uses the FactorPOS defaults');

  const sa = getCountryByCode('SA');
  assert.ok(sa);
  assert.equal(sa.currency, 'SAR');
  assert.equal(sa.timezone, 'Asia/Riyadh');
  assert.ok(sa.localeOptions?.digits?.includes('latin'), 'Saudi profile offers Western digits');

  const digits = { digits: FACTORPOS_DEFAULTS.numberDigits };
  const samples = [
    formatCurrencyForTenant(1234.5, 'SA', 'SAR', digits),
    formatNumberForTenant(9876543, 'SA', digits),
    formatDateForTenant(new Date('2026-11-09T12:34:00Z'), 'SA', FACTORPOS_DEFAULTS.timezone, digits,
      { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
  ];
  for (const sample of samples) {
    assert.doesNotMatch(String(sample), ARABIC_INDIC_DIGITS, `"${sample}" must use digits 0-9`);
    assert.match(String(sample), /[0-9]/);
  }
});

test('language picker keeps the FactorPOS language list', () => {
  const source = read('frontend/src/lib/i18n/languages.ts');
  const selectable: string[] = [];
  const entry = /^ {2}['"]?([a-z-]+)['"]?: \{[\s\S]*?selectable: (true|false)/gm;
  for (let match = entry.exec(source); match; match = entry.exec(source)) {
    if (match[2] === 'true') selectable.push(match[1]);
  }
  assert.deepEqual(selectable.sort(), FACTORPOS_SELECTABLE_LANGUAGES,
    'new upstream languages may be added with selectable: false, but the picker list stays the same');
});

test('compact receipt stays the FactorPOS order note', () => {
  const compact = read('main/printers/document-compact.ts');
  assert.match(compact, /ORDER NOTE/);
  assert.match(compact, /TOKEN #\$\{meta\.tokenNumber\}/, 'compact receipt prints the day token');
  assert.doesNotMatch(compact, /appendPoweredByFooter/, 'compact order note carries no branding footer');
  assert.match(read('shared/print/document.ts'), /readonly tokenNumber: number \| null;/);
});

test('FactorPOS regression suites stay in npm test', () => {
  const testChain: string = pkg.scripts.test;
  for (const script of [
    'test:factorpos-customizations',
    'test:printer',
    'test:raster',
    'test:shutdown-lifecycle',
    'test:migration-v85-token-number',
    'test:cash-closures',
    'test:country-localization',
    'test:currency',
    'test:issue-390-locale-preference-invariants',
    'test:first-run',
  ]) {
    assert.ok(testChain.includes(`npm run ${script} `) || testChain.endsWith(`npm run ${script}`), `${script} is part of npm test`);
  }
});

/** Finds a string value for a key anywhere in a JSON document. */
function findKey(json: string, key: string): unknown {
  const search = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return undefined;
    for (const [name, value] of Object.entries(node)) {
      if (name === key) return value;
      const nested = search(value);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return search(JSON.parse(json));
}

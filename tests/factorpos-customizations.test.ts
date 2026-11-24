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
import {
  formatCurrencyForTenant,
  formatDateForTenant,
  formatNumberForTenant,
  getCountryByCode,
} from '../main/countries';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');
const pkg = JSON.parse(read('package.json'));
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

/** UI languages offered in the language picker. FactorPOS doesn't widen this list (plan §5). */
const FACTORPOS_SELECTABLE_LANGUAGES = ['de', 'en', 'es', 'fa', 'fil', 'fr', 'pt', 'tr'];

test('product identity stays FactorPOS', () => {
  assert.equal(pkg.name, 'factorpos');
  assert.equal(
    pkg.build.appId,
    'com.factorpos.desktop',
    'unique app ID keeps FactorPOS apart from FloCafe installs',
  );
  assert.equal(pkg.build.productName, 'FactorPOS');
  assert.match(pkg.build.win.artifactName, /^factorpos-/);
  assert.match(pkg.build.mac.artifactName, /^factorpos-/);
  assert.equal(
    pkg.build.win.target.some((target: { target: string }) => target.target === 'nsis'),
    true,
    'Windows NSIS installer stays a build target',
  );

  const indexTs = read('main/index.ts');
  assert.match(indexTs, /app\.name = 'factorpos';/);
  assert.match(
    indexTs,
    /app\.setPath\('userData', path\.join\(os\.homedir\(\), '\.config', 'factorpos'\)\)/,
    'shop data stays in the factorpos data folder',
  );
  assert.match(indexTs, /label: 'About FactorPOS'/);

  assert.equal(
    findKey(read('frontend/src/lib/i18n/messages/en.json'), 'aboutFloCafe'),
    'About FactorPOS',
  );
  assert.match(
    read('main/services/google-drive.ts'),
    /DRIVE_BACKUP_FOLDER_NAME = 'FactorPOS Backups'/,
  );
  assert.match(
    read('frontend/src/lib/printer/branding.ts'),
    /RECEIPT_BRANDING = 'Powered by FactorPOS'/,
  );
  assert.match(
    read('main/printers/formatting-helpers.ts'),
    /RECEIPT_BRANDING = 'Powered by FactorPOS'/,
  );
});

test('shop PCs update from FactorPOS releases only', () => {
  assert.deepEqual(
    {
      provider: pkg.build.publish.provider,
      owner: pkg.build.publish.owner,
      repo: pkg.build.publish.repo,
    },
    { provider: 'github', owner: 'nihalmuhammad', repo: 'factorpos' },
    'the updater feed must point at the FactorPOS repository, never FloCafe',
  );

  const release = read('.github/workflows/factorpos-release.yml');
  assert.match(release, /tags:\s*\n\s*- 'v\*'/, 'FactorPOS releases are cut from v* tags');
  assert.match(release, /--win nsis --x64 --publish never/);
  assert.match(release, /channel=beta; PRERELEASE=true|CHANNEL=beta; PRERELEASE=true/);

  const upstreamRelease = read('.github/workflows/release.yml');
  assert.doesNotMatch(
    upstreamRelease,
    /- 'v\*'|- "v\*"/,
    "upstream release.yml must not also fire on FactorPOS's v* tags",
  );

  assert.match(
    read('.github/workflows/factorpos-upstream-sync.yml'),
    /^on:\s*\n\s*workflow_dispatch:\s*$/m,
    'the FloCafe review workflow is kept and runs only on demand',
  );
  assert.match(
    read('.github/workflows/full-cross-platform-matrix.yml'),
    /^on:\s*\n\s*workflow_dispatch:\s*$/m,
    'the cross-platform matrix stays manual-only (Actions usage policy)',
  );
});

test('an update is never installed without a fresh database backup', () => {
  assert.match(read('main/updater-shutdown.ts'), /backupBeforeInstall\?: \(\) => Promise<void>;/);
  assert.match(read('main/updater-shutdown.ts'), /await backupBeforeInstall\(\);/);
  const indexTs = read('main/index.ts');
  const handler = indexTs.slice(
    indexTs.indexOf('restartAndInstallHandler: createRestartAndInstallHandler('),
  );
  assert.match(
    handler.slice(0, 900),
    /backupBeforeInstall: async \(\) => \{\s*const backup = await createBackup\(\);/,
    'restart-and-install wires the pre-install backup',
  );
});

test('Saudi defaults: English UI, SAR, Riyadh time, digits 0-9', () => {
  assert.deepEqual(
    { ...FACTORPOS_DEFAULTS },
    {
      country: 'SA',
      currency: 'SAR',
      timezone: 'Asia/Riyadh',
      language: 'en',
      numberDigits: 'latin',
    },
  );
  assert.match(
    read('main/routes/auth.ts'),
    /FACTORPOS_DEFAULTS/,
    'first-run setup API uses the FactorPOS defaults',
  );

  const sa = getCountryByCode('SA');
  assert.ok(sa);
  assert.equal(sa.currency, 'SAR');
  assert.equal(sa.timezone, 'Asia/Riyadh');
  assert.ok(sa.localeOptions?.digits?.includes('latin'), 'Saudi profile offers Western digits');

  const digits = { digits: FACTORPOS_DEFAULTS.numberDigits };
  const samples = [
    formatCurrencyForTenant(1234.5, 'SA', 'SAR', digits),
    formatNumberForTenant(9876543, 'SA', digits),
    formatDateForTenant(
      new Date('2026-11-09T12:34:00Z'),
      'SA',
      FACTORPOS_DEFAULTS.timezone,
      digits,
      { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
    ),
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
  assert.deepEqual(
    selectable.sort(),
    FACTORPOS_SELECTABLE_LANGUAGES,
    'new upstream languages may be added with selectable: false, but the picker list stays the same',
  );
});

test('compact receipt stays the FactorPOS order note', () => {
  const compact = read('main/printers/document-compact.ts');
  assert.match(compact, /ORDER NOTE/);
  assert.match(compact, /TOKEN #\$\{meta\.tokenNumber\}/, 'compact receipt prints the day token');
  assert.doesNotMatch(
    compact,
    /appendPoweredByFooter/,
    'compact order note carries no branding footer',
  );
  assert.match(read('shared/print/document.ts'), /readonly tokenNumber: number \| null;/);
});

test('bill formats follow the printer setting; only compact is the token ORDER NOTE', () => {
  const usePrinter = read('frontend/src/hooks/usePrinter.ts');
  assert.match(usePrinter, /compactLayout: rasterBillTemplate === 'compact'/);
  assert.doesNotMatch(usePrinter, /compactLayout: true/, 'browser bills are not forced compact');
  assert.match(
    read('frontend/src/lib/printer/web-print.ts'),
    /compactLayout && meta\?\.tokenNumber !== null/,
    'browser token line is compact-only',
  );
  assert.match(read('main/db.ts'), /'2026-11-24-bill-template-compact-default'/);
});

test('Saudi simplified tax invoice with the ZATCA QR is a core bill format', () => {
  assert.match(
    read('main/services/print-templates.ts'),
    /CORE_BILL_TEMPLATES = \['classic', 'compact', 'saudi'\]/,
  );
  assert.match(read('main/printers/thermal.ts'), /renderSaudiReceiptViaDocument/);
  assert.match(read('frontend/src/app/(dashboard)/settings/page.tsx'), /id: 'saudi'/);
  assert.match(read('frontend/src/hooks/usePrinter.ts'), /\/bills\/\$\{bill\.id\}\/zatca-qr/);
  assert.match(read('main/routes/bills.ts'), /'\/:id\/zatca-qr'/);
  // Until FactorPOS signs and reports invoices, the Saudi format is a marked preview.
  assert.match(read('shared/print/zatca-qr.ts'), /export const ZATCA_PREVIEW_ONLY = true;/);
});

test('ZATCA fiscal records stay wired into payments and refunds, off by default', () => {
  const bills = read('main/routes/bills.ts');
  assert.ok(
    (bills.match(/recordFiscalInvoiceIfPaid\(db, /g) ?? []).length >= 4,
    'every paid path records',
  );
  assert.match(read('main/services/refund.ts'), /recordRefundCreditNote\(db, req\.billId/);
  const db = read('main/db.ts');
  assert.match(db, /'2026-11-24-zatca-fiscal-records'/);
  assert.match(db, /VALUES \('zatca_environment', 'disabled', \?\)/);
  assert.match(db, /zatca_fiscal_documents_no_delete/);
  assert.match(db, /'2026-11-24-zatca-credentials'/);
  // Electron's BoringSSL has no secp256k1; signing must keep using @noble/curves.
  assert.match(read('main/services/zatca/signing.ts'), /from '@noble\/curves\/secp256k1'/);
  assert.equal(pkg.dependencies['@noble/curves'], '1.9.7');
});

test('ZATCA onboarding stays mounted, simulation-only, with keys in secure storage', () => {
  assert.match(read('main/routes/index.ts'), /app\.use\('\/api\/zatca', zatcaRoutes\)/);
  const routes = read('main/routes/zatca.ts');
  assert.match(routes, /environment: 'simulation',/, 'onboarding runs against simulation only');
  assert.match(routes, /zatca_production_not_enabled/, 'production issuance stays refused');
  assert.match(read('main/db.ts'), /'2026-11-24-zatca-onboarding'/);
  assert.match(
    read('main/services/zatca/credentials.ts'),
    /environment === 'simulation' && process\.env\.FACTORPOS_ZATCA_PLAIN_TEST_KEYS === '1'/,
  );
  assert.match(
    read('frontend/src/app/(dashboard)/settings/page.tsx'),
    /<ZatcaSettingsCard /,
    'the ZATCA card is on the Tax tab',
  );
});

test('ZATCA reporting: queued with every signed document, worker runs with the app', () => {
  const fiscal = read('main/services/zatca-fiscal.ts');
  assert.ok(
    (fiscal.match(/enqueueReport\(db, id, createdAt\);/g) ?? []).length >= 2,
    'invoices and credit notes are queued',
  );
  const index = read('main/index.ts');
  assert.match(index, /zatcaReporting\.start\(\);/, 'worker starts with the app');
  assert.match(index, /run: \(\) => zatcaReporting\.stop\(\)/, 'worker stops on shutdown');
  assert.match(read('frontend/src/components/layout/Sidebar.tsx'), /href: '\/zatca'/);
  assert.match(
    read('frontend/src/components/layout/AuthGuard.tsx'),
    /\['\/zatca', 'reports\.view'\]/,
  );
  assert.match(read('frontend/src/app/(dashboard)/layout.tsx'), /<ZatcaReportingAlert \/>/);
});

test('editions: KOT by default; the ZATCA installer has its own identity and feed', () => {
  assert.equal(pkg.factorposEdition, 'kot', 'the default build is the KOT edition');
  const zatca = require('../scripts/release/electron-builder-zatca.cjs');
  assert.equal(zatca.extraMetadata.factorposEdition, 'zatca');
  assert.notEqual(zatca.appId, pkg.build.appId, 'own app ID: own install and data folder');
  assert.equal(zatca.productName, 'FactorPOS ZATCA');
  assert.equal(zatca.publish.provider, 'generic');
  assert.match(zatca.publish.url, /\/releases\/download\/zatca-updates$/, 'own update feed');
  assert.match(zatca.win.artifactName, /^factorpos-zatca-/);
  assert.equal(pkg.build.publish.provider, 'github', 'KOT keeps the versioned GitHub feed');
  for (const file of [
    'frontend/src/app/(dashboard)/dashboard/page.tsx',
    'frontend/src/components/orders/OrderCard.tsx',
    'frontend/src/components/orders/OrdersMasterList.tsx',
    'frontend/src/components/orders/OrderDetailPanel.tsx',
  ]) {
    assert.match(read(file), /showsOrderToken && order\.token_number != null/, file);
  }
  const guard = read('frontend/src/components/layout/AuthGuard.tsx');
  assert.match(guard, /!editionAllowsPath\(currentTenant, pathname\)/, 'KOT cannot open /zatca');
  assert.match(guard, /editionAllowsPath\(tenant, path\)/, 'KOT never lands on /zatca');
  const workflow = read('.github/workflows/factorpos-release.yml');
  assert.match(workflow, /edition: zatca/, 'the release builds the ZATCA installer');
  assert.match(workflow, /gh release upload zatca-updates/, 'and refreshes its feed');
});

test('orders carry the day token and setup preselects Saudi Arabia', () => {
  const orders = read('main/routes/orders.ts');
  assert.match(
    orders,
    /const tokenNumber = generateTokenNumber\(\);/,
    'order creation assigns the day token',
  );
  assert.match(
    orders,
    /INSERT INTO orders \(order_number, token_number,/,
    'the token is stored with the order',
  );
  assert.match(
    read('main/routes/cash-closures.ts'),
    /resetTokenNumber\(businessDate\);/,
    'day close resets tokens',
  );
  const setup = read('frontend/src/app/setup/page.tsx');
  assert.match(
    setup,
    /useState<string>\(FACTORPOS_DEFAULTS\.country\)/,
    'setup preselects the FactorPOS country',
  );
  assert.match(
    setup,
    /useState<string>\(FACTORPOS_DEFAULTS\.timezone\)/,
    'setup preselects the FactorPOS timezone',
  );
  assert.doesNotMatch(
    read('frontend/src/lib/operation-failure.ts'),
    /'FloCafe /,
    'support ticket subjects say FactorPOS',
  );
});

test('setup lists the selected country first', () => {
  const { selectedCountryFirst } = require('../frontend/src/lib/factorpos-setup');
  const { COUNTRIES } = require('../main/countries');
  const pinned = [...COUNTRIES].sort((a: { code: string }, b: { code: string }) =>
    a.code === 'IN' ? -1 : b.code === 'IN' ? 1 : 0,
  );
  assert.equal(pinned[0].code, 'IN', 'fixture: FloCafe pins India first');
  const listed = selectedCountryFirst(pinned, FACTORPOS_DEFAULTS.country);
  assert.equal(listed[0].code, 'SA', 'the preselected Saudi Arabia is the first row, tick in view');
  assert.equal(listed.length, pinned.length, 'no country is dropped');
  assert.equal(
    selectedCountryFirst(pinned, '').length,
    pinned.length,
    'no selection leaves the list alone',
  );
  assert.match(
    read('frontend/src/app/setup/page.tsx'),
    /selectedCountryFirst\(/,
    'the setup screen uses the selected-country-first order',
  );
});

test('FactorPOS regression suites stay in npm test', () => {
  const testChain: string = pkg.scripts.test;
  for (const script of [
    'test:factorpos-customizations',
    'test:printer',
    'test:raster',
    'test:shutdown-lifecycle',
    'test:factorpos-migrations',
    'test:factorpos-saudi-invoice',
    'test:factorpos-editions',
    'test:factorpos-zatca-fiscal-records',
    'test:factorpos-zatca-engine',
    'test:factorpos-zatca-onboarding',
    'test:factorpos-zatca-reporting',
    'test:monthly-vat-export',
    'test:cash-closures',
    'test:country-localization',
    'test:currency',
    'test:issue-390-locale-preference-invariants',
    'test:first-run',
  ]) {
    assert.ok(
      testChain.includes(`npm run ${script} `) || testChain.endsWith(`npm run ${script}`),
      `${script} is part of npm test`,
    );
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

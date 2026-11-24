/**
 * FactorPOS editions (shared/edition.ts): the KOT edition prints token bills and has no
 * ZATCA; the ZATCA edition prints only the Saudi simplified tax invoice and has ZATCA.
 * Both print kitchen KOT tickets the same way.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-editions.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-editions-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { currentEdition, setEditionForTests } = require('../main/edition');
const { billTemplateAllowed, editionFeatures, normalizeEdition } = require('../shared/edition');
const { settingsRoutes } = require('../main/routes/settings');
const { authRoutes } = require('../main/routes/auth');
const { zatcaRoutes } = require('../main/routes/zatca');
const { activeZatcaEnvironment } = require('../main/services/zatca-fiscal');
const { formatKOT, escPosToText } = require('../main/printers/thermal');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

const core = (id: string) => JSON.stringify({ source: 'core', id });

async function main() {
  console.log('FactorPOS editions: KOT and ZATCA from one codebase');
  console.log('='.repeat(72));

  console.log('\n─── Rules ───');
  assertEqualOrThrow(normalizeEdition(undefined), 'kot', 'no edition means KOT (existing shops)');
  assertEqualOrThrow(normalizeEdition('ZATCA'), 'zatca', 'case-insensitive');
  assertEqualOrThrow(normalizeEdition('other'), 'kot', 'unknown means KOT');
  assertOrThrow(billTemplateAllowed('zatca', { source: 'core', id: 'saudi' }), 'ZATCA: saudi');
  assertOrThrow(
    !billTemplateAllowed('zatca', { source: 'core', id: 'compact' }),
    'ZATCA: no compact',
  );
  assertOrThrow(
    !billTemplateAllowed('zatca', { source: 'core', id: 'classic' }),
    'ZATCA: no classic',
  );
  assertOrThrow(!billTemplateAllowed('zatca', { source: 'pack', id: 'x' }), 'ZATCA: no pack bills');
  assertOrThrow(!billTemplateAllowed('kot', { source: 'core', id: 'saudi' }), 'KOT: no Saudi bill');
  assertOrThrow(
    billTemplateAllowed('kot', { source: 'merchant', id: 'm1' }),
    'KOT: merchant bills',
  );
  assertEqualOrThrow(editionFeatures('kot').showsOrderToken, true, 'KOT shows the token');
  assertEqualOrThrow(editionFeatures('zatca').showsOrderToken, false, 'ZATCA hides the token');

  setEditionForTests(null);
  assertEqualOrThrow(currentEdition(), 'kot', 'a build without factorposEdition is KOT');

  const db = initTestDb();
  setSetting(db, 'country', 'SA');
  setSetting(db, 'currency', 'SAR');
  setSetting(db, 'timezone', 'Asia/Riyadh');
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({
    '/api/settings': settingsRoutes,
    '/api/auth': authRoutes,
    '/api/zatca': zatcaRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const putTemplate = (value: string) =>
    api(baseUrl, '/api/settings/bill_template', {
      method: 'PUT',
      body: { value },
      headers: authHeader,
    });
  const template = async () =>
    (await api(baseUrl, '/api/settings/bill_template', { headers: authHeader })).data.setting.value;
  const tenant = async () => (await api(baseUrl, '/api/auth/me', { headers: authHeader })).data;

  const kitchenTicket = () =>
    escPosToText(
      formatKOT(
        {
          order_number: 'ORD-1',
          type: 'dine_in',
          created_at: '2026-11-24 09:00:00',
          token_number: 4,
        },
        [{ product_name: 'Chicken Mandi', quantity: 2, addons: [] }],
        'Kitchen',
        48,
      ),
    );

  try {
    console.log('\n─── KOT edition ───');
    setEditionForTests('kot');
    {
      const me = await tenant();
      const t = me.tenant ?? me.tenants?.[0];
      assertEqualOrThrow(t?.edition, 'kot', 'screens are told KOT');
      const saudi = await putTemplate(core('saudi'));
      assertEqualOrThrow(saudi.status, 400, 'the Saudi bill cannot be chosen');
      assertEqualOrThrow(saudi.data.code, 'bill_template_not_in_edition', 'refusal code');
      assertEqualOrThrow((await putTemplate(core('compact'))).status, 200, 'compact can be chosen');
      assertEqualOrThrow(JSON.parse(await template()).id, 'compact', 'compact is printed');
      assertEqualOrThrow((await putTemplate(core('classic'))).status, 200, 'classic can be chosen');
      setSetting(db, 'bill_template', core('saudi')); // e.g. restored from another till
      assertEqualOrThrow(await template(), 'compact', 'a stored Saudi bill prints as compact');
      setSetting(db, 'zatca_environment', 'simulation');
      assertEqualOrThrow(activeZatcaEnvironment(db), null, 'ZATCA issuance never starts');
      const zatca = await api(baseUrl, '/api/zatca', { headers: authHeader });
      assertEqualOrThrow(zatca.status, 404, 'no ZATCA routes');
      setSetting(db, 'zatca_environment', 'disabled');
    }
    const kotKitchen = kitchenTicket();

    console.log('\n─── ZATCA edition ───');
    setEditionForTests('zatca');
    {
      const me = await tenant();
      const t = me.tenant ?? me.tenants?.[0];
      assertEqualOrThrow(t?.edition, 'zatca', 'screens are told ZATCA');
      setSetting(db, 'bill_template', core('compact')); // e.g. restored from a KOT till
      assertEqualOrThrow(
        await template(),
        'saudi',
        'a stored compact bill prints as the Saudi invoice',
      );
      for (const id of ['compact', 'classic']) {
        const res = await putTemplate(core(id));
        assertEqualOrThrow(res.status, 400, `${id} cannot be chosen`);
      }
      assertEqualOrThrow(
        (await putTemplate(core('saudi'))).status,
        200,
        'Saudi invoice can be chosen',
      );
      assertEqualOrThrow(JSON.parse(await template()).id, 'saudi', 'Saudi invoice is printed');
      const zatca = await api(baseUrl, '/api/zatca', { headers: authHeader });
      assertEqualOrThrow(zatca.status, 200, 'ZATCA routes are there');
      assertEqualOrThrow(zatca.data.vat_check?.ok, false, 'VAT is not set up in this test shop');
      assertOrThrow(
        /CR number/.test(zatca.data.seller_check.problem) &&
          !/\bcrn\b|buildingNumber|postalCode/.test(zatca.data.seller_check.problem),
        'missing seller details are named in words, not field codes',
      );
      const noVat = await api(baseUrl, '/api/zatca/environment', {
        method: 'PUT',
        body: { environment: 'simulation' },
        headers: authHeader,
      });
      assertEqualOrThrow(noVat.status, 409, 'ZATCA invoices cannot switch on without Saudi VAT');
      assertEqualOrThrow(noVat.data.code, 'zatca_vat_not_configured', 'refusal code');
      setSetting(db, 'zatca_environment', 'simulation');
      assertEqualOrThrow(
        activeZatcaEnvironment(db),
        'simulation',
        'ZATCA issuance follows the setting',
      );
      setSetting(db, 'zatca_environment', 'disabled');
    }
    const zatcaKitchen = kitchenTicket();

    console.log('\n─── Kitchen KOT tickets are the same in both ───');
    assertOrThrow(kotKitchen.includes('Chicken Mandi'), 'KOT edition prints the kitchen ticket');
    assertEqualOrThrow(
      zatcaKitchen,
      kotKitchen,
      'ZATCA edition prints the identical kitchen ticket',
    );
  } finally {
    setEditionForTests(null);
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed } = getResults();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

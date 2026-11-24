/**
 * FactorPOS migration track: fresh installs, the legacy v85 repair, and the
 * guarantee that FactorPOS never claims an upstream FloCafe schema number.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = '';
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  FACTORPOS_MIGRATIONS,
  closeDatabase,
  buildIdealSchemaDb,
  SchemaVersionMismatchError,
  getTables,
} = require('../main/db');

const TOKEN_MIGRATION_ID = '2026-09-28-add-daily-close-token-number';
const UPSTREAM_TARGET = MIGRATIONS[MIGRATIONS.length - 1].version;

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

function freshDir(label: string) {
  if (activeTestDir) fs.rmSync(activeTestDir, { recursive: true, force: true });
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), `factorpos-migrations-${label}-`));
}

function hasTokenColumn(db: any): boolean {
  return (db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).some(
    (column) => column.name === 'token_number',
  );
}

function appliedIds(db: any): string[] {
  return (
    db.prepare('SELECT id FROM _factorpos_migrations ORDER BY id').all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function backups(pattern: RegExp): string[] {
  const dir = path.join(activeTestDir, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name: string) => pattern.test(name)) : [];
}

const ALL_MIGRATIONS = MIGRATIONS.slice();

/** Opens a database built only from FloCafe 3.9.0's migrations (v84), like an old FactorPOS shop PC. */
function initLegacyBaseDatabase() {
  MIGRATIONS.splice(
    0,
    MIGRATIONS.length,
    ...ALL_MIGRATIONS.filter((migration: any) => migration.version <= 84),
  );
  try {
    initDatabase();
  } finally {
    MIGRATIONS.splice(0, MIGRATIONS.length, ...ALL_MIGRATIONS);
  }
}

/** Rewinds the current database to the state an older FactorPOS build left it in. */
function rewindToLegacy(version: number, keepToken: boolean) {
  const db = getDatabase();
  if (!keepToken) {
    db.exec('DROP INDEX IF EXISTS idx_orders_token_number');
    db.exec('ALTER TABLE orders DROP COLUMN token_number');
  }
  db.exec('DROP TABLE _factorpos_migrations');
  db.pragma(`user_version = ${version}`);
  closeDatabase();
}

function main() {
  assert(
    MIGRATIONS.every((migration: any) => migration.name !== 'add_daily_close_token_number'),
    'no FactorPOS migration uses an upstream schema number',
  );

  freshDir('fresh');
  initDatabase();
  let db = getDatabase();
  assert(
    getCurrentSchemaVersion() === UPSTREAM_TARGET,
    'fresh install stays on upstream numbering',
  );
  assert(hasTokenColumn(db), 'fresh install includes orders.token_number');
  assert(
    appliedIds(db).length === FACTORPOS_MIGRATIONS.length,
    'fresh install records every FactorPOS migration',
  );
  closeDatabase();

  const ideal = buildIdealSchemaDb();
  assert(hasTokenColumn(ideal), 'ideal schema reference includes FactorPOS columns');
  ideal.close();

  // Shop databases from FactorPOS 3.9.0–3.9.1-beta.1 sit at user_version 85.
  freshDir('legacy-v85');
  initLegacyBaseDatabase();
  getDatabase()
    .prepare(
      `INSERT INTO orders (order_number, type, status, token_number) VALUES ('ORD-LEGACY-85', 'takeaway', 'completed', 7)`,
    )
    .run();
  rewindToLegacy(85, true);
  initDatabase();
  db = getDatabase();
  assert(
    getCurrentSchemaVersion() === UPSTREAM_TARGET,
    'legacy v85 database rejoins upstream numbering and runs FloCafe v85+',
  );
  assert(
    getTables(db).includes('inventory_movements'),
    "FloCafe's own v85 (inventory_movements) ran after the repair",
  );
  assert(
    appliedIds(db).includes(TOKEN_MIGRATION_ID),
    'legacy token migration is recorded as applied',
  );
  const legacy = db
    .prepare(`SELECT token_number FROM orders WHERE order_number = 'ORD-LEGACY-85'`)
    .get() as any;
  assert(legacy?.token_number === 7, 'repair keeps existing orders and their tokens');
  assert(backups(/pre-v85-to-v84\.db$/).length === 1, 'repair takes a backup first');
  const backupCount = backups(/\.db$/).length;
  closeDatabase();
  initDatabase();
  assert(
    getCurrentSchemaVersion() === UPSTREAM_TARGET && backups(/\.db$/).length === backupCount,
    'restart after repair is a no-op',
  );
  closeDatabase();

  // A v84 database from before the token feature gets the column through the FactorPOS track.
  freshDir('v84');
  initLegacyBaseDatabase();
  getDatabase()
    .prepare(
      `INSERT INTO orders (order_number, type, status) VALUES ('ORD-LEGACY-84', 'takeaway', 'completed')`,
    )
    .run();
  rewindToLegacy(84, false);
  initDatabase();
  db = getDatabase();
  assert(hasTokenColumn(db), 'v84 upgrade adds orders.token_number');
  assert(getCurrentSchemaVersion() === UPSTREAM_TARGET, 'v84 upgrade keeps upstream numbering');
  const old = db
    .prepare(`SELECT token_number FROM orders WHERE order_number = 'ORD-LEGACY-84'`)
    .get() as any;
  assert(old && old.token_number === null, 'v84 upgrade preserves existing orders');
  assert(backups(/pre-v84-to-v125\.db$/).length === 1, 'upgrade takes a backup first');
  closeDatabase();

  // A database that really ran FloCafe's v85 (inventory_movements exists) must not be rewound.
  freshDir('upstream-v85');
  MIGRATIONS.splice(
    0,
    MIGRATIONS.length,
    ...ALL_MIGRATIONS.filter((migration: any) => migration.version <= 85),
  );
  try {
    initDatabase();
  } finally {
    MIGRATIONS.splice(0, MIGRATIONS.length, ...ALL_MIGRATIONS);
  }
  assert(
    getCurrentSchemaVersion() === 85 && getTables(getDatabase()).includes('inventory_movements'),
    'fixture ran FloCafe v85',
  );
  closeDatabase();
  initDatabase();
  assert(
    backups(/pre-v85-to-v84\.db$/).length === 0,
    'an upstream-owned v85 database is not rewound',
  );
  assert(
    getCurrentSchemaVersion() === UPSTREAM_TARGET,
    'an upstream-owned v85 database upgrades normally',
  );
  closeDatabase();

  // Shops kept FloCafe's 'classic' default while the browser always printed the compact
  // ORDER NOTE; the setting is now honoured, so 'classic' moves to 'compact' once.
  const COMPACT = JSON.stringify({ source: 'core', id: 'compact' });
  const billTemplate = () =>
    (getDatabase().prepare(`SELECT value FROM settings WHERE key = 'bill_template'`).get() as any)
      ?.value;
  freshDir('bill-template-fresh');
  initDatabase();
  assert(
    billTemplate() === JSON.stringify({ source: 'core', id: 'classic' }),
    "a fresh install keeps FloCafe's default; the owner picks a format",
  );
  closeDatabase();
  for (const [label, before, after] of [
    ['core-classic', JSON.stringify({ source: 'core', id: 'classic' }), COMPACT],
    ['legacy-classic', 'classic', COMPACT],
    [
      'saudi',
      JSON.stringify({ source: 'core', id: 'saudi' }),
      JSON.stringify({ source: 'core', id: 'saudi' }),
    ],
    [
      'pack',
      JSON.stringify({ source: 'pack', id: 'sa.vat.tax-invoice.v1' }),
      JSON.stringify({ source: 'pack', id: 'sa.vat.tax-invoice.v1' }),
    ],
  ]) {
    freshDir(`bill-template-${label}`);
    initDatabase();
    getDatabase().prepare(`UPDATE settings SET value = ? WHERE key = 'bill_template'`).run(before);
    // An upgraded shop has orders; that is what marks it as an existing shop.
    getDatabase()
      .prepare(
        `INSERT INTO orders (order_number, type, status, token_number) VALUES (?, 'takeaway', 'completed', 1)`,
      )
      .run(`ORD-${label}`);
    getDatabase()
      .prepare(
        `DELETE FROM _factorpos_migrations WHERE id = '2026-11-24-bill-template-compact-default'`,
      )
      .run();
    closeDatabase();
    initDatabase();
    assert(billTemplate() === after, `bill_template ${label}: ${before} → ${after}`);
    getDatabase()
      .prepare(`UPDATE settings SET value = ? WHERE key = 'bill_template'`)
      .run(JSON.stringify({ source: 'core', id: 'classic' }));
    closeDatabase();
    initDatabase();
    assert(
      billTemplate() === JSON.stringify({ source: 'core', id: 'classic' }),
      `bill_template ${label}: a later choice of classic is kept`,
    );
    closeDatabase();
  }

  // A database newer than this build is still refused, never rewritten.
  freshDir('newer');
  initDatabase();
  getDatabase().pragma(`user_version = ${UPSTREAM_TARGET + 1}`);
  closeDatabase();
  let mismatch = false;
  try {
    initDatabase();
  } catch (error) {
    mismatch = error instanceof SchemaVersionMismatchError;
  }
  assert(mismatch, 'a newer database is reported as newer, not rewritten');
  try {
    closeDatabase();
  } catch {}

  fs.rmSync(activeTestDir, { recursive: true, force: true });
  console.log(`\n${passed}/${passed} passed`);
}

main();

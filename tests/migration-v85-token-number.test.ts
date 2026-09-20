/** Fresh-install and v84 upgrade coverage for customer token numbers. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-migration-v85-fresh-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase } = require('../main/db');

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
  passed++;
  console.log(`  ✓ ${message}`);
}

function hasTokenColumn(db: any): boolean {
  return (db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).some((column) => column.name === 'token_number');
}

function runPendingMigrations() {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function main() {
  const allMigrations = MIGRATIONS.slice();

  initDatabase();
  let db = getDatabase();
  assert(hasTokenColumn(db), 'fresh install includes orders.token_number');
  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-migration-v85-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...allMigrations.filter((migration: any) => migration.version <= 84));
  initDatabase();
  db = getDatabase();
  assert(getCurrentSchemaVersion() === 84, 'upgrade fixture starts at schema v84');
  db.exec('ALTER TABLE orders DROP COLUMN token_number');
  assert(!hasTokenColumn(db), 'v84 fixture has no token column');

  db.prepare(`INSERT INTO orders (order_number, type, status) VALUES ('ORD-LEGACY-1', 'takeaway', 'completed')`).run();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...allMigrations);
  runPendingMigrations();

  assert(getCurrentSchemaVersion() === 85, 'upgrade reaches schema v85');
  assert(hasTokenColumn(db), 'upgrade adds orders.token_number');
  const legacy = db.prepare(`SELECT order_number, token_number FROM orders WHERE order_number = 'ORD-LEGACY-1'`).get() as any;
  assert(legacy?.order_number === 'ORD-LEGACY-1' && legacy?.token_number === null, 'upgrade preserves existing orders');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  console.log(`\n${passed}/${passed} passed`);
}

main();

/**
 * FactorPOS dashboard / billing slowness fixes on long-running shop databases.
 *
 * 1. paymentMethodBreakdown returns exactly what the previous single-OR query returned, for
 *    every flag combination, across today, yesterday and a long range, with unpaid, partial,
 *    split, cancelled, refunded and long-unpaid bills in the data.
 * 2. Its bill lookup no longer walks idx_bills_created_at from the first bill ever.
 * 3. The dashboard's average table turn uses idx_orders_type_status_completed.
 * 4. Startup records a clean full integrity check and then uses quick_check; PRAGMA optimize
 *    leaves planner statistics, and schema health accepts the new index.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/factorpos-dashboard-performance.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factorpos-dashboard-performance-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  closeDatabase,
  getSettingValue,
  now,
  dayBoundsInTimezone,
  tenantBusinessDayStartTime,
} = require('../main/db');
const { paymentMethodBreakdown } = require('../main/services/payment-method-breakdown');
const { tenantTimezone } = require('../main/services/cash-drawer-movements');
const { runHealthCheck } = require('../main/services/schema-health');
const cashClosures = require('../main/routes/cash-closures');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function localDate(offsetDays: number): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tenantTimezone() }).format(date);
}

/** The query as it stood in v3.14.1-beta.1, kept here as the reference result. */
function previousBreakdown(db: any, opts: any) {
  const startTime = tenantBusinessDayStartTime(db);
  const endDate = opts.endDate ?? opts.startDate;
  const start = dayBoundsInTimezone(opts.startDate, tenantTimezone(), startTime)[0];
  const end = dayBoundsInTimezone(endDate, tenantTimezone(), startTime)[1];
  return db
    .prepare(
      `
    WITH payment_lines AS (
      SELECT b.paid_at, b.created_at, je.value AS line
      FROM bills b
      LEFT JOIN orders o ON o.id = b.order_id
      JOIN json_each(CASE
        WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array'
          THEN b.payment_details
        WHEN json_valid(b.payment_details)
          THEN json_array(b.payment_details)
        ELSE '[]'
      END) je
      WHERE b.payment_details IS NOT NULL
        AND b.created_at < ?
        AND (b.paid_at IS NULL OR b.paid_at >= ?)
        AND (? = 0 OR b.paid_at IS NOT NULL)
        AND (? = 0 OR COALESCE(o.status, '') != 'cancelled')
        AND json_type(je.value) = 'object'
    ), normalized AS (
      SELECT
        COALESCE(NULLIF(json_extract(line, '$.method'), ''), 'unknown') AS method,
        CAST(json_extract(line, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        json_extract(line, '$.amount') AS amount,
        COALESCE(
          datetime(NULLIF(CASE WHEN ? = 1 THEN NULL ELSE json_extract(line, '$.timestamp') END, '')),
          datetime(NULLIF(paid_at, '')),
          datetime(NULLIF(created_at, ''))
        ) AS payment_time
      FROM payment_lines
      UNION ALL
      SELECT r.method, NULL, -(CAST(r.amount_cents AS REAL) / ?),
        datetime(CASE WHEN ? = 1 THEN b.paid_at ELSE r.created_at END)
      FROM refunds r
      JOIN bills b ON b.id = r.bill_id
      LEFT JOIN orders o ON o.id = b.order_id
      WHERE (? = 0 OR COALESCE(o.status, '') != 'cancelled')
    )
    SELECT COALESCE(pm.name, normalized.method) AS method, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN typeof(amount) IN ('integer', 'real') THEN amount ELSE 0 END), 0) AS total
    FROM normalized LEFT JOIN payment_methods pm ON pm.id = normalized.payment_method_id
    WHERE payment_time >= datetime(?) AND payment_time < datetime(?)
    GROUP BY COALESCE(pm.name, normalized.method)
    ORDER BY total DESC
  `,
    )
    .all(
      end,
      start,
      opts.paidOnly ? 1 : 0,
      opts.excludeCancelledOrders ? 1 : 0,
      opts.keyByPaidAt ? 1 : 0,
      100,
      opts.attributeRefundsToBillDate ? 1 : 0,
      opts.excludeCancelledOrders ? 1 : 0,
      start,
      end,
    );
}

function sortRows(rows: any[]) {
  return [...rows]
    .map((row) => ({ method: row.method, count: row.count, total: Math.round(row.total * 100) }))
    .sort((a, b) => a.method.localeCompare(b.method));
}

function seed(db: any) {
  for (const [key, value] of [
    ['country', 'SA'],
    ['timezone', 'Asia/Riyadh'],
    ['currency', 'SAR'],
  ]) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, now());
  }
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('perf-owner', 'Owner', 'perf-owner@test.local', 'x', 'owner', 1, ?, ?)`,
  ).run(now(), now());
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES (?, 'perf-owner', ?, ?, 40, 40, ?, ?, ?)
  `);
  const insertBill = db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status, payment_details, created_at, paid_at)
    VALUES (?, ?, 40, ?, ?, ?, ?, ?, ?)
  `);
  const insertRefund = db.prepare(`
    INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at)
    VALUES (?, ?, 'cash', 'perf-owner', 'perf-owner', ?)
  `);
  const methods = ['cash', 'card', 'stc_pay'];
  const nowMs = Date.now();
  let n = 0;
  db.transaction(() => {
    // 400 days of history, a few bills a day, plus edge cases.
    for (let day = 400; day >= 0; day--) {
      for (let k = 0; k < 4; k++) {
        n++;
        const created = new Date(nowMs - day * 86_400_000 - k * 3_600_000 - 600_000);
        const paid = new Date(created.getTime() + 20 * 60_000);
        const status = n % 37 === 0 ? 'cancelled' : 'completed';
        const type = n % 3 === 0 ? 'dine_in' : 'takeaway';
        const order = insertOrder.run(
          `ORD-PERF-${n}`,
          type,
          status,
          dbTimestamp(created),
          dbTimestamp(created),
          dbTimestamp(paid),
        );
        let details: string | null;
        let paidAt: string | null = dbTimestamp(paid);
        let paymentStatus = 'paid';
        if (n % 11 === 0) {
          // split payment
          details = JSON.stringify([
            { method: 'cash', amount: 15, timestamp: dbTimestamp(paid) },
            { method: 'card', amount: 25, timestamp: dbTimestamp(paid) },
          ]);
        } else if (n % 13 === 0) {
          // partial: still unpaid, one line taken now
          details = JSON.stringify([{ method: 'cash', amount: 10, timestamp: dbTimestamp(paid) }]);
          paidAt = null;
          paymentStatus = 'partial';
        } else if (n % 17 === 0) {
          details = JSON.stringify({ method: methods[n % 3], amount: 40 }); // legacy object form
        } else if (n % 19 === 0) {
          details = 'not json';
        } else if (n % 23 === 0) {
          details = null;
          paidAt = null;
          paymentStatus = 'unpaid';
        } else {
          details = JSON.stringify([
            { method: methods[n % 3], amount: 40, timestamp: dbTimestamp(paid) },
          ]);
        }
        const bill = insertBill.run(
          `INV-PERF-${n}`,
          order.lastInsertRowid,
          paidAt ? 40 : 10,
          paidAt ? 0 : 30,
          paymentStatus,
          details,
          dbTimestamp(created),
          paidAt,
        );
        if (n % 29 === 0) insertRefund.run(bill.lastInsertRowid, 500, dbTimestamp(paid));
      }
    }
    // A bill opened 90 days ago, still unpaid, with a partial payment taken today.
    const oldCreated = new Date(nowMs - 90 * 86_400_000);
    const order = insertOrder.run(
      'ORD-PERF-OLD-OPEN',
      'dine_in',
      'served',
      dbTimestamp(oldCreated),
      dbTimestamp(oldCreated),
      null,
    );
    insertBill.run(
      'INV-PERF-OLD-OPEN',
      order.lastInsertRowid,
      12,
      28,
      'partial',
      JSON.stringify([
        { method: 'card', amount: 12, timestamp: dbTimestamp(new Date(nowMs - 60_000)) },
      ]),
      dbTimestamp(oldCreated),
      null,
    );
    // Paid today for a bill created 30 days ago, with an installment line from back then.
    const lateCreated = new Date(nowMs - 30 * 86_400_000);
    const lateOrder = insertOrder.run(
      'ORD-PERF-LATE-PAID',
      'takeaway',
      'completed',
      dbTimestamp(lateCreated),
      dbTimestamp(lateCreated),
      dbTimestamp(new Date(nowMs - 120_000)),
    );
    insertBill.run(
      'INV-PERF-LATE-PAID',
      lateOrder.lastInsertRowid,
      40,
      0,
      'paid',
      JSON.stringify([
        { method: 'cash', amount: 10, timestamp: dbTimestamp(lateCreated) },
        { method: 'stc_pay', amount: 30, timestamp: dbTimestamp(new Date(nowMs - 120_000)) },
      ]),
      dbTimestamp(lateCreated),
      dbTimestamp(new Date(nowMs - 120_000)),
    );
  })();
}

/** Closed shifts over 60 days plus today's open one, with the line shapes the app writes. */
function seedShifts(db: any) {
  const insertSession = db.prepare(
    `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by)
     VALUES ('perf-owner', 'Owner', ?, 5000, ?, ?, ?)`,
  );
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
    VALUES (?, 'perf-owner', 'takeaway', 'completed', 30, 30, ?, ?, ?)
  `);
  const insertBill = db.prepare(`
    INSERT INTO bills (bill_number, order_id, total, paid_amount, balance, payment_status, payment_details, created_at, paid_at)
    VALUES (?, ?, 30, ?, ?, ?, ?, ?, ?)
  `);
  const insertRefund = db.prepare(`
    INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at, cash_session_id)
    VALUES (?, 300, 'cash', 'perf-owner', 'perf-owner', ?, ?)
  `);
  const nowMs = Date.now();
  let n = 0;
  let previousPartial: { billId: number; lines: any[] } | null = null;
  db.transaction(() => {
    for (let day = 60; day >= 0; day--) {
      const open = new Date(nowMs - day * 86_400_000 - 8 * 3_600_000);
      const close = new Date(open.getTime() + 7 * 3_600_000);
      const isOpen = day === 0;
      const sessionId = Number(
        insertSession.run(
          dbTimestamp(open),
          isOpen ? 'open' : 'closed',
          isOpen ? null : dbTimestamp(close),
          isOpen ? null : 'perf-owner',
        ).lastInsertRowid,
      );
      // Yesterday's partial bill is settled in this shift.
      if (previousPartial) {
        const settled = new Date(open.getTime() + 20 * 60_000);
        const lines = [
          ...previousPartial.lines,
          {
            method: 'cash',
            amount: 18,
            timestamp: settled.toISOString(),
            cash_session_id: sessionId,
          },
        ];
        db.prepare(
          `UPDATE bills SET payment_details = ?, paid_amount = 30, balance = 0, payment_status = 'paid', paid_at = ? WHERE id = ?`,
        ).run(JSON.stringify(lines), dbTimestamp(settled), previousPartial.billId);
        previousPartial = null;
      }
      for (let k = 0; k < 10; k++) {
        n++;
        const created = new Date(open.getTime() + (k + 1) * 30 * 60_000);
        const paid = new Date(created.getTime() + 10 * 60_000);
        const order = insertOrder.run(
          `SHIFT-${n}`,
          dbTimestamp(created),
          dbTimestamp(created),
          dbTimestamp(paid),
        );
        let lines: any[];
        let paidAt: string | null = dbTimestamp(paid);
        let status = 'paid';
        if (k === 0) lines = [{ method: 'cash', amount: 30, timestamp: paid.toISOString() }];
        else if (k === 1) lines = [{ method: 'cash', amount: 30 }];
        else if (k === 2)
          lines = [
            {
              method: 'cash',
              amount: 10,
              timestamp: created.toISOString(),
              cash_session_id: sessionId,
            },
            {
              method: 'card',
              amount: 20,
              timestamp: paid.toISOString(),
              cash_session_id: sessionId,
            },
          ];
        else if (k === 3) {
          lines = [
            {
              method: 'cash',
              amount: 12,
              timestamp: paid.toISOString(),
              cash_session_id: sessionId,
            },
          ];
          paidAt = null;
          status = 'partial';
        } else
          lines = [
            {
              method: k % 2 ? 'cash' : 'card',
              amount: 30,
              timestamp: paid.toISOString(),
              cash_session_id: sessionId,
            },
          ];
        const billId = Number(
          insertBill.run(
            `SHIFT-B${n}`,
            order.lastInsertRowid,
            paidAt ? 30 : 12,
            paidAt ? 0 : 18,
            status,
            JSON.stringify(lines),
            dbTimestamp(created),
            paidAt,
          ).lastInsertRowid,
        );
        if (k === 3) previousPartial = { billId, lines };
        // A legacy blank paid_at must stay visible to the shift queries.
        if (k === 9 && day % 3 === 0)
          db.prepare(`UPDATE bills SET paid_at = '' WHERE id = ?`).run(billId);
        if (k === 5) insertRefund.run(billId, dbTimestamp(paid), day % 2 ? sessionId : null);
      }
    }
  })();
}

async function main() {
  console.log('FactorPOS dashboard performance fixes');
  console.log('='.repeat(50));
  try {
    initDatabase();
    const db = getDatabase();

    console.log('\n--- startup checks ---');
    const firstCheck = getSettingValue('factorpos_last_full_integrity_check_at');
    assert(
      typeof firstCheck === 'string' && Number.isFinite(Date.parse(firstCheck)),
      'a clean full integrity check is recorded on first start',
    );

    seed(db);

    closeDatabase();
    initDatabase();
    const secondCheck = getSettingValue('factorpos_last_full_integrity_check_at');
    assert(
      secondCheck === firstCheck,
      'a restart within the week runs quick_check, not the full check',
    );

    getDatabase()
      .prepare(`UPDATE settings SET value = ? WHERE key = 'factorpos_last_full_integrity_check_at'`)
      .run(new Date(Date.now() - 8 * 86_400_000).toISOString());
    closeDatabase();
    initDatabase();
    const thirdCheck = getSettingValue('factorpos_last_full_integrity_check_at');
    assert(
      thirdCheck !== null && Date.parse(thirdCheck) > Date.now() - 60_000,
      'the full integrity check runs again once the last one is over a week old',
    );

    const live = getDatabase();
    const stats = live
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`)
      .get() as { n: number };
    assert(stats.n === 1, 'PRAGMA optimize leaves sqlite_stat1 planner statistics');

    const report = runHealthCheck(live);
    assert(
      !report.findings.some((f: any) => String(f.index || '').includes('type_status_completed')),
      'schema health treats idx_orders_type_status_completed as expected',
    );

    console.log('\n--- payment method breakdown matches the previous query ---');
    const windows = [
      { startDate: localDate(0) },
      { startDate: localDate(-1) },
      { startDate: localDate(-30), endDate: localDate(-30) },
      { startDate: localDate(-90), endDate: localDate(0) },
      { startDate: localDate(-400), endDate: localDate(-200) },
    ];
    let combos = 0;
    let mismatches = 0;
    for (const window of windows) {
      for (let mask = 0; mask < 16; mask++) {
        const opts = {
          ...window,
          paidOnly: Boolean(mask & 1),
          excludeCancelledOrders: Boolean(mask & 2),
          attributeRefundsToBillDate: Boolean(mask & 4),
          keyByPaidAt: Boolean(mask & 8),
        };
        const expected = JSON.stringify(sortRows(previousBreakdown(live, opts)));
        const actual = JSON.stringify(sortRows(paymentMethodBreakdown(live, opts)));
        combos++;
        if (expected !== actual) {
          mismatches++;
          console.error(
            `    mismatch ${JSON.stringify(opts)}\n      old ${expected}\n      new ${actual}`,
          );
        }
      }
    }
    assert(mismatches === 0, `identical results for all ${combos} window/flag combinations`);
    const today = sortRows(paymentMethodBreakdown(live, { startDate: localDate(0) }));
    assert(today.length > 0, 'today has payment rows to compare (test data is not empty)');

    console.log('\n--- cash shift queries match the unfiltered query ---');
    seedShifts(live);
    // Every statement that reads bills through the shift lookback is re-run with the narrowed
    // bill source swapped back to the whole bills table (the v3.14.1-beta.1 query) and must
    // return the same rows.
    const shiftBlock =
      /\(\s*SELECT \* FROM bills\s+WHERE paid_at >= COALESCE\(datetime\(\?, '-7 days'\), ''\)\s+UNION ALL\s+SELECT \* FROM bills\s+WHERE paid_at IS NULL\s+UNION ALL\s+SELECT \* FROM bills\s+WHERE paid_at < '0'\s*\)/;
    const captured: { sql: string; params: unknown[]; rows: unknown }[] = [];
    const realPrepare2 = live.prepare.bind(live);
    live.prepare = (sql: string) => {
      const statement = realPrepare2(sql);
      if (!shiftBlock.test(sql)) return statement;
      const record =
        (method: 'get' | 'all') =>
        (...params: unknown[]) => {
          const rows = statement[method](...params);
          captured.push({ sql, params, rows: method === 'get' ? [rows] : rows });
          return rows;
        };
      return { get: record('get'), all: record('all') };
    };
    try {
      const sessions = live.prepare('SELECT * FROM cash_sessions ORDER BY id').all() as any[];
      for (const session of sessions) {
        const end = session.closed_at || now();
        cashClosures.sessionExpectedCash(live, session, end);
        cashClosures.computeSessionAggregates(live, session, end);
      }
    } finally {
      live.prepare = realPrepare2;
    }
    let shiftMismatches = 0;
    for (const entry of captured) {
      const match = entry.sql.match(shiftBlock)!;
      const before = entry.sql.slice(0, match.index).split('?').length - 1;
      const inBlock = match[0].split('?').length - 1;
      const oracleSql = entry.sql.replace(shiftBlock, 'bills');
      const oracleParams = entry.params.filter((_, i) => i < before || i >= before + inBlock);
      const oracleRows = live.prepare(oracleSql).all(...oracleParams);
      if (JSON.stringify(oracleRows) !== JSON.stringify(entry.rows)) {
        shiftMismatches++;
        console.error(
          `    mismatch\n      old ${JSON.stringify(oracleRows)}\n      new ${JSON.stringify(entry.rows)}`,
        );
      }
    }
    assert(captured.length >= 12, `captured ${captured.length} shift statements to compare`);
    assert(
      shiftMismatches === 0,
      'shift expected cash, totals and staff sales equal the unfiltered query',
    );
    const shiftPlans = captured.map((entry) =>
      (live.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.params) as { detail: string }[])
        .map((row) => row.detail)
        .join(' | '),
    );
    const badShiftPlan = shiftPlans.find(
      (plan) => !plan.includes('idx_bills_paid_at') || /SCAN bills( |$)/.test(plan),
    );
    if (badShiftPlan) console.error(`    plan: ${badShiftPlan}`);
    assert(!badShiftPlan, 'every shift statement looks bills up by paid_at, none scans bills');

    let drawerPlan = '';
    const realPrepare3 = live.prepare.bind(live);
    live.prepare = (sql: string) => {
      const statement = realPrepare3(sql);
      if (sql.includes('cash_named_custom_methods')) {
        return {
          get: (...params: unknown[]) => {
            drawerPlan = (
              realPrepare3(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
            )
              .map((row) => row.detail)
              .join(' | ');
            return statement.get(...params);
          },
        };
      }
      return statement;
    };
    try {
      cashClosures.computeDayAggregates(live, localDate(0));
    } finally {
      live.prepare = realPrepare3;
    }
    assert(
      drawerPlan.includes('idx_bills_paid_at') && !drawerPlan.includes('idx_bills_created_at'),
      `X/Z drawer cash looks bills up by paid_at (${drawerPlan})`,
    );

    console.log('\n--- query plans ---');
    const [start, end] = [
      dayBoundsInTimezone(localDate(0), tenantTimezone(), tenantBusinessDayStartTime(live))[0],
      dayBoundsInTimezone(localDate(0), tenantTimezone(), tenantBusinessDayStartTime(live))[1],
    ];
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const realPrepare = live.prepare.bind(live);
    live.prepare = (sql: string) => {
      const statement = realPrepare(sql);
      if (!sql.includes('window_bills')) return statement;
      capturedSql = sql;
      return {
        all: (...params: unknown[]) => {
          capturedParams = params;
          return statement.all(...params);
        },
      };
    };
    try {
      paymentMethodBreakdown(live, { startDate: localDate(0) });
    } finally {
      live.prepare = realPrepare;
    }
    assert(capturedSql !== '', 'captured the SQL paymentMethodBreakdown runs');
    const plan = (
      live.prepare(`EXPLAIN QUERY PLAN ${capturedSql}`).all(...capturedParams) as {
        detail: string;
      }[]
    )
      .map((row) => row.detail)
      .join(' | ');
    assert(
      !plan.includes('idx_bills_created_at'),
      `bill lookup avoids idx_bills_created_at (${plan})`,
    );
    assert(/paid_at/.test(plan), 'bill lookup searches by paid_at');
    assert(
      !/SCAN b( |$)/.test(plan),
      'no branch scans the whole bills table (refunds drive their join)',
    );

    const turnPlan = (
      live
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60), COUNT(*)
           FROM orders
           WHERE type = 'dine_in' AND status = 'completed' AND completed_at IS NOT NULL
             AND completed_at >= ? AND completed_at < ?`,
        )
        .all(start, end) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join(' | ');
    assert(
      turnPlan.includes('idx_orders_type_status_completed'),
      `table turn uses idx_orders_type_status_completed (${turnPlan})`,
    );
  } catch (error) {
    failed++;
    console.error('Unexpected error:', error);
  } finally {
    try {
      closeDatabase();
    } catch {
      /* ignore */
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();

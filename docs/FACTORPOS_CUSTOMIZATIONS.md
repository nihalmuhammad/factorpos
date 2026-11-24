# FactorPOS customization log

This file records the intentional differences from upstream FloCafe so future
upstream merges do not silently remove FactorPOS behavior.

## Upstream baseline

- Repository: `https://github.com/FreeOpenSourcePOS/FloCafe.git`
- Release: `3.14.0` (merged 2026-11-24; first fork point `3.9.0`)
- Local upstream remote: `upstream`
- Long-lived branch: `main`
- Source and release repository (public): `https://github.com/nihalmuhammad/factorpos`

The upstream MIT license and copyright notice remain in `LICENSE`.

## Product identity

- Product and executable name: FactorPOS
- Application ID: `com.factorpos.desktop`
- Local data namespace: `factorpos`
- Release artifact prefix: `factorpos-`
- Existing upstream icons are temporary until FactorPOS artwork is supplied.

FactorPOS intentionally uses its own application and data identifiers. This
allows FloCafe and FactorPOS to be installed on the same computer without
sharing the live database or settings.

## Saudi defaults

New installations default to:

- Country: Saudi Arabia (`SA`)
- Currency: Saudi riyal (`SAR`)
- Timezone: `Asia/Riyadh`
- Interface language: English
- Number digits: Western/Latin (`0-9`)

The Saudi country profile offers Arabic (`٠-٩`) and Latin (`0-9`) digit
preferences, with Latin selected by default. UI language, regional settings,
and tax behavior remain separate domains.

The shared source of truth for first-run defaults is
`shared/factorpos-defaults.ts`. Both the setup interface and backend setup API
consume it, and `tests/country-profile.test.ts` verifies Saudi currency,
numbers, and dates do not emit Arabic-Indic digits.

## Database migrations

FloCafe owns the numbered `MIGRATIONS` list and SQLite `user_version`.
FactorPOS schema changes go in `FACTORPOS_MIGRATIONS` in `main/db.ts`. They
are tracked by id in the `_factorpos_migrations` table, run after the
upstream list, and must be idempotent.

FactorPOS 3.9.0 to 3.9.1-beta.1 shipped its token column as numbered
migration 85, which is FloCafe's `add_inventory_movements`. On startup such a
database is backed up and moved back to v84, and the token migration is
recorded by id, so FloCafe's own 85 and later run after an upstream merge.
Covered by `npm run test:factorpos-migrations`.

## Long-history performance

Shops that bill for months slowed down because some queries read the whole
sales history on every dashboard load and at launch:

- `paymentMethodBreakdown` (dashboard daily stats, day summary, financial
  summary, Z report) splits its bill filter into "paid since the window start"
  and "still unpaid", so both halves are `paid_at` index lookups. Results are
  unchanged; the test compares them with the previous query.
- `idx_orders_type_status_completed` (FactorPOS migration
  `2026-11-24-orders-table-turn-index`) serves the dashboard's average table
  turn.
- Launch runs `PRAGMA quick_check`; the full `integrity_check` runs when the
  last clean one (setting `factorpos_last_full_integrity_check_at`) is more
  than seven days old.
- `PRAGMA optimize` runs at open (`0x10002`, `analysis_limit = 400`) and every
  six hours, so SQLite plans with real row statistics.
- Cash shifts (`main/routes/cash-closures.ts`): the X/Z drawer cash query uses
  the same exact paid_at split. Shift expected cash, shift totals and shift
  staff sales (the status bar polls the current shift every 15 seconds) read
  only bills that are unpaid or paid no earlier than seven days before the
  shift opened, instead of every bill ever made. A shift's lines are written
  while it is open or by a same-business-day tender correction, so older bills
  cannot hold them; only a PC clock that jumped back more than a week during a
  shift could break that.

The Orders page's Unpaid tab still scans history when few orders are unpaid.
Covered by `npm run test:factorpos-dashboard-performance`.

## Releases and updates

- Shop PCs update from this repository's GitHub Releases, built by
  `.github/workflows/factorpos-release.yml` on `v*` tags (stable `vX.Y.Z`,
  pilot `vX.Y.Z-beta.N`). Upstream's `release.yml` is left as is and listens
  only for tags starting with a digit.
- Installing an update first takes a database backup and cancels the install
  if the backup fails (`backupBeforeInstall` in `main/updater-shutdown.ts`).
- Steps and rollout: `docs/FACTORPOS_RELEASES.md`.

## Upstream merges

- `tests/factorpos-customizations.test.ts` pins every customization in this
  file and runs first in `npm test`. Add a check whenever you add a
  customization.
- `.github/workflows/factorpos-upstream-sync.yml` proposes FloCafe updates as
  a pull request (or an issue when the merge conflicts) when the owner runs it;
  it has no schedule. See
  `docs/FACTORPOS_UPSTREAM_UPDATES.md`.
- The language picker keeps `de, en, es, fa, fil, fr, pt, tr`; new FloCafe
  languages are merged with `selectable: false`.
- `.github/workflows/full-cross-platform-matrix.yml` (FloCafe renamed it from
  `nightly-release.yml`) is manual-only in FactorPOS.
- Customer day token: `generateTokenNumber()` in order creation
  (`main/routes/orders.ts`), reset by the day close (`main/routes/cash-closures.ts`),
  shown on the dashboard, order cards and the compact ORDER NOTE (thermal and browser).
- Bill formats (Settings → Printers → Bill Template) follow the setting on every print
  path. Compact is the FactorPOS token ORDER NOTE; Classic is FloCafe's bill. Earlier
  FactorPOS builds forced compact on browser printing, so the FactorPOS migration
  `2026-11-24-bill-template-compact-default` moves a core `classic` setting to
  `compact` once on shops that already have orders (a fresh install keeps FloCafe's
  default; pack and custom formats are left alone).
- Saudi Tax Invoice (core template `saudi`): a simplified tax invoice with seller name,
  VAT number, the Arabic and English title, invoice number and date, items, amount
  before VAT, VAT and total with VAT, and the ZATCA QR (TLV tags 1–5,
  `shared/print/zatca-qr.ts`). Thermal: `main/printers/document-saudi.ts` (native
  ESC/POS QR; Arabic labels print through raster mode or Arabic shaping, and are left
  out on text-only printers). Browser: `frontend/src/lib/printer/saudi-web-print.ts`,
  with the QR image from `GET /api/bills/:id/zatca-qr`. Direct-USB (WebUSB) printers
  use system print for this format. A bill with a signed ZATCA invoice prints that
  invoice's QR (tags 1–9) and issue time (`main/services/zatca/receipt.ts`), with a
  simulation banner while signing in simulation. A bill without one prints the
  "NOT A TAX INVOICE - PREVIEW" banner (`ZATCA_PREVIEW_ONLY`): shops already on ZATCA
  integration e-invoicing must keep issuing tax invoices from their compliant system
  until production. Only the Saudi renderers read the signed invoice; classic and
  compact bills are unchanged.
- ZATCA fiscal records (`main/services/zatca-fiscal.ts`, FactorPOS migration
  `2026-11-24-zatca-fiscal-records`): off unless `zatca_environment` is `simulation`.
  Hooks: `recordFiscalInvoiceIfPaid` in `main/routes/bills.ts` (four paid paths) and
  `recordRefundCreditNote` in `main/services/refund.ts`. Keep these hooks when merging
  FloCafe changes to payments, settlement, split recalculation or refunds.
- ZATCA engine (`main/services/zatca/`): invoice and credit note XML, hash, signature,
  XAdES and QR; signing happens inside `recordPaidBillInvoice` and
  `recordRefundCreditNote`. Depends on `@noble/curves` 1.9.7 because Electron's
  BoringSSL has no secp256k1 (pinned; 2.x is ESM-only). FactorPOS migration
  `2026-11-24-zatca-credentials` adds the till's signing credential table.
- ZATCA onboarding (`main/services/zatca/csr.ts`, `fatoora.ts`, `onboarding.ts`,
  routes in `main/routes/zatca.ts` mounted at `/api/zatca` in `main/routes/index.ts`):
  CSR built natively (byte-identical to the SDK's), OTP → compliance CSID, compliance
  checks of a sample invoice, credit note and debit note, production CSID. Keys and API
  secrets are encrypted with Electron safeStorage; FactorPOS migration
  `2026-11-24-zatca-onboarding` adds `zatca_onboarding` and the CSID columns on
  `zatca_credentials`. The settings card (`frontend/src/components/settings/ZatcaSettingsCard.tsx`)
  sits on the Tax tab for Saudi shops and carries its own English and Arabic text
  (`zatca-text.ts`) rather than adding keys to every FloCafe locale.
- ZATCA reporting (`main/services/zatca/reporting.ts`, `reporting-worker.ts`):
  `enqueueReport` runs inside `recordPaidBillInvoice` and `recordRefundCreditNote`; the
  worker starts after the local backup in `main/index.ts` and stops in the shutdown
  list. Review page `frontend/src/app/(dashboard)/zatca/page.tsx` (sidebar item
  `nav.zatca`, route permission `reports.view` in `AuthGuard.tsx`, Saudi shops only) and
  the deadline bar `ZatcaReportingAlert` in the dashboard layout.
- First-run setup preselects Saudi Arabia, SAR and Asia/Riyadh, and lists the selected
  country first (`frontend/src/lib/factorpos-setup.ts`); FloCafe pins India and Argentina
  to the top, which hid the Saudi tick and made India a one-click mistake. FloCafe 3.14 no
  longer has a default country; FactorPOS keeps the preselection, and the owner
  still sees and can change it.
- Email Error Log (Support): opens a local `.eml` draft with the recent log,
  sanitized by FloCafe's `sanitizeLogTail` before it is attached.
- Support-ticket subjects say FactorPOS (`frontend/src/lib/operation-failure.ts`).

## Still pending

- FactorPOS logo, icons, and final color palette
- Windows publisher identity and code-signing certificate (installers ship
  unsigned for now; see `docs/FACTORPOS_RELEASES.md`)
- Physical receipt/KOT printer verification on the pilot Windows PC

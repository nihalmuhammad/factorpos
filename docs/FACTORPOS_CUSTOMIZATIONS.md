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
  shown on the dashboard, order cards, the compact ORDER NOTE and browser receipts.
- First-run setup preselects Saudi Arabia, SAR and Asia/Riyadh. FloCafe 3.14 no
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

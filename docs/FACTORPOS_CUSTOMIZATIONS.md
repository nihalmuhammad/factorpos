# FactorPOS customization log

This file records the intentional differences from upstream FloCafe so future
upstream merges do not silently remove FactorPOS behavior.

## Upstream baseline

- Repository: `https://github.com/FreeOpenSourcePOS/FloCafe.git`
- Release: `3.9.0`
- Local upstream remote: `upstream`
- Long-lived branch: `main`
- Private source repository: `https://github.com/nihalmuhammad/factorpos`

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

## Still pending

- FactorPOS logo, icons, and final color palette
- Private source/release host and updater feed
- Windows publisher identity and code-signing certificate
- Physical receipt/KOT printer verification on the pilot Windows PC

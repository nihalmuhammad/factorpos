# FactorPOS ZATCA roadmap

Status: planning. FactorPOS does not issue ZATCA invoices yet. Do not use it
for live tax invoicing until the last phase below is signed off.

## Decisions

| Decision | Choice | Date |
| --- | --- | --- |
| Who signs and reports invoices | FactorPOS itself (our own EGS), no third-party provider | 2026-11-24 |
| Where the ZATCA code lives | Inside FactorPOS (main repo), switched off by default (`zatca_environment = disabled`) | 2026-11-24 |
| Front end | The existing FactorPOS / FloCafe POS screens | 2026-11-24 |
| Back end | ZATCA services in the FactorPOS main process: signing at sale time, a background reporting worker, and reports | proposed 2026-11-24 |
| FactorPOS database changes | Name-tracked `FACTORPOS_MIGRATIONS`; never upstream `user_version` numbers | 2026-11-24 |

### Why the back end runs inside FactorPOS on the shop PC

A simplified (B2C) invoice must be signed, given its QR code and handed to the
customer at the moment of sale, even when the internet is down. Only the
reporting step (sending the signed XML to FATOORA) can wait, and it must happen
within 24 hours. So signing has to be local and in the same database
transaction as the payment. The reporting worker runs in the same process and
retries in the background. A separate cloud back end would stop sales whenever
the shop lost internet.

## What ZATCA requires (checked 2026-11-24)

- Specifications: the XML Implementation Standard and Data Dictionary are still
  the versions dated 19 May 2023. ZATCA's specifications page was updated on
  12 Jan 2026, but no newer standard is listed.
- SDK: the official download page shows no version label (page updated
  28 May 2025). The earlier prototype validated against SDK 3.4.8. Download the
  current SDK again before signing work starts and record its version here.
- SDK rule changes that matter for a restaurant POS:
  - 3.4.0 (Mar 2025): BR-KSA-98 warns when a simplified invoice is reported
    more than 24 hours after it was issued. The reporting worker must report
    well inside 24 hours and show anything that is getting close.
  - 3.4.1 (Mar 2025): BR-KSA-EN16931-06, no charges on the net price.
  - 3.4.2 (Jun 2025): new exemption codes and BR-KSA-99 (warning for an empty
    buyer VAT number; relevant only to B2B).
  - 2024: QR code limit raised from 700 to 1,000 characters (BR-KSA-CL-14).
- Waves: wave 24 (turnover above SAR 375,000) had to integrate by
  30 June 2026. Wave 25 (above SAR 187,500 in any year 2022–2025) must
  integrate by 1 February 2027. Confirm which wave each shop's VAT number is in.
- Unchanged core rules: UBL 2.1 XML, invoice counter (ICV), previous invoice
  hash (PIH), ECDSA cryptographic stamp, 9-tag QR on the printed receipt,
  report B2C within 24 hours, never edit or delete an issued invoice (corrections
  use credit or debit notes).

Sources: ZATCA [e-invoice specifications](https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/E-Invoice-specifications.aspx),
[SDK download](https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx),
[EY on wave 25](https://taxnews.ey.com/news/2026-1705-saudi-arabia-announces-25th-wave-of-phase-2-e-invoicing-integration),
[ClearTax SDK change list](https://www.cleartax.com/sa/zatca-updates) (secondary).
Recheck the official pages before each phase; this is not tax advice.

## Phases

### 0. Foundations — done 2026-11-24
- FactorPOS-owned migrations moved to their own name-tracked list.
- Shop databases at FactorPOS v85 are moved back to v84 (with a backup) so
  FloCafe's own migration 85 and later still run.
- Earlier ZATCA fork history kept as local branch `archive/zatca-fork-3.9.0`.

### 1. Catch up with FloCafe (3.9.0 → 3.13.x)
- Merge upstream on an `update/flocafe-*` branch, following
  [FACTORPOS_UPSTREAM_UPDATES.md](FACTORPOS_UPSTREAM_UPDATES.md).
- Brings FloCafe's document-tax rounding fixes, delivery features and Excel
  (`exceljs`) report exports, which the ZATCA work builds on.
- Pilot test on one shop PC before the other shops.

### 2. Monthly VAT invoice report (Excel)
Can ship before signing exists, because it reads paid bills and refunds.
- Owner/manager screen: pick a month, download `.xlsx`.
- Sheet "Invoices": one row per invoice. Columns: invoice number, date and time
  (Asia/Riyadh), order number and token, payment method, amount before VAT,
  VAT 15%, total with VAT, discount. Later columns, once ZATCA is on: ICV, UUID,
  ZATCA status (reported / warning / rejected / pending), reported at.
- Sheet "Credit notes": one row per refund, with the original invoice number.
- Sheet "Summary": totals for the month, by day, by payment method; output VAT
  minus credit-note VAT.
- Money computed in halalas (integers), shown with 2 decimals. Arabic and
  English headers.
- Tests: rounding against bill totals, month boundaries in Asia/Riyadh,
  business day vs calendar day, refunds in a later month.

### 3. Fiscal records (port from the fork)
- Port the fiscal reservation, frozen snapshot and bill status commits as
  FactorPOS migrations.
- Fit the fork's driver-collection work around FloCafe's own delivery features
  rather than adding a second delivery model.

### 4. ZATCA engine (port from the prototype)
- Bill snapshot → UBL 2.1 simplified invoice XML; credit and debit notes.
- ICV/PIH chain, invoice hash, ECDSA stamp, 9-tag QR.
- Validate every document type with the current official SDK in CI.

### 5. Onboarding and keys
- Per terminal (EGS): CSR, OTP from the FATOORA portal, compliance CSID,
  compliance checks, production CSID, renewal before expiry.
- Private key protected on Windows (DPAPI/CNG); never in the repo, logs or
  backups in plain text.
- Settings screen showing onboarding state and certificate expiry.

### 6. Reporting worker
- Durable queue in SQLite; reports each invoice right after signing; retries
  with backoff when offline.
- Alerts before the 24-hour limit (BR-KSA-98); manager screen for warnings and
  rejections.

### 7. Receipt
- Bilingual Arabic/English simplified invoice with the QR code on the 80 mm
  printer. FloCafe's printer settings do not yet offer this.

### 8. Pilot
- Windows hardware tests, simulation environment at one shop, VAT adviser
  review, then production at one shop before the rest.

# FactorPOS — Project Plan

## 1. Goal

Create **FactorPOS**, a customized and maintainable version of FloCafe/FloPOS for four shops.

The application will be developed and tested from a Mac, installed on Windows shop computers, and updated through controlled releases. Core FloCafe behavior will remain intact unless a change is explicitly requested.

## 2. Confirmed requirements

- Product name: **FactorPOS**
- Initial deployment: **4 shops**
- Development computer: **macOS**
- Shop computers: **Windows**
- FactorPOS interface language: **English**
- Saudi Arabia country and currency settings: **SAR**
- Saudi displays must use Western/English digits: **0–9**
- Receipt-printer and kitchen-order-ticket (KOT) behavior: retain the current FloCafe implementation
- Centralized menu, inventory, pricing, and reporting: not required now
- Keep the latest FloCafe local/offline-first behavior
- The owner must be able to diagnose and fix bugs independently
- Further customizations will be added incrementally

## 3. Licensing and identity

FloCafe is distributed under the MIT License. FactorPOS may be modified and distributed privately, provided the required copyright and license notice is retained.

Before the first installer is produced:

- Replace the application name, icons, logos, colors, installer name, and executable identity.
- Use a unique application ID so FactorPOS does not conflict with an existing FloCafe installation.
- Preserve the upstream MIT license and third-party notices.
- Decide whether the FactorPOS source repository will be private or public. Private is recommended for shop-specific work.

## 4. Phase 1 — Establish a maintainable codebase

1. Fork or import the latest stable FloCafe source into a FactorPOS repository.
2. Add the original FloCafe repository as an `upstream` source.
3. Record the exact FloCafe release used as the starting point.
4. Confirm the project builds and runs on the Mac before making changes.
5. Run the existing automated tests and save a baseline result.
6. Use one main development line until production rollout makes separate
   development and production channels necessary.

### Branch approach

- `main`: the current FactorPOS development line
- Optional short-lived branches such as `fix/receipt-total` or
  `feature/english-digits`

Once FactorPOS is operating in production and production stability is
critical, add a separate development branch and promote tested revisions into
the protected production branch.

Every change should have a short description and, where practical, an automated test. Avoid editing production builds directly on shop computers.

## 5. Phase 2 — Branding and localization

### Branding

- Rename the visible product to **FactorPOS**.
- Replace FloCafe icons and visual branding after FactorPOS artwork is supplied.
- Rename installers and shortcuts.
- Update About, support, logs, backup, and user-data labels where appropriate.

### Languages

- Make English the default language for a new installation.
- Do not add or modify application languages for the FactorPOS customization.
- Preserve the upstream language system without expanding its selectable
  languages.

### Saudi digits

Use Western digits (`0–9`) throughout the Saudi/SAR configuration, including:

- Product prices and order totals
- Quantities and discounts
- Dates and times
- Receipt and KOT numbers
- Reports and dashboard figures
- Printed receipts and kitchen tickets
- Exported files where formatting applies

Currency and tax formatting should remain appropriate for Saudi Arabia. Saudi
digit display must use Western digits regardless of the Saudi locale.

Add tests covering SAR values, dates, order numbers, receipts, and KOT output
using Western digits.

## 6. Phase 3 — Windows build and installation

1. Configure an automated build service to create Windows installers from approved source revisions.
2. Build on a Windows build runner even though daily development happens on the Mac.
3. Use a unique Windows application ID, publisher identity, and data directory.
4. Obtain a Windows code-signing certificate before production rollout.
5. Produce a test installer and install it on a non-production Windows PC.
6. Verify upgrade and uninstall behavior without deleting shop data.

The database, backups, and settings must remain outside the installed program files so application updates do not overwrite operational data.

## 7. Phase 4 — Updates for shop PCs

Use signed, versioned releases, for example `1.0.0`, `1.0.1`, and `1.1.0`.

Recommended update policy:

1. Publish a release to a test channel.
2. Automatically create a database backup before applying it.
3. Test it on one designated pilot PC with real printer and KOT hardware.
4. After approval, promote the same release to the production channel.
5. Other shop PCs detect the production update and show an update prompt.
6. Install or restart outside trading hours.
7. Keep the previous installer and documented rollback instructions.

Updates must be cryptographically signed and downloaded over HTTPS. A failed download or update must not prevent the existing version from opening.

## 8. Phase 5 — Four-shop rollout

Create a per-shop deployment checklist containing:

- Shop name and device name
- Windows version and hardware details
- Receipt-printer model, connection type, driver, and paper width
- KOT printer model, connection type, routing, and paper width
- Cash drawer details, if connected
- Database and backup locations
- Update channel and installed version
- Responsible contact

Before going live at each shop, test:

- Dine-in, takeaway, and any enabled order flows
- Discounts, taxes, refunds, and payment methods
- Receipt printing and reprinting
- KOT printing and category routing
- Offline operation
- Staff permissions
- End-of-day reporting
- Backup and restore
- Update from the previous version

Roll out to one shop first. Observe normal operations before deploying the same approved version to the remaining three shops.

## 9. Bug-fixing workflow

To make independent maintenance realistic:

1. Provide a one-command Mac development startup.
2. Provide checks for formatting, linting, automated tests, and packaging.
3. Keep readable developer setup, architecture, troubleshooting, and release documentation in the repository.
4. Keep application logs easy to locate from the Help menu.
5. Record app version, Windows version, database schema version, and printer details in diagnostic reports.
6. Add a safe sample database for reproducing problems without exposing shop data.
7. Never test a database-changing fix on the only copy of live shop data.

### Standard fix process

1. Reproduce the problem using test data.
2. Create a short bug-fix branch.
3. Add or update a test that demonstrates the failure.
4. Implement and review the fix.
5. Run all checks and create a test build.
6. Test on the pilot Windows PC.
7. Publish a signed production update after approval.

## 10. Upstream FloCafe updates

FactorPOS should not automatically copy every FloCafe change into production.

For each upstream release:

1. Read its release notes and security changes.
2. Merge it into a separate update branch.
3. Resolve conflicts without removing FactorPOS branding or digit rules.
4. Run the full test suite.
5. Test database migration, receipts, KOT, English, and SAR formatting.
6. Release to the pilot PC before the other shops.

Maintain a small customization log so upstream merges remain understandable.

## 11. Data protection

- Keep sales and configuration data local, following FloCafe's current offline-first design.
- Make a verified backup before every application or database migration.
- Store at least one backup away from the POS PC.
- Encrypt cloud or removable-drive backups containing business or customer information.
- Document and rehearse database restoration.
- Do not place signing certificates, passwords, update credentials, or customer data in source control.

## 12. Deferred items

These are intentionally outside the first release unless requested later:

- Centralized menu management
- Cross-shop inventory synchronization
- Central sales dashboard
- Cloud administration
- Remote support access
- New payment integrations
- Major receipt or KOT redesign

## 13. Information still needed

- FactorPOS logo and preferred colors
- Windows versions used in the shops
- Number of POS computers per shop
- Receipt and KOT printer makes/models and connection types
- Whether updates should install automatically or require manager approval
- Preferred private source and release host
- Saudi tax/invoice requirements that must be supported and independently verified

## 14. First milestone

The first milestone is complete when:

- FactorPOS runs from source on the Mac.
- English is the FactorPOS default interface language.
- Saudi/SAR screens and print output use `0–9` digits.
- Existing receipt and KOT behavior passes regression tests.
- A signed or clearly marked test Windows installer is produced.
- The installer works on a pilot Windows PC.
- A safe upgrade preserves the database and settings.
- A documented test release can be delivered through the update channel.

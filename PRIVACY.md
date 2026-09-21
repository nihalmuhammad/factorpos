# FactorPOS Privacy Policy

**Effective date:** September 22, 2026

FactorPOS is an open-source, offline-first point-of-sale application. This
policy explains what information FactorPOS stores and when information may
leave the shop's computer.

## Who controls shop data

The business operating FactorPOS controls the personal and transaction data it
enters into the application. That business is responsible for deciding what
customer and staff information to collect, how long to keep it, who may access
it, and how to respond to privacy requests under applicable law.

The FactorPOS project maintainers do not automatically receive the shop's
orders, customer records, staff records, payment records, or local backups.

## Information stored locally

FactorPOS stores its operational data in a SQLite database on the shop's
computer. Depending on how the shop uses the application, this may include:

- business settings and product catalog information;
- orders, bills, payment methods, refunds, and cash movements;
- customer names, phone numbers, addresses, loyalty activity, and notes;
- staff names, roles, audit records, and securely hashed credentials;
- printer, kitchen-display, and device configuration; and
- application logs and local database backups.

Core ordering, billing, kitchen display, reporting, and printing work without a
cloud account. Removing FactorPOS does not necessarily remove its database or
backups. The shop operator should use the application's data and backup tools
and the operating system's storage controls to manage local data.

## Optional network features

FactorPOS sends information over the internet only for features that are
enabled, configured, or initiated by the shop operator.

### Anonymous telemetry

If telemetry is enabled, FactorPOS may send a randomized installation
identifier, application version, operating-system platform, event type,
user-confirmed country, and limited diagnostic values to the FactorPOS
telemetry service. The randomized identifier is not a customer or staff
account identifier. Telemetry can be disabled in the application settings.

### FactorPOS cloud features

If the shop connects a FactorPOS cloud account or enables cloud reporting or
synchronization, the application may send the configured store identifier,
account email, business profile, selected operational records, synchronization
status, and diagnostics needed to provide those features. Available cloud-data
controls, including deletion requests, are provided in the application
settings.

### Support requests and error logs

When a user submits a support request, FactorPOS sends the information entered
in the form together with selected application and device diagnostics. If the
user chooses to attach a log, recent application-log text may also be included;
logs can contain technical identifiers and error context. Users should review
support content before submitting it.

The **Email Error Log** action creates a draft in the computer's configured mail
application. FactorPOS does not send that draft automatically. The user decides
whether to send it.

### Google Drive backup

If the shop connects Google Drive and enables off-device backup, FactorPOS
uploads database backups to the connected Google account. A database backup
may contain the shop's operational, customer, and staff data. Google processes
that information under the account holder's agreement and privacy settings.

### WhatsApp

If WhatsApp features are enabled, FactorPOS connects to WhatsApp to deliver
messages or receipts selected by the user. Recipient phone numbers, message
content, and receipt information needed for delivery are processed through
WhatsApp. WhatsApp's own terms and privacy policy apply.

### Software updates and downloads

Packaged versions may contact the configured release provider to check for and
download updates. The provider may receive ordinary connection information,
such as an IP address and user agent, under its own privacy policy.

## Sharing and sale of information

The FactorPOS project does not sell shop, customer, or staff personal
information. Information is shared with external services only when necessary
for an optional feature selected by the shop operator, when the user explicitly
submits it, or when required by law.

## Retention and deletion

Local records remain on the shop's computer until the shop operator deletes
them, restores or replaces the database, or removes the relevant application
data. Copies may remain in local or Google Drive backups until those backups
are deleted.

Retention of information submitted to optional cloud, support, Google Drive,
WhatsApp, email, or release-provider services is governed by the applicable
service and account settings. FactorPOS cloud deletion controls are available
in the application when that service is configured.

## Security

FactorPOS uses role-based access controls, hashed credentials, audit records,
local database backups, and restricted handling of credential-shaped settings.
No system can guarantee absolute security. Shop operators should secure their
computers, operating-system accounts, networks, backups, email accounts, and
connected third-party accounts.

## Children's information

FactorPOS is business software and is not directed to children. A shop should
not use it to collect children's personal information unless the shop has a
lawful reason and provides any notices or consent required in its jurisdiction.

## Changes to this policy

Material changes will be published in this repository with an updated
effective date. The version distributed with a particular FactorPOS release
describes that release's behavior.

## Contact

Questions about the FactorPOS project's privacy practices may be sent to
[rasheedrestaurants@gmail.com](mailto:rasheedrestaurants@gmail.com). Questions
about records entered by a particular shop should be directed to that shop.

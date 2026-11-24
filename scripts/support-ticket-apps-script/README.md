# FactorPOS Submit Ticket receiver

Shop PCs send **Support → Submit Ticket** requests to this Google Apps Script
web app. Each new ticket:

- is emailed to the address in the `NOTIFY_EMAIL` script property (or, when it
  is not set, the Google account that deployed the script), with the
  diagnostics and, when the user attached it, the recent log;
- is added as a row on the **Tickets** tab of a Google Sheet (optional);
- has its log saved as a text file in a Drive folder (optional).

The POS keeps each ticket in its local queue until the script confirms it, and
retries with backoff while the PC is offline. A retry of a ticket that already
arrived gets the same support code back and sends no second email. FactorPOS
never sends tickets to FloCafe's cloud while this endpoint is configured.

## One-time setup

1. Sign in to the Google account that should send the emails (the messages
   come from this account; a consumer Gmail account can send 100 a day).
2. Go to <https://script.google.com>, create a project named
   "FactorPOS Support Tickets", and replace `Code.gs` with this folder's
   `Code.gs`. In **Project Settings**, tick "Show appsscript.json" and paste
   this folder's `appsscript.json`.
3. Make a long random secret, for example:

   ```bash
   openssl rand -hex 32
   ```

4. **Project Settings → Script properties**: add `TICKET_SECRET` with that
   value. Optionally add `SHEET_ID` (the ID in a Sheet's URL), `LOG_FOLDER_ID`
   (the ID in a Drive folder's URL) and `NOTIFY_EMAIL`.
5. **Deploy → New deployment → Web app**: execute as **Me**, access
   **Anyone**. Approve the permission prompts (Gmail send, Sheets, Drive).
   Copy the web app URL; it ends in `/exec`.
6. Open the URL in a browser. It should answer
   `{"ok":true,"service":"factorpos-support-ticket"}`.
7. In GitHub, **nihalmuhammad/factorpos → Settings → Secrets and variables →
   Actions**, add:
   - `FACTORPOS_SUPPORT_TICKET_URL`: the `/exec` URL;
   - `FACTORPOS_SUPPORT_TICKET_SECRET`: the same secret as `TICKET_SECRET`.

The FactorPOS release workflow refuses to build without both secrets, so no
release ships without ticket delivery.

## Updating the script

Edit the code, then **Deploy → Manage deployments → Edit → Version: New
version**. Editing the existing deployment keeps the same URL, so shop PCs need
no update.

## Testing one PC without a new build

An owner can point a single PC at a test deployment by setting the
`factorpos_support_ticket_url` and `factorpos_support_ticket_secret` settings
rows. These override the URL baked into the build. Only `https://script.google.com/macros/s/…/exec`
URLs are accepted.

## Rotating the secret

Change `TICKET_SECRET` in the script and the GitHub secret, then release. PCs
on older builds keep the old secret, and their tickets are refused (they stay
queued as failed) until they update. Rotate only when needed.

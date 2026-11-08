# FactorPOS releases and shop updates

Shop PCs update over the internet from this repository's GitHub Releases. The
in-app updater (electron-updater) checks for a new version shortly after the
app starts, from **Help → Check for Updates**, and from **Settings → About**.
It downloads the update in the background and shows "Version X is ready to
install". Nothing installs until someone chooses **Install Windows POS
Update → Restart Now** and enters the Master PIN, so updates can wait until
the shop is closed.

## What happens when an update is installed

1. The Master PIN is checked.
2. FactorPOS takes a database backup (`flo-backup-*.db` in the app's backups
   folder, listed under **Settings → Database tools**). If the backup fails,
   the update is **not** installed and the current version keeps running.
3. The app shuts down cleanly, the installer runs, and the new version
   starts. If the database schema changes, the new version also takes its own
   pre-migration backup before migrating.

The database, backups and settings live in the user's AppData folder, outside
the program files, so installing an update never replaces them.

## Channels

| Version in `package.json` | Git tag | Who gets it |
|---|---|---|
| `X.Y.Z` | `vX.Y.Z` | Every shop PC (stable channel) |
| `X.Y.Z-beta.N` | `vX.Y.Z-beta.N` | Only PCs with **Settings → About → Beta updates** switched on (the pilot PC) |

Other prerelease names (for example `-dev.N` from the Windows Test Installer
workflow) are never offered as updates; PCs running them follow the stable
channel.

## Making a release

Run the tests locally first (`npm run lint`, `npm test`). Then, on an
up-to-date `main`:

```sh
npm version 3.9.1-beta.1 --no-git-tag-version   # or 3.9.1 for all shops
git commit -am "chore(release): 3.9.1-beta.1"
git tag v3.9.1-beta.1
git push origin main v3.9.1-beta.1
```

The tag starts the **FactorPOS Release** workflow
(`.github/workflows/factorpos-release.yml`). It:

1. checks that the tag matches `package.json`;
2. runs lint and the full test suite on Linux;
3. builds the unsigned Windows installer, checks the update file
   (`latest.yml` or `beta.yml`) and its SHA-512 checksum, installs the build
   on a Windows runner and waits for the app to report healthy;
4. publishes a GitHub Release with the installer, blockmap, update file and
   `SHA256SUMS.txt`.

If any step fails, nothing is published. A release that already exists is
never overwritten: bump the version and tag again.

Tags must start with `v`. Upstream FloCafe's `release.yml` listens for tags
that start with a digit and builds platforms FactorPOS doesn't ship.

### Recommended rollout

1. Tag a beta (`v3.9.1-beta.1`). The pilot PC, with the beta channel on,
   updates. Test orders, receipts, KOT, the cash drawer and end of day there.
2. If it's good, tag the stable version (`v3.9.1`). The other shop PCs offer
   the update; install it outside trading hours.
3. Keep the previous release on GitHub. To roll back a shop, download that
   release's installer and run it over the current version (see below).

The stable build is a fresh build of the same commit, not the exact beta
binary.

## Installing or reinstalling by hand

From the release page, download `factorpos-<version>-win-x64.exe` and run it.
Installers are **unsigned** for now, so Windows SmartScreen shows
"Windows protected your PC": choose **More info → Run anyway**. The
`SHA256SUMS.txt` file lists the expected checksum
(`Get-FileHash .\factorpos-<version>-win-x64.exe` in PowerShell).

Updates installed by the app don't go through SmartScreen. The updater checks
each download against the SHA-512 in `latest.yml` over HTTPS.

## Checking a shop PC

- Version: **Help → About**.
- Updater config: `%LOCALAPPDATA%\Programs\FactorPOS\resources\app-update.yml`
  should name `owner: nihalmuhammad` and `repo: factorpos`.
- Update log: **Help → Open Logs Folder**, then search for `[Update]`.

## Not done yet

- Windows code signing (owner decision 2026-11-09: unsigned for now).
- A promotion step that ships the exact beta binary as stable.

# Taking FloCafe updates into FactorPOS

FactorPOS is a fork of FloCafe (`upstream`). New FloCafe features and fixes
are merged into FactorPOS only after the owner reviews them, and FactorPOS
customizations must survive every merge.

## How customizations are protected

`tests/factorpos-customizations.test.ts` (`npm run test:factorpos-customizations`,
the first step of `npm test`) fails if a merge undoes a FactorPOS
customization:

- product name, app ID, data folder, installer names and visible branding;
- the update feed (`nihalmuhammad/factorpos`), the `v*` release workflow and
  the backup taken before an update installs;
- Saudi defaults: English UI, SAR, Asia/Riyadh, digits 0–9;
- the language picker list (new FloCafe languages may be added with
  `selectable: false`);
- the compact "ORDER NOTE" receipt with the day token;
- the FactorPOS regression suites staying in `npm test`;
- the cross-platform matrix workflow staying manual-only.

When you add a customization, add a check for it there and a line in
`docs/FACTORPOS_CUSTOMIZATIONS.md`.

## Review pull request (on demand)

`.github/workflows/factorpos-upstream-sync.yml` runs only when you start it:
**Actions → FactorPOS Upstream Sync → Run workflow** (there is no schedule).
It merges FloCafe `main` into a branch `upstream-sync/<sha>` and:

- **If the merge is clean**, it runs the customization check, lint, build and
  the full test suite, then opens a pull request "FloCafe update … for
  review" with the results, a review checklist, the changed files and the
  FloCafe commits.
- **If the merge has conflicts**, it pushes nothing and opens an issue
  "FloCafe … needs a manual merge" listing the conflicting files. Follow
  "When the merge has conflicts" below.

Nothing reaches `main` or the shops until you merge the pull request and tag
a release (`docs/FACTORPOS_RELEASES.md`), beta to the pilot PC first.

One-time repository setting: **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**.

### Reviewing the pull request

1. Both checks in the PR description must show ✅. A ❌ means the branch needs
   fixing before it can be merged (see below).
2. Read the FloCafe commit list. Look closely at anything touching receipts,
   KOT, payments, tax, `main/db.ts` migrations, the updater, cloud or
   telemetry endpoints.
3. If you want to try it before merging, check out the branch and run it:
   `git fetch origin && git switch upstream-sync/<sha> && npm ci && npm --prefix frontend ci && npm run dev`.
4. Merge the pull request with a **merge commit** (not squash or rebase), so
   the next FloCafe merge only brings newer commits.

## When the merge has conflicts

Do it on a branch, never on `main`:

```sh
git switch main && git pull --ff-only origin main
git fetch upstream
git switch -c update/flocafe-$(git rev-parse --short=8 upstream/main)
git merge --no-ff upstream/main
git diff --name-only --diff-filter=U      # files to resolve
```

How to resolve the usual conflicts:

| Area | Keep |
|---|---|
| `package.json` | FloCafe's dependencies and scripts; FactorPOS `name`, `productName`, `build.appId`, `build.publish`, artifact names and the `test:factorpos-customizations` step at the start of `test`. Version: see below. |
| `package-lock.json` | Don't edit by hand: take FloCafe's, then run `npm install` to regenerate it. |
| `frontend/src/lib/i18n/messages/*.json` | FloCafe's new keys; FactorPOS's branded strings (FactorPOS, not FloCafe/FloPOS). |
| `frontend/src/lib/i18n/languages.ts` | FloCafe's new language entries, with `selectable: false`. |
| `main/index.ts`, `main/updater-shutdown.ts` | FloCafe's changes plus the FactorPOS app name, data folder and `backupBeforeInstall`. |
| `main/printers/document-compact.ts`, `shared/print/document.ts` | The FactorPOS order-note layout and token; take FloCafe's fixes around them. |
| `main/routes/settings.ts`, `main/routes/auth.ts`, `main/countries.ts` | Saudi defaults and Western digits. |
| `AGENTS.md`, `CLAUDE.md`, `frontend/AGENTS.md` | Keep them deleted (local files, not tracked in FactorPOS): `git rm` them. |
| `.github/workflows/nightly-release.yml` | The FactorPOS manual-only trigger. |

Then:

```sh
npm install && npm --prefix frontend install   # refresh lockfiles if they changed
npm run test:factorpos-customizations
npm run lint && npm test
git commit                                      # completes the merge
git push origin update/flocafe-<sha>
```

Open a pull request from that branch and review it as above. If a FloCafe
change can't coexist with a FactorPOS customization, decide which one wins and
record the decision in `docs/FACTORPOS_CUSTOMIZATIONS.md`.

## Version numbers

The shops only install a version higher than the one they run. After merging
FloCafe, set `package.json` to the higher of FloCafe's version and the last
FactorPOS release, then bump it when you tag the next release (for example
FloCafe 3.13.23 merged → release `v3.13.24-beta.1`, then `v3.13.24`). If
FloCafe later publishes the same number, use the next one.

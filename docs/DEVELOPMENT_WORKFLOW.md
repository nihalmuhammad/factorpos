# FactorPOS development workflow

FactorPOS uses Git branches to keep daily development separate from software
approved for shop computers.

## Long-lived branches

- `main` is production. Only shop-approved, tested releases belong here.
- `develop` is integration. Completed features and fixes are combined and
  tested here before promotion to production.

Both branches are published to the private GitHub repository. The original
FloCafe repository remains configured as the read-only conceptual upstream
source under the `upstream` remote.

Every push to `develop` runs CI and creates an unsigned Windows development
installer artifact. Its version includes `-dev.<run number>`, its GitHub
artifact name includes the exact commit SHA, and it expires after 14 days. It
is for pilot testing only and is never published as a production release.

## Working branches

Start each change from the latest `develop` branch:

```sh
git switch develop
git pull --ff-only origin develop
git switch -c feature/short-description
```

Use `fix/short-description` for bug fixes. Keep these branches short-lived and
merge them into `develop` through a pull request after verification.

## Production promotion

1. Verify `develop` with linting, builds, automated tests, and pilot hardware.
2. Open a pull request from `develop` into `main`.
3. Review the exact diff and confirm database backup and rollback steps.
4. Merge the approved commit without rebuilding or rewriting it.
5. Tag the merge commit with a semantic version such as `v1.0.0`.
6. Build the Windows installer from that tag and publish it as a GitHub release.

Production publishing is deliberately blocked until the Windows publisher
identity and code-signing certificate are configured in GitHub Actions.

Never develop directly on `main`, edit installed shop files, or force-push a
long-lived branch. Urgent production fixes start from `main` on a `fix/*`
branch and are merged back into both `main` and `develop`.

## Upstream updates

Fetch FloCafe updates without mixing them directly into production:

```sh
git fetch upstream
git switch -c update/flocafe-version develop
```

Merge or cherry-pick the reviewed upstream release on that update branch, run
the full regression suite, then merge it into `develop`. FactorPOS branding,
Saudi digit rules, printing behavior, and data-directory isolation must be
verified before any later production promotion.

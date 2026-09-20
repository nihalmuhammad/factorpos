# FactorPOS development workflow

FactorPOS currently uses a single long-lived Git branch while the product is
being built and has not yet entered production.

## Current branch model

- `main` is the only long-lived branch and contains the latest FactorPOS work.
- Short-lived `feature/*` and `fix/*` branches may still be used for isolated
  changes, then merged back into `main` after verification.

The original FloCafe repository remains configured as the read-only upstream
source under the `upstream` remote.

Every push to `main` runs CI and creates an unsigned Windows test installer
artifact. Its version includes `-dev.<run number>`, its GitHub
artifact name includes the exact commit SHA, and it expires after 14 days. It
is for development and pilot testing only and is never automatically published
as a production release.

## Working branches

Start each change from the latest `main` branch:

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/short-description
```

Use `fix/short-description` for bug fixes. Keep these branches short-lived and
merge them into `main` after verification. Direct commits to `main` are also
acceptable during this pre-production stage when the change has been tested.

## Future production separation

Once FactorPOS is running in shops and production stability becomes critical,
introduce a separate development branch and protected promotion process. At
that point, verify development revisions with CI and pilot hardware, promote an
approved revision to production, tag it with a semantic version such as
`v1.0.0`, and publish a signed installer from that exact revision.

Production publishing is deliberately blocked until the Windows publisher
identity and code-signing certificate are configured in GitHub Actions.

Never edit installed shop files or force-push `main`. Once production exists,
production fixes should use a short-lived `fix/*` branch and the protected
release process established at that time.

## Upstream updates

Fetch FloCafe updates without mixing them directly into production:

```sh
git fetch upstream
git switch -c update/flocafe-version main
```

Merge or cherry-pick the reviewed upstream release on that update branch, run
the full regression suite, then merge it into `main`. FactorPOS branding,
Saudi digit rules, printing behavior, and data-directory isolation must be
verified before accepting the update.

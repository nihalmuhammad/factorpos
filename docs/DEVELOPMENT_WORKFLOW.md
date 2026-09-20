# FactorPOS development workflow

FactorPOS currently uses a single long-lived Git branch while the product is
being built and has not yet entered production.

## Current branch model

- `main` is the only long-lived branch and contains the latest FactorPOS work.
- Short-lived `feature/*` and `fix/*` branches may still be used for isolated
  changes, then merged back into `main` after verification.

The original FloCafe repository remains configured as the read-only upstream
source under the `upstream` remote.

During active development, routine pushes should run only the Linux validation
needed for fast feedback. Windows installers and the full Linux, Windows, and
macOS matrix are release artifacts and must be manual or scheduled jobs rather
than running on every push. Development installers are for pilot testing only
and are never automatically published as production releases.

## GitHub Actions usage policy

FactorPOS is a private repository, so GitHub-hosted runner time consumes the
repository owner's monthly Actions allowance. Windows runners cost more than
Linux runners, and macOS runners are substantially more expensive. A previous
configuration ran Linux CI, a Windows installer, and a four-platform build
matrix on every push to `main`; a sequence of small pushes therefore exhausted
the monthly allowance.

Until production requires a stricter promotion pipeline, use this policy:

- Run routine lint, build, and test validation locally before pushing.
- Batch related verified commits into one push instead of pushing after each
  small fix.
- Keep automatic `main` validation Linux-only and path-filtered.
- Run unsigned Windows installers only on explicit manual request or when a
  pilot build is needed.
- Run Windows and macOS release matrices only manually for release candidates.
- If a scheduled nightly workflow is retained, it must not also run on every
  push to `main`.
- Configure GitHub Actions usage alerts and a spending limit so unexpected
  runner usage cannot silently create charges.

Before changing workflow triggers, estimate how many jobs one push creates and
check whether any Windows or macOS runner is included. Prefer one final,
verified workflow change over repeated trial pushes because failed and
cancelled jobs still consume the time already used.

## Working branches

Start each change from the latest `main` branch:

```sh
git switch main
git pull --ff-only origin main
git switch -c feature/short-description
```

Use `fix/short-description` for bug fixes. Keep these branches short-lived and
merge them into `main` after verification. Direct commits to `main` are also
acceptable during this pre-production stage when the change has been tested;
however, related commits should be pushed together to avoid duplicate CI runs.

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

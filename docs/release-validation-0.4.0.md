# TerraField Atlas 0.4.0 — release validation (2026-11-27)

Scope: security and identity hardening plus a reproducible host deployment. Production: https://terrafieldatlas.us, VPS `57.130.80.158`, release `/mnt/terrafield/releases/20261125T160302Z`.

## Local gates

- `bun run typecheck`: pass.
- `bun run lint`: 0 errors, 0 warnings (24 warnings removed; underscore-prefixed unused bindings are now an explicit convention in `eslint.config.mjs`).
- `bun run test` with disposable PostgreSQL/Redis: 316 pass, 0 fail, 1,647 assertions across 39 files. New coverage: CSP headers/reports, password reset (request, single-use, expiry, weak password, origin), tenant-attributed private provenance, deployment artifacts.
- `bun run build`: pass on Next.js 16.4.6 with middleware; standalone assets copied.
- `bun audit --audit-level=high`: 0 vulnerabilities across 794 packages.

## Deployment

`scripts/deploy-vps.sh` was exercised three times against production:

1. First attempt exposed a stale SQLite-era migration directory left on the host (tar extraction did not remove deleted files) and a failed `_prisma_migrations` row. The stale directory and failed row were removed; the script now clears `prisma/migrations` before extraction.
2. Second attempt exposed Turbopack resolving PostCSS relative to the block-volume build directory. The script now builds in the application tree and publishes the finished `.next` to an immutable `/mnt/terrafield/releases/<stamp>` before switching the symlink.
3. Final run: backup → install → Prisma generate → build → migrate → publish → restart → readiness gate passed; `/api/v1/readyz` reports ready.

## Live verification

- `GET /api/v1/healthz`: `status=ok`, new pid, uptime reset by the release restart.
- `GET /api/v1/readyz`: database, schema, seed baseline, Redis, scheduler leadership all `ok`.
- Response headers include `Content-Security-Policy-Report-Only` with a per-request nonce, `X-Frame-Options: DENY`, HSTS preload.
- `POST /api/v1/csp-report`: 204 for a valid report.
- `POST /api/v1/account/password-reset/request` with the canonical origin: 202 (generic, non-enumerating); with a foreign origin: 403.
- `/account` renders the "Forgot password?" entry point.
- `PasswordReset` table present in production PostgreSQL; running release `.next` symlink points at the new stamp; `package.json` version 0.4.0.

## Remaining

- Account deletion is still operator-assisted.
- CSP stays report-only until the violation log is reviewed; enforcement is a one-line header rename after that.
- GitHub Actions workflows remain unusable while the repository account is billing-locked. Promotion and deployment ran locally: `main`, `dev` and `staging` point at the same commit and the VPS runs the built artifact.
- GitHub's Dependabot page reports 7 advisories (3 high, 1 moderate, 3 low) on the default branch while `bun audit` reports none; the two advisory databases disagree. Review the Dependabot entries before the next dependency change.

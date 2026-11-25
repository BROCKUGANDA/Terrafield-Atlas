# TerraField Atlas 0.4.0 — release notes (2026-11-27)

## Security

- **CSP report-only rollout.** Every document response now carries a nonce-based `Content-Security-Policy-Report-Only` policy; Next stamps its inline flight scripts with the per-request nonce. `POST /api/v1/csp-report` accepts browser violation reports, bounds them at 8 KiB, keeps only policy-relevant fields and writes a structured log line. Enforcement remains off until the report ledger is clean. (SEC-003)
- **Tenant-bound provider provenance.** Private provider calls now carry the organization id; organization-attributed calls write metadata-only provenance rows with no URL, query hash, coordinates or raw provider error. Anonymous private calls remain unlogged. (SEC-002)
- **Self-service password reset.** Single-use, hashed, one-hour tokens; unknown and unverified addresses receive the same 202 response; requesting a new link invalidates the previous one; a successful reset consumes every outstanding reset and verification token for the account.

## Deployment

- Removed the stale SQLite `DATABASE_URL` override from the production systemd unit; the runtime database now comes only from the 600-mode `.env`.
- Added the production `terrafield.service` unit to the repository.
- Added `scripts/deploy-vps.sh`: source ship → checksummed `pg_dump` → `bun install --frozen-lockfile` → Prisma generate/migrate → production build → service restart → readiness gate with automatic restore of the previous build on failure.

## Quality

- ESLint: 0 errors, 0 warnings (underscore-prefixed unused bindings are now a documented convention).
- Typecheck clean; new tests cover CSP, password reset, tenant provenance and the deployment artifacts.

## Known limitations

- Account deletion remains operator-assisted.
- CSP enforcement is a follow-up once violation reports are reviewed.
- GitHub Actions remains unavailable while the repository account is billing-locked; deploys run through `scripts/deploy-vps.sh`.

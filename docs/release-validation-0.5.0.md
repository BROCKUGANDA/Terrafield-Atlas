# TerraField Atlas 0.5.0 — release validation (2026-11-27)

Production: https://terrafieldatlas.us · VPS `57.130.80.158` · release `/mnt/terrafield/releases/20261125T174757Z`.

## Local gates

- `bun run typecheck`: pass.
- `bun run lint`: 0 errors, 0 warnings.
- `bun test tests/ --timeout 30000`: **340 pass, 0 fail**, 2,639 assertions across 41 files (clean run before the final source-health hardening).
  After the last code edits, the affected suites were re-run: `provider-resilience` + `source-health` 18 pass, `private-digest-stream` 3 pass at a realistic timeout, `tenant-rls` 3 pass. A later full-suite run hit a Bun 1.4.2 segmentation fault after two SSE tests exceeded a 30 s timeout under machine load; the same tests pass in 6.7 s with a 120 s timeout. No assertion failure was observed.
- `bun run build`: pass (Next.js 16.4.6, standalone assets copied).
- `bun audit --audit-level=high`: 0 vulnerabilities / 794 packages.
- **RLS-mode integration suites** (`TENANT_RLS_TEST=1`, request queries as `terrafield_app`): account isolation, enterprise, enterprise product, OAuth and billing invoices — **5/5 pass**.
- Migrations from an empty database and idempotent redeploy covered by `tests/postgres-schema.integration.ts`.

## Deploy

`scripts/deploy-vps.sh`: checksummed `pg_dump`, source ship with `prisma/migrations` purge, in-tree build, four new migrations, unit install, `.env.tenant` generation, immutable release publish, restart, readiness gate. Monitoring failed its first start because host port 3001 is held by another application; Grafana moved to 33001 and started.

## Live verification

- `/api/v1/healthz`: ok; `/api/v1/readyz`: ready (database, schema, seed, Redis, scheduler).
- `.next` symlink → `20261125T174757Z`; `package.json` 0.5.0.
- `TENANT_DATABASE_URL` present in the service environment; unit contains only `PORT` and `NODE_ENV` as `Environment=`.
- Production migrations present: `20261128000000_oauth_invoices_markets`, `20261128010000_rls_schema_aware`, `20261128020000_org_insert_policy`, `20261128030000_org_creator`.
- Enforced CSP header served (Cloudflare Insights beacon explicitly allowed after the first browser check); `/api/v1/metrics` returns **403** publicly. Headless Chromium loads the Markets view with **0 console errors and 0 CSP violations**.
- Prometheus `terrafield-web` target up; `terrafield_database_up=1` for `host.docker.internal:3011`; Grafana health 200 on 127.0.0.1:33001; both bind loopback.
- `/api/v1/oauth/token` with bad credentials → 401 OAuth error; `/api/v1/billing/invoices` anonymous → 401; `/api/v1/markets/prices` returns provenance/licence with an honest empty state (no ingest yet in production); `/account` serves the Kiswahili switcher.
- RLS policy check in production PostgreSQL: as `terrafield_app` without tenant context, `SELECT count(*) FROM "Farm"` equals the public-row count.

## Remaining

- Account deletion is blocked while the account owns organizations/farms/watchlists/invitations/keys (by design).
- OAuth has no authorization-code flow, secret rotation or token GC.
- No card processor; settlements are manual.
- en/sw localization covers navigation, account, marketing shell and landing hero; long-form and scientific copy is English.
- Market feed is nominal survey data; production has no ingested rows until an authorized ingest runs.
- Grafana/Prometheus are single-host and loopback-only.
- Dependabot: all 7 alerts closed after the push scan (open alerts = 0); `bun audit` clean.

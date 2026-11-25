# TerraField Atlas 0.5.0 — release notes (2026-11-27)

## Production security

- **RLS is enforced for tenant requests.** The web process keeps an owner
  connection for auth, jobs and migrations and gains a second
  `TENANT_DATABASE_URL` derived from `.env` with `role=terrafield_app`. Every
  request that resolves a tenant context (including anonymous public reads)
  runs through that role with transaction-local `app.user_id`,
  `app.organization_id` and `app.schema`.
- Policies were completed for onboarding and bootstrap flows:
  organization INSERT + creator visibility (INSERT … RETURNING needs SELECT),
  schema-aware helper functions, member directory reads, OAuth tokens, invoices
  and payments. Invitation acceptance and API-key revocation perform their
  bootstrap lookup on the owner connection after explicit token/permission
  checks.
- The public metrics endpoint was reachable through the edge and now returns
  403 at Caddy; Prometheus scrapes the process directly.
- **CSP is enforced.** `script-src` keeps `'unsafe-inline'` because static App
  Router pages cannot carry a per-request nonce; external origins, objects,
  base-uri, framing, workers and form targets are locked down, and violations
  still report to `/api/v1/csp-report`.

## Observability

- Host Prometheus and Grafana (`deploy/host-monitoring`) run on loopback,
  scrape `/api/v1/metrics` on the systemd app, provision the existing
  TerraField dashboard and load `deploy/alert-rules.yml`. The deploy script
  starts them after a successful readiness gate.

## Identity and commercial platform

- Self-service account deletion with password + `DELETE` confirmation, an
  audit event, and explicit blockers (owned farms, organizations, watchlists,
  invitations, or keys created for another owner).
- OAuth 2.0 client-credentials for the developer API: hashed client secrets and
  access tokens, one-hour expiry, scope narrowing, organization-scoped client
  management, revocation, and OAuth entries in the OpenAPI document. API-key
  authentication is unchanged.
- Invoice and manual settlement: per-period invoice issuance, amount-exact
  settlement with a durable Payment row, subscription activation/extension,
  voiding, and honest copy that no card processor is connected.

## Agriculture and markets

- Uganda market-price intelligence from the WFP/FIT Uganda HDX dataset: CSV
  download with redirect validation, natural-key upsert, monthly
  median/min/max aggregation, provenance and coverage, ingestion ledger, and a
  console workspace. Nominal survey observations only; no forecasts or profit
  claims.

## Localization

- Locale infrastructure with English and Swahili dictionaries, cookie + query
  resolution, `Intl` date/number formatting, a locale switcher, and localized
  navigation labels, account page, marketing shell and landing hero. Product,
  scientific and provider copy remains English by design and is listed as such.

## Dependencies

- `python-multipart` 0.0.20 → 0.0.34 in the raster service, closing all seven
  Dependabot advisories (3 high, 1 moderate, 3 low).

## Verification (see docs/release-validation-0.5.0.md)

Full unit suite, five integration suites under real RLS (`TENANT_RLS_TEST=1`),
production build, dependency audit, deploy and live checks.

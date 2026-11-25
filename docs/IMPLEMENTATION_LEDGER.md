# TerraField Atlas — Implementation Ledger

Last updated: 2026-11-27

Status vocabulary: `verified`, `implemented`, `partial`, `planned`, `blocked`, `broken`, `deprecated`.

| Feature | Owner | Status | Dependencies | Test evidence | Deployment | Outstanding defects / next action |
| --- | --- | --- | --- | --- | --- | --- |
| Public mission console | Platform | verified | Next.js, tokens | Prior browser matrix; current lint/type baseline | Existing preview/production | Refresh production-scale docs |
| Verified accounts | Identity | verified | PostgreSQL, NextAuth | `tests/account-isolation.test.ts` | Existing production | Account deletion absent |
| Durable job client/worker | Platform | implemented | Redis/BullMQ | `tests/jobs.integration.ts`, focused suites | Not deployed this pass | External worker deployment config |
| POWER ingestion | Earth data | implemented | Durable worker | Provider/workflow integration tests | Not deployed this pass | Run live smoke after deployment |
| Trend analysis | Science | implemented | Stored POWER, worker | `tests/stats.test.ts`, jobs integration | Not deployed this pass | Full browser job flow pending |
| Fire ingestion/evaluation | Sentinel | implemented | GIBS, worker | `tests/private-fires.test.ts` | Not deployed this pass | Production-scale Task 7–11 acceptance |
| Organizations/RBAC | Identity | implemented | Enterprise migration, tenant context | `tests/enterprise.integration.ts` | Not deployed | Database RLS still blocked |
| Invitations/members/workspaces | Enterprise | implemented | Organizations, email | Enterprise integration + UI | Not deployed | Live email provider acceptance pending |
| Shared farm portfolio | Enterprise | implemented | Tenancy guards | Cross-tenant/role integration tests | Not deployed | Portfolio aggregate endpoint can be deepened |
| Plans/entitlements/usage | Commercial | implemented | Organizations, jobs | Enterprise quota tests; job metering code | Not deployed | Payment provider intentionally absent |
| API keys/developer API | Developer platform | implemented | Tenancy, quotas | Scope/revocation integration tests | Not deployed | OAuth not implemented; bearer keys only |
| General webhooks | Integrations | implemented | Outbox, encryption key | Signed delivery integration test | Not deployed | Configure `WEBHOOK_ENCRYPTION_KEY`; live receiver pending |
| Intelligence/agents | AI | implemented | Tool registry, evidence | Approval/unsupported-plan integration tests | Not deployed | Deterministic planner; no generative model claimed |
| STAC/source registry | Data governance | implemented | MAAP STAC, Redis | Adapter compile/type; live catalog verified | Not deployed | Live item-search smoke pending |
| Admin console/feature flags | Platform | implemented | Admin guard | Enterprise admin test | Not deployed | Full operations browser flow pending |
| Marketing/legal | Commercial | implemented | Design system | Production build includes all pages | Not deployed | Legal review pending |
| Persisted reports | Reporting | implemented | ReportRecord, quotas | Persistence/CSV/PDF integration test | Not deployed | Browser print fallback retained |
| Quantitative raster pipeline | Geospatial | implemented | Raster service, artifact volume | 7 Python tests pass; enterprise asset test passes | Overlay prepared | Retention policy remains operational work |
| Database RLS | Security | implemented | RLS migration, tenant proxy | 3 RLS integration tests pass | Overlay prepared | Ensure production web role and GUC settings are deployed |
| Runtime dependency patching | Security | verified | `bun audit` | 0 high/critical across 794 packages | Build artifact | Keep CI audit enabled |
| CSP | Security | implemented (report-only) | Nonce middleware, report endpoint | `tests/csp.test.ts` | Deploying | Promote to enforcing after a clean violation ledger |
| Password reset | Identity | verified | PasswordReset migration, email | `tests/account-isolation.test.ts` (request, replay, expiry, weak password) | Deploying | Account deletion still absent |
| Provider provenance attribution | Security | verified | Provider attribution context | `tests/private-provider-context.test.ts` | Deploying | Personal (non-organization) private calls remain unlogged by design |
| Host deploy path | SRE | implemented | systemd, PostgreSQL container | `tests/deployment-config.test.ts`; live deploy | Deploying | GitHub Actions deploys blocked by account billing lock |
| Observability dashboards | SRE | partial | Production-scale metrics work | Concurrent session | In progress | Prometheus/Grafana acceptance pending |
| Backup/restore drill | SRE | partial | Production-scale deploy work | Concurrent session | In progress | Required before release |

## Change log

### 2026-11-27

- Added nonce-based CSP middleware in report-only mode and a bounded `/api/v1/csp-report` intake; enforcement stays off until the violation ledger is clean.
- Added single-use, hashed, one-hour password-reset tokens (table, migration, request/confirm routes, account UI); unknown and unverified addresses get the same 202 answer.
- Private provider calls attributed to an organization now write metadata-only provenance rows (no URL, hash, coordinates or raw error); anonymous private calls remain unlogged.
- Replaced the stale SQLite `DATABASE_URL` override in the systemd deployment artifacts; added the production unit file and `scripts/deploy-vps.sh` (backup → build → migrate → readiness gate → automatic rollback on failure).
- Cleared the remaining lint warnings; underscore-prefixed unused bindings are now an explicit convention.

### 2026-11-25

- Applied all four PostgreSQL migrations to an empty database, proved idempotence, and confirmed zero schema drift.
- Added `JobAccepted`, `JobDetail`, outcome types, and `waitForJob` polling with terminal-state validation.
- Updated dashboard, analysis, fire, watchlist, command-palette, and report flows for current API contracts.
- Added embedded/external worker mode and `bun run worker`.
- Added organizations, memberships, invitations, workspaces, role permissions, tenant-aware guards, and cooperative UI.
- Added configurable plans, subscriptions, entitlements, successful-job/report/raster metering, and billing UI.
- Added hashed/scoped API keys, five developer read resources, OpenAPI 3.1, rate/quota headers, and key UI.
- Added AES-GCM-encrypted webhook secrets, DNS-aware SSRF checks, signed outbox delivery, retries, and delivery history.
- Added deterministic intelligence plans, typed tool executions, approval gates, evidence references, and UI.
- Added structured source governance, NASA MAAP STAC discovery, Data Catalogue, and raster upload UI.
- Added protected admin overview and feature flags.
- Added marketing, solutions, methodology, industries, pricing, API, research, contact, privacy, and terms pages.
- Added persisted JSON report snapshots and server CSV export; browser print-to-PDF remains.
- Added a FastAPI/Rasterio service with GeoTIFF statistics, clipping, reprojection/resampling, nodata handling, and lineage; three Python tests pass.
- Started disposable PostGIS/Redis services; no production data touched.
- Final isolated verification: 313 tests passing, 0 failures (1,635 assertions), 0 lint errors, typecheck pass, Prisma client generated, `bun audit` clean, and production build successful with 70 pages/routes.
- Production browser acceptance passed on the stable acceptance stack: 270/270 module-viewport runs, 1,152 assertions, 0 failures.
- Failure-mode browser acceptance passed all five executed checks.
- Derived raster assets persist to a private volume with tenant-scoped `RasterAsset` records; seven Python service tests pass.
- Legal readiness pack added at `docs/LEGAL_REVIEW.md`; qualified counsel sign-off remains.
- Remaining release gates: real production overlay/secrets, legal sign-off, external-provider guarantees.
- Database RLS foundation added with tenant proxy, active-organization policies, and three passing integration tests.
- Server-side PDF generation and NetCDF/Zarr dataset statistics added and tested.
- Enterprise deployment overlay and environment template added without modifying base Compose; `scripts/deploy-vps.sh` now preserves the webhook key and uses the checksummed backup/readiness/rollback gate.
- Capability discovery endpoint removes expected 401 console noise from the shell; provider note is visible in System Health.
- Re-verified 2026-11-25 (continued pass): typecheck clean; `docker compose -f compose.yaml -f compose.enterprise.yml config` validates; raster service 7 Python tests pass; RLS + enterprise integration wrappers pass; dependency audit clean (0 high/critical).

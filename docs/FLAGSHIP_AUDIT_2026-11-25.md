# TerraField Atlas — Flagship Repository Audit

Date: 2026-11-25
Scope: existing implementation versus the Flagship Product Master Engineering Prompt.

## 1. Executive summary

TerraField Atlas is no longer a UI-only prototype. It has a real Next.js/TypeScript application, verified email/password accounts, PostgreSQL/PostGIS migrations, Redis-backed shared runtime state, a durable BullMQ job ledger, real NASA GIBS/POWER/EONET and ISRIC adapters, deterministic statistical methods, crop-rotation logic, provenance records, fire watchlists, signed digest delivery, and a substantial automated test suite.

The enterprise product layer has now been implemented additively: organizations, memberships, invitations, workspaces, role permissions, configurable plans and quotas, successful-operation metering, hashed API keys, a versioned developer API, signed tenant webhooks, approved intelligence plans, a governed STAC/source catalogue, platform administration, persisted reports with CSV export, a functional marketing/legal site, and a tested GeoTIFF raster-processing service.

It is not yet release-certified. The largest remaining blockers are live production deployment of the overlay/secrets, external-provider guarantees, derived-asset lifecycle policy, legal review, and final cross-session documentation sign-off.

The existing architecture should be evolved, not replaced. The approved production-scale design in `docs/superpowers/specs/2026-11-24-production-scale-design.md` already matches the required direction.

## 2. Verified baseline

Executed in the current checkout with disposable PostgreSQL/PostGIS and Redis services:

- `bun run typecheck`: passes across the combined checkout.
- `bun run lint`: 0 errors; remaining warnings are tracked and mostly pre-existing effect-dependency/unused-variable issues.
- Enterprise migration: all four migrations apply to an empty PostgreSQL database, redeploy is idempotent, and Prisma reports no schema drift.
- `tests/enterprise.integration.ts`: passes in an isolated PostGIS/Redis environment, covering tenancy, roles, quotas, API keys, webhooks, report persistence/CSV, admin flags, and intelligence approvals.
- `mini-services/raster`: three Python unit tests pass for nodata-aware statistics, clipping/reprojection/resampling, and invalid-input rejection.
- Full combined regression: 301 passing tests, 0 failures with reduced concurrency on isolated PostgreSQL/Redis.
- Production build: successful on Next.js 16.4.6 with 67 generated/dynamic pages.
- Dependency audit: 0 high/critical advisories after patching Next.js, Auth.js, Zod, Sharp, transitive packages, and narrowly overriding Prisma CLI config dependencies.
- Prisma client generated successfully after the lock cleared.

No production database was modified. No deployment was performed.

## 3. Architecture map

```text
Browser
  Next.js App Router SPA ("/") + server-rendered /about, /account, /guide/*
  React 19, TypeScript, Tailwind 4, Zustand, TanStack Query, MapLibre GL, Recharts
        |
        v
/api/v1/* route handlers
  correlation IDs, Zod validation, bounded bodies, Redis rate limits
  accountApiGuard / requireVerifiedWriter / requireAdministrator
  tenant-scoped durable idempotency
        |
        +-- adapters: POWER, GIBS WMTS/MVT, EONET, FIRMS, SoilGrids
        +-- science: seasonal Mann-Kendall, Theil-Sen, Hamed-Rao, BH-FDR
        +-- agronomy: versioned crop catalogue + deterministic rotation engine
        +-- fire: coverage ledger, watchlists, evaluation leases, digests
        +-- jobs: PostgreSQL ProcessingJob + transactional OutboxEvent
        |          Redis/BullMQ pointer + leases + concurrency semaphores
        +-- delivery: SSE digest hub, signed webhook exit, SMTP/Resend email
        |
        v
PostgreSQL/PostGIS  +  Redis  +  external providers
```

Primary references:

- `docs/ARCHITECTURE.md`
- `docs/superpowers/specs/2026-11-24-production-scale-design.md`
- `prisma/schema.prisma`
- `src/lib/api/helpers.ts`
- `src/lib/queue.ts`
- `src/lib/jobs/runtime.ts`
- `src/lib/jobs/handlers.ts`

## 4. Implemented-feature inventory

| Feature | Classification | Evidence / limits |
| --- | --- | --- |
| Marketing landing and mission narrative | Operational | `src/components/views/landing.tsx`; browser-verified in prior release |
| Earth Intelligence dashboard | Operational after job-client repair | `src/components/views/dashboard.tsx`; POWER ingestion is durable |
| Geospatial Explorer | Operational | `src/components/views/explorer.tsx`, `src/components/map/gibs-map.tsx`; GIBS raster layers |
| Environmental trend analysis | Implemented; job-client repair required | `src/lib/stats/*`, `src/components/views/analysis.tsx` |
| Farm profiles and boundaries | Operational for verified accounts | `src/app/api/v1/farms/*`; GeoJSON validation and ownership checks |
| Soil tests and modeled SoilGrids | Operational with provider degradation | `src/app/api/v1/farms/[farmId]/soil-tests/*` |
| Crop catalogue and rotation comparison | Operational | `src/lib/crops/*`; citations, missing-data confidence, no profit claims |
| Fire ingestion and historical ledger | Operational | `src/lib/adapters/gibsFires.ts`, `src/app/api/v1/fires/route.ts` |
| Fire watchlists, backtests, scheduler | Implemented; replica-safety work in progress | `src/lib/fires/*`, `src/lib/scheduler.ts` |
| Digest SSE, signed webhook, email exits | Implemented; external production recipients unverified | `src/lib/fires/digest-*` |
| Verified accounts and private ownership | Operational | `src/lib/auth.ts`, `src/lib/account-access.ts`, account integration tests |
| Durable jobs, retries, leases, cancellation | Implemented; worker startup repaired in this pass | `src/lib/jobs/*`, `src/instrumentation.ts` |
| Provenance request ledger | Partial | `ApiRequestLog` exists; public endpoint intentionally withholds unattributed/private logs |
| Reports | Partial | `src/app/api/v1/reports/route.ts`; browser print-to-PDF and CSV-oriented data, no persisted server PDF |
| Evidence/source register | Partial | `DataSource` + `docs/DATA_SOURCES.md`; missing structured STAC/version/quality fields |
| Organizations/RBAC/workspaces | Implemented | enterprise models, tenant guards, cooperative UI, cross-tenant tests |
| Plans/entitlements/usage/billing | Implemented | configurable plans, quotas, successful-operation metering; no payment settlement |
| Managed API keys/developer portal | Implemented | hashed/scoped keys, five read resources, OpenAPI, quotas |
| General integration webhooks | Implemented | encrypted secrets, signed outbox delivery, retries, SSRF guards |
| AI/agent orchestration | Implemented | deterministic validated plans, typed tools, approvals, evidence; no opaque chatbot |
| Admin console | Implemented | protected overview and feature flags |
| Raster processing service | Implemented | GeoTIFF/NetCDF/Zarr stats, clipping/reprojection/resampling, lineage, persisted assets |
| Markets | Planned | deliberately deferred until approved price/production feeds exist |

## 5. Integration inventory

| Provider/product | Status | Honest representation |
| --- | --- | --- |
| NASA POWER Daily API | Live adapter, fixture-tested and previously live-smoked | MERRA-2 reanalysis, 0.5° × 0.625°, LST day boundaries |
| NASA GIBS WMTS | Live raster layers | MODIS true color, VIIRS true color, MOD13Q1 NDVI render, SMAP L4 render |
| NASA GIBS VIIRS MVT | Live detection source | 375 m thermal anomalies; not confirmed fires; archive gaps reported |
| NASA EONET | Live event context | Event-level wildfire context, not per-pixel detections |
| NASA FIRMS CSV | Adapter implemented; credential/egress dependent | Never substituted with fabricated data |
| ISRIC SoilGrids v2.0 | Live adapter; intermittent | Modeled estimates, never silently treated as lab measurements |
| Earthdata/AppEEARS science files | Not configured | Explicit not-configured state |
| ESA Sentinel/Copernicus/JAXA/WorldClim/FAO machine APIs | Not integrated | Documented future adapters only |

No NASA endorsement or partnership is claimed.

## 6. Technical debt register

1. **Documentation drift:** this audit, the release validation report, and the architecture guide now reflect the implemented production and enterprise stacks; historical release notes remain time-stamped records.
2. **Async contract drift:** POWER/trends/fire/evaluation routes return 202 jobs; client types and tests were synchronous. Repaired in this pass.
3. **Worker lifecycle:** the worker entry point existed but was not started by the runtime. Embedded mode added; external mode still needs deployment wiring.
4. **Task 7 concurrent work:** Redis digest hub and scheduler changes were being edited during this audit and temporarily failed type checking.
5. **Provenance attribution:** `ApiRequestLog.organizationId` added; organization logs are scoped, but provider calls are not yet automatically bound to request context in every adapter.
6. **Audit attribution:** `AuditEvent.organizationId` added and written by enterprise mutations; older unattributed events remain historical.
7. **Organization model:** implemented additively with API and database isolation.
8. **Source registry:** structured governance and STAC identifiers added; not every provider has complete metadata yet.
9. **Database-enforced RLS:** implemented and policy-tested; production role deployment remains.
10. **Usage/billing enforcement:** implemented for farms, jobs, API requests, reports, intelligence runs, and raster statistics; storage metering is not configured.
11. **General outbox dispatcher:** implemented for tenant webhooks; delivery is worker-polled rather than immediate.
12. **Report artifacts:** JSON snapshots, server CSV, and server PDF are implemented.
13. **Quantitative raster science:** GeoTIFF, NetCDF, and Zarr statistics are implemented; derived-asset persistence remains.
14. **Marketing/legal surface:** functional pages added; legal review is still required.
15. **Lint warnings remain:** mostly pre-existing React effect dependencies and unused variables.

## 7. Security findings

### SEC-001 — Resolved — Database-level tenant isolation

**Original evidence:** Prisma connected as the database owner; no RLS policies or per-request database context existed.
**Resolution:** added a `terrafield_app` role, tenant policy functions, per-table RLS policies, and a Prisma tenant proxy that sets transaction-local `app.user_id` and `app.organization_id`. Organization rows require an active selected workspace. `tests/rls.integration.ts` verifies anonymous/personal/organization visibility and that cross-tenant writes affect zero rows. Production must deploy the web role and GUC settings via the enterprise overlay.

### SEC-002 — Resolved — Provider provenance is tenant-bound

**Location:** `prisma/schema.prisma` `ApiRequestLog`; `src/lib/http.ts`; `src/lib/ingest/provider-context.ts`; `src/app/api/v1/provenance/route.ts`.
**Resolution:** provider calls carry an `organizationId` through the private-provider context. Organization-attributed private calls now write metadata-only provenance rows (`organizationId`, provider, operation, status, latency) with `requestUrl = '[private]'`, `paramsHash = null` and a fixed error label; coordinates, URLs and raw provider errors are never persisted. Anonymous private calls remain unlogged. `tests/private-provider-context.test.ts` asserts both behaviours.

### SEC-003 — Resolved (report-only) — CSP

**Location:** `src/middleware.ts`; `src/app/api/v1/csp-report/route.ts`; `next.config.ts`.
**Resolution:** every document response now carries a nonce-based `Content-Security-Policy-Report-Only` header with `report-uri /api/v1/csp-report`, and Next stamps its inline scripts with the per-request nonce. The report endpoint bounds input at 8 KiB, extracts only policy-relevant fields, and writes a structured log line; it never stores or echoes the report. Enforcement is deliberately not enabled yet — `tests/csp.test.ts` asserts report-only and a fresh nonce per request.

### SEC-004 — Low — Webhook egress depends on operator configuration

**Location:** `src/lib/outbox-worker.ts`, `src/lib/webhook-crypto.ts`, `src/app/api/v1/webhooks/*`.
**Evidence:** URL/DNS SSRF checks, HTTPS-in-production, no redirects, AES-GCM secret encryption, HMAC signing, bounded retries, and durable delivery records are implemented.
**Impact:** a deployment without `WEBHOOK_ENCRYPTION_KEY` cannot create webhooks; egress infrastructure still needs monitoring.
**Fix:** provision the key through secret management and alert on failed deliveries.

### SEC-005 — Low — Durable client session state is not authorization

**Location:** `src/components/state/store.ts`.
**Evidence:** local operator/callsign and workspace preferences persist in Zustand.
**Impact:** UI state can be tampered with, but server checks remain authoritative.
**Fix:** continue deriving identity/permissions from the server; never persist secrets or authorization decisions client-side.

### SEC-006 — Resolved — Vulnerable runtime dependencies

**Original evidence:** `bun audit` reported 5 critical and 58 high advisories, including Next.js RCE/SSRF/DoS paths, Auth.js email normalization and malformed Bearer handling, Zod memory exhaustion, Sharp/libvips issues, and PostCSS source-map disclosure.
**Resolution:** upgraded Next.js to 16.4.6, Auth.js to 4.24.15, Zod to 4.6.7, Sharp to 0.35.5, applied in-range transitive fixes, removed unused MDX editor, and narrowly overrode Prisma CLI config dependencies. Final audit reports 0 high/critical advisories across 781 packages.

## 8. Data-quality findings

- Missing POWER values are excluded and counted; no imputation.
- Months with fewer than 20 valid days are excluded from trend analysis.
- SoilGrids modeled values remain distinctly labeled and confidence-discounted.
- VIIRS archive gaps are distinct from zero detections.
- Backtests must not overwrite current watchlist status; evaluation versioning exists.
- NDVI and SMAP are visual renders only; quantitative claims would be invalid.
- Crop economics are explicitly not assessed without approved price data.
- Forecast products do not exist; none are claimed.

## 9. Performance findings

- Observation, fire, job, watchlist, and idempotency query indexes exist.
- POWER ingestion is chunked and bounded; fire ingestion is bounded by days/tiles.
- Redis provides shared cache, rate limits, single-flight refreshes, and circuit state.
- Durable jobs have deadlines, leases, stale recovery, and concurrency caps.
- Free-location observation queries are now coordinate-scoped in the client, but server-side aggregation across many farms needs portfolio-specific endpoints.
- High-volume ledgers are not partitioned; revisit after measured volume thresholds.
- No load test or queue-pressure benchmark has been executed in this pass.

## 10. Product gap analysis and priority

### P0 — release correctness

1. Async job client/server/test contract repaired.
2. Durable worker startup implemented in embedded and external modes.
3. Typecheck passes; full regression/build acceptance still pending.
4. Critical/high runtime dependency advisories patched and audit is clean.
5. Implement database-enforced tenant isolation (SEC-001).
6. Complete production-scale deployment, observability, backup/restore, and browser acceptance.

### P1 — enterprise foundation — implemented

5. Organizations, memberships, roles, invitations, workspaces.
6. Shared farm/watchlist portfolios with explicit cross-tenant tests.
7. Plans, subscriptions, entitlements, successful-operation usage metering.
8. Managed API keys and versioned developer endpoints.
9. Tenant-managed signed webhooks and outbox dispatch.
10. Admin overview, feature flags, source/job/audit operations.

### P2 — intelligence and science — implemented except noted

11. Typed agent/tool registry, validated natural-language plans, approval gates, evidence graph.
12. Structured source registry and STAC discovery proxy.
13. Quantitative raster service: GeoTIFF/NetCDF/Zarr statistics and derived-asset records complete; retention policy remains operational work.
14. Persisted reports and CSV complete; server PDF pending.
15. Additional providers only after credentials/licensing are verified.

### P3 — commercial surfaces — implemented except noted

16. Functional marketing, pricing, API, research, contact, privacy, and terms pages.
17. Guided cooperative onboarding: organization creation/invite/workspace flow implemented; full guided first-value tour pending.
18. Localization and country-specific agronomic rules pending.
19. Market intelligence only with approved feeds.

## 11. Release gate status

| Gate | Status |
| --- | --- |
| Critical workflows work end-to-end | Partial; core job/enterprise workflows pass integration, full browser rerun pending |
| Migrations succeed | Pass from empty PostgreSQL, idempotent redeploy, zero schema drift |
| Authentication works | Pass in existing integration suite |
| Tenant isolation passes | Account, organization API, and PostgreSQL RLS tests pass |
| No critical security vulnerabilities | Dependency audit clean; production RLS role deployment still required |
| External sources honestly represented | Pass |
| Failed jobs recover | Implemented; failure-mode acceptance in progress |
| Critical tests pass | 301 pass, 0 fail; typecheck/lint/build/audit pass |
| Observability operational | Partial; production-scale metrics work in progress |
| Backup/recovery documented | Partial; production-scale scripts in progress, restore drill not run here |
| Legal/licensing reviewed | Partial; source/legal pages exist, professional review pending |
| Deployment reproducible | Production and enterprise Compose stacks build and configure; real deployment requires operator secrets and access |

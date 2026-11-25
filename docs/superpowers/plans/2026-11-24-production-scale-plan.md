# Production Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved verified-account, PostgreSQL/Redis/BullMQ, multi-replica production architecture with verified mobile behavior and safe cutover.

**Architecture:** Stateless Next.js web replicas sit behind Caddy. PostgreSQL/PostGIS owns durable state; Redis owns shared runtime state and queues; workers execute jobs and a database-leased scheduler owns periodic evaluations. A transactional outbox drives cross-replica SSE and notification delivery.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma, PostgreSQL/PostGIS, Redis, BullMQ, Docker Compose, Caddy, Playwright, Vitest-compatible Bun tests.

**Spec:** `docs/superpowers/specs/2026-11-24-production-scale-design.md`

## Global Constraints

- All writes require a verified account; public seed records are immutable.
- No provider call occurs inside a database transaction.
- Every mutation has tenant-scoped idempotency and atomic audit/outbox persistence.
- No secrets in source, browser bundles, fixtures, logs, or committed environment files.
- No destructive production action occurs without a verified backup and explicit cutover step.
- Do not commit unless the user explicitly requests a commit.
- Browser acceptance uses production mode and Chromium/Edge, Firefox, and WebKit.
- No claim of physical-device certification or VPS-level high availability.

---

### Task 1: Restore enforceable quality gates

**Files:**
- Modify: `package.json`
- Modify: `eslint.config.mjs`
- Create: `tests/quality-gates.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces scripts `test`, `test:integration`, `lint`, `typecheck`, `build`, and `db:migrate:deploy`.
- Produces CI jobs that fail on lint, type, unit, PostgreSQL migration, or build failure.

- [ ] Add a test that reads the quality scripts and asserts `db:push --accept-data-loss` is not the production migration command.
- [ ] Run `bun test tests/quality-gates.test.ts` and confirm the new assertion fails against the current package script.
- [ ] Add Node-only ESLint overrides for `tests/*.cjs` and `scripts/*.cjs`, while retaining TypeScript rules for application code.
- [ ] Add explicit `typecheck`, integration-test, and `prisma migrate deploy` scripts; keep local SQLite development commands clearly separate.
- [ ] Run `bun run lint` and `bun run typecheck`; fix all application errors rather than disabling rules globally.
- [ ] Update CI to execute lint, typecheck, tests, and build as separate named steps.

### Task 2: Establish PostgreSQL/PostGIS schema and migration baseline

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261124000000_init_postgres/migration.sql`
- Create: `tests/postgres-schema.integration.ts`
- Create: `docker-compose.test.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces `DATABASE_URL=postgresql://...` support in `src/lib/db.ts`.
- Produces models `IdempotencyRecord`, `JobLease`, `OutboxEvent`, and administrator capability on `AccountUser`.
- Produces constraints for tenant-scoped idempotency, scenario names, ownership indexes, and query indexes.

- [ ] Write an integration test that starts from an empty PostgreSQL database, runs `prisma migrate deploy`, asserts `PostGIS` is available, and creates/reads one farm and observation.
- [ ] Run it and confirm failure because the current provider is SQLite and no initial migration exists.
- [ ] Change the Prisma datasource/provider to PostgreSQL; preserve all existing domain fields and relations.
- [ ] Add `IdempotencyRecord` keyed by `(ownerId, route, key)` with request hash and response reference; add `JobLease`, `OutboxEvent`, and admin capability.
- [ ] Add actual query indexes for owner/resource/date predicates and unique `(farmId, name)` on rotation scenarios.
- [ ] Generate and review the complete initial SQL migration; enable PostGIS explicitly where spatial columns are introduced.
- [ ] Add a PostgreSQL service to CI, run deploy from empty, rerun deploy to prove idempotence, and run the integration test.

### Task 3: Build validated SQLite-to-PostgreSQL cutover tooling

**Files:**
- Create: `scripts/migrate-sqlite-to-postgres.ts`
- Create: `scripts/validate-migration.ts`
- Create: `tests/sqlite-migration.integration.ts`
- Create: `deploy/scripts/cutover.sh`
- Create: `deploy/scripts/rollback.sh`

**Interfaces:**
- Produces `migrateSqlite({ sourceUrl, targetUrl, dryRun })` returning per-table source/target counts and deterministic sampled hashes.
- Produces a cutover script that refuses to continue without a successful backup and write freeze.
- Produces a rollback script that restores the named artifact and database snapshot.

- [ ] Write an integration test with representative farms, null owners, observations, account rows, events, Unicode text, and timestamps; migrate twice in dry-run and assert no target mutation on dry-run.
- [ ] Run it and confirm failure because no migration tool exists.
- [ ] Implement batched table copy with explicit column maps, preserved IDs/timestamps, transaction boundaries, and resumable checkpoints.
- [ ] Validate source/target counts and sampled canonical hashes before reporting success; fail on unknown columns, invalid dates, orphaned foreign keys, or mismatches.
- [ ] Implement cutover steps: stop writes, verify SQLite backup, run migration, validate, switch `DATABASE_URL`, restart services, check readiness.
- [ ] Implement rollback using explicit artifact/snapshot arguments; never delete the source database automatically.

### Task 4: Replace process-local runtime state with Redis adapters

**Files:**
- Create: `src/lib/redis.ts`
- Modify: `src/lib/cache.ts`
- Modify: `src/lib/http.ts`
- Modify: `src/lib/api/helpers.ts`
- Modify: `src/lib/source-health.ts`
- Create: `tests/redis-runtime.test.ts`

**Interfaces:**
- Produces `RedisRuntime` methods `getJson`, `setJson`, `deletePrefix`, `tokenBucket`, `singleFlight`, `publish`, and `subscribe`.
- Produces canonical SHA-256 cache keys and bounded TTL state.
- Produces shared circuit state and one in-flight provider refresh across replicas.

- [ ] Write tests proving distinct canonical inputs cannot share a key, expired buckets are evicted, throttled keys return `retryAfterSec`, and 20 concurrent single-flight calls execute one loader.
- [ ] Run them and confirm failure against the current Map/FNV implementation.
- [ ] Implement Redis adapters with namespaced keys, TTLs, bounded payloads, and explicit unavailable-service errors.
- [ ] Replace FNV keys with SHA-256 over complete canonical parameters; add provider-response coordinate validation where applicable.
- [ ] Move limiter/circuit/cache/source-probe state to Redis and coalesce refreshes.
- [ ] Add `Retry-After` parsing and a single retry owner in server provider requests; test 429, 500, permanent 400, timeout, and abort paths.

### Task 5: Enforce verified writes, atomic mutations, and uniform API behavior

**Files:**
- Modify: `src/lib/account-access.ts`
- Modify: `src/lib/account-security.ts`
- Modify: `src/lib/api/helpers.ts`
- Modify: `src/app/api/v1/farms/route.ts`
- Modify: `src/app/api/v1/farms/[farmId]/route.ts`
- Modify: `src/app/api/v1/farms/[farmId]/soil-tests/route.ts`
- Modify: `src/app/api/v1/rotation/compare/route.ts`
- Modify: `src/app/api/v1/system/status/route.ts`
- Modify: `src/app/api/v1/system/sources/route.ts`
- Create: `tests/api-hardening.integration.ts`

**Interfaces:**
- Produces `requireVerifiedWriter(req)`, `requireAdministrator(req)`, and `withIdempotency(req, route, handler)`.
- Produces bounded `parseBody` with `413`, strict date/range schemas, and consistent correlation/error responses.
- Produces atomic farm/soil/scenario/audit/outbox transactions.

- [ ] Write integration tests proving anonymous PATCH/DELETE/evaluate on seeded records returns 401/403, verified users cannot mutate others' records, and only administrators can invalidate cache or force probes.
- [ ] Add tests proving an audit failure rolls back the domain write and matching idempotency retries replay one result without duplication.
- [ ] Run tests and confirm failures against the current split writes/guards.
- [ ] Require verified accounts for every mutation except the signature-authenticated inbound webhook; make seeded rows read-only.
- [ ] Enforce a shared request-byte cap, strict calendar dates, `from <= to`, deduplicated bounded arrays, cursor pagination, and row limits.
- [ ] Implement tenant/route/key idempotency with request fingerprint conflict detection and transaction-wrapped response references.
- [ ] Convert rotation replacement to one serializable transaction/upsert set and reject duplicate names.
- [ ] Standardize bypass routes on the same envelope/correlation contract without weakening NextAuth CSRF or webhook HMAC checks.

### Task 6: Move expensive work to durable BullMQ jobs

**Files:**
- Create: `src/lib/queue.ts`
- Create: `src/lib/jobs/runtime.ts`
- Create: `src/lib/jobs/handlers.ts`
- Modify: `src/app/api/v1/observations/ingest/route.ts`
- Modify: `src/app/api/v1/analysis/trends/route.ts`
- Modify: `src/app/api/v1/fires/route.ts`
- Modify: `src/app/api/v1/fires/watchlists/[id]/evaluate/route.ts`
- Create: `tests/jobs.integration.ts`

**Interfaces:**
- Produces `enqueueJob({ type, ownerId, params, correlationId, idempotencyKey })` returning a durable job ID.
- Produces handlers with `lease`, `heartbeat`, `deadline`, `cancel`, and natural-key upserts.
- Produces stale-job recovery and queue metrics.

- [ ] Write tests proving repeated enqueue with the same idempotency key creates one logical job, a killed worker's expired lease is recovered, and tenant/global concurrency caps are enforced.
- [ ] Run them and confirm failure because work currently executes inline.
- [ ] Add BullMQ queues and a worker entry point; return `202` with job URL for ingestion, trends, fire ingestion, and evaluation.
- [ ] Create the job row and outbox event atomically before enqueue; reconcile enqueue failures through the outbox.
- [ ] Add heartbeat leases, deadlines, cooperative cancellation, exponential retry policy, dead-letter state, and stale-running recovery.
- [ ] Bound provider work by overall job deadline and persist observations/detections with PostgreSQL upserts.
- [ ] Expose protected queue depth, oldest-job age, retries, failures, and worker heartbeats.

### Task 7: Make scheduling, evaluation, SSE, and notification delivery replica-safe

**Files:**
- Modify: `src/lib/scheduler.ts`
- Modify: `src/lib/fires/watchlist-evaluate.ts`
- Modify: `src/lib/fires/digest-channel.ts`
- Modify: `src/lib/fires/watchlist-digest-service.ts`
- Modify: `src/lib/fires/digest-exit-webhook.ts`
- Modify: `src/lib/fires/digest-exit-email.ts`
- Create: `src/lib/outbox-worker.ts`
- Create: `tests/replica-delivery.integration.ts`

**Interfaces:**
- Produces database-backed scheduler leadership and per-watchlist evaluation leases.
- Produces Redis-backed `DigestHub` with authenticated tenant streams and cross-replica publish/subscribe.
- Produces outbox delivery with stable event IDs and durable receiver deduplication.

- [ ] Write tests proving only one scheduler leader runs, two evaluators cannot commit out of order, backtests do not change current status, and subscribers on two hub instances receive one committed event.
- [ ] Add tests proving newest-first digest truncation, explicit triggering event identity, stable webhook idempotency keys, and rejection of redirect/DNS private targets.
- [ ] Run tests and confirm failures against process-local timers/hubs and split evaluation writes.
- [ ] Acquire a PostgreSQL scheduler lease and per-watchlist compare-and-swap version; commit event/current status/job/audit/outbox atomically.
- [ ] Make backtests append-only and ignore stale completion versions.
- [ ] Replace in-memory SSE delivery with Redis pub/sub while retaining authenticated connection registration and backpressure/caps.
- [ ] Fetch newest digest events before limiting; pass triggering event ID/trigger explicitly to email/webhook predicates.
- [ ] Harden outbound redirects/DNS/SSRF handling and persist delivery attempts/deduplication through outbox workers.

### Task 8: Fix client transport, hydration, selection, and race correctness

**Files:**
- Modify: `src/lib/api-client.ts`
- Modify: `src/components/providers.tsx`
- Modify: `src/components/state/store.ts`
- Modify: `src/hooks/use-digest-stream.ts`
- Modify: `src/components/views/dashboard.tsx`
- Modify: `src/components/views/analysis.tsx`
- Modify: `src/components/views/rotation-planner.tsx`
- Modify: `src/components/views/reports.tsx`
- Modify: `src/components/views/fire-watchlists.tsx`
- Create: `tests/client-state.test.ts`

**Interfaces:**
- Produces combined caller/timeout abort, one-layer retry, `Retry-After` support, and typed malformed-payload errors.
- Produces request context `{ ownerId, farmId, lat, lon, inputHash }` attached to results.
- Produces per-watchlist pending/evaluation state and push-aware query cancellation.

- [ ] Write tests proving caller abort wins, timeout aborts, malformed 200 JSON rejects, GET retry count is bounded, and mutations do not auto-retry without an idempotency key.
- [ ] Write state tests proving a response for farm A cannot populate farm B's view and a push newer than an in-flight GET cannot be overwritten.
- [ ] Run tests and confirm current failures.
- [ ] Add optional coordinates to `api.observations` and always send them for free-location views.
- [ ] Capture result context and reset/invalidate mutations when farm, coordinates, priorities, or scenarios change.
- [ ] Use per-watchlist pending state and cancel digest GETs before applying pushed data.
- [ ] Gate persisted Zustand hydration until after mount and derive authorization from server session, not local operator state.

### Task 9: Repair farm/geography forms and mobile/accessibility defects

**Files:**
- Modify: `src/components/views/farm-workspace.tsx`
- Modify: `src/components/views/fire-watchlists.tsx`
- Modify: `src/components/views/fire-intelligence.tsx`
- Modify: `src/components/map/gibs-map.tsx`
- Modify: `src/components/views/landing.tsx`
- Modify: `src/components/system/guided-tour.tsx`
- Modify: `src/components/system/source-signs.tsx`
- Modify: `src/components/views/settings.tsx`
- Modify: `src/components/charts/scientific-charts.tsx`
- Modify: `src/app/globals.css`
- Modify: `src/components/ui/button.tsx`
- Modify: `src/hooks/use-console-hotkeys.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/app-shell.tsx`
- Create: `tests/ui-regressions.test.ts`

**Interfaces:**
- Produces farm-keyed editors, explicit map targets, synchronized geography forms, and one footer per surface.
- Produces accessible modal/focus behavior and AA-compliant text/control styles.

- [ ] Write component tests proving farm switches reset crop/soil drafts and malformed stored JSON cannot crash an editor.
- [ ] Add browser assertions for 320/375 widths: no page overflow, day bars accessible, landing table scrollable, map controls non-overlapping, and primary coarse-pointer actions at least 44px.
- [ ] Run them and confirm the current defects.
- [ ] Key editors by farm ID, validate persisted JSON, and bind saves/toasts to the submitted farm ID.
- [ ] Synchronize watchlist geography when its form opens, show coordinates, pass explicit map targets, and detach active farm where appropriate.
- [ ] Add mobile layer drawer/bottom sheet, wrapped/scrollable day bars, horizontally scrollable source table, mobile chart intervals, and chart text alternatives.
- [ ] Fix contrast, coarse-pointer targets, dialog-aware shortcuts, tour focus trap/restoration, and mutually exclusive error/empty states.
- [ ] Remove duplicate footer content and check HTTP status before reporting cache invalidation success.

### Task 10: Add private Compose deployment, observability, and safe release automation

**Files:**
- Create: `compose.yaml`
- Create: `deploy/caddy/Caddyfile`
- Create: `deploy/postgres/init.sql`
- Create: `deploy/backup.sh`
- Create: `deploy/restore-drill.sh`
- Create: `deploy/prometheus/prometheus.yml`
- Create: `deploy/grafana/provisioning/dashboards/dashboard.json`
- Create: `deploy/alert-rules.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/promote.yml`
- Modify: `.zscripts/start.sh`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/LIMITATIONS.md`

**Interfaces:**
- Produces services `postgres`, `redis`, `web`, `worker`, `scheduler`, `outbox`, `caddy`, `prometheus`, and `grafana`.
- Produces `/readyz` checks for database/schema/seed, Redis, scheduler lease/heartbeat, and worker health.
- Produces readiness-gated release and rollback commands with named backup artifacts.

- [ ] Add a configuration test asserting database/Redis/monitoring ports are not public, Caddy has no query-controlled upstream, and web replicas share one database/Redis configuration.
- [ ] Run it and confirm failure against the current Caddyfile/deployment.
- [ ] Implement Compose with private networks, persistent named volumes, healthchecks, restart policies, resource limits, JSON logging, and log rotation.
- [ ] Replace the public Caddy transform route with fixed HTTPS upstreams and TLS configuration; bind any administrative listener to loopback.
- [ ] Add structured application logs and Prometheus metrics for HTTP, DB, queue, scheduler, provider, and SSE behavior; configure dashboards and alerts.
- [ ] Implement nightly PostgreSQL backup, retention, checksum, and restore-drill verification.
- [ ] Make readiness fail on empty/mismatched schema, overdue first scheduler tick, missing leadership/heartbeat, or unavailable Redis/workers; redact public errors.
- [ ] Update deploy workflows to build once, run migrations against the canonical database, cut over with backup, gate on readiness/API/browser checks, and roll back on failure.
- [ ] Replace stale documentation with implemented authentication, delivery, scale, backup, and single-VPS failure-domain facts.

### Task 11: Run full production browser and failure-mode acceptance

**Files:**
- Modify: `tests/responsive-browser.cjs`
- Modify: `tests/console-browser.cjs`
- Create: `tests/production-browser.cjs`
- Create: `tests/failure-mode-browser.cjs`
- Modify: `docs/release-validation-2026-11-19.md` or create the next dated validation report.

**Interfaces:**
- Produces a machine-readable acceptance report with browser, viewport, module, assertion counts, failures, and runtime commit/artifact identity.
- Produces tests for out-of-order requests, auth expiry, provider degradation, retry, offline recovery, and queue failure.

- [ ] Extend the matrix to 320/375/390/768/1024/1440 across every module in Edge, Firefox, and WebKit.
- [ ] Capture page errors, console errors, hydration warnings, failed requests, horizontal overflow, clipped controls, overlap, touch sizes, focus behavior, and duplicate visible content.
- [ ] Exercise authenticated create/edit/delete, denied anonymous/other-tenant writes, long-running jobs, cancellation, retry, SSE reconnect across replicas, and provider 429/5xx/timeout behavior.
- [ ] Use controlled delayed responses to prove stale farm/location results cannot replace current context and pushes cannot regress after older GETs.
- [ ] Start the production Compose stack from an empty PostgreSQL volume; run migrations, seed, readiness, API smoke tests, browser tests, backup, and restore drill.
- [ ] Report exact pass/fail evidence and any unexecuted physical-device or external-provider checks; do not claim certification beyond the executed matrix.

## Execution order

1. Tasks 1–3 establish a reproducible PostgreSQL foundation and safe migration.
2. Tasks 4–5 remove shared-state and authorization vulnerabilities before enabling replicas.
3. Tasks 6–7 introduce durable jobs and replica-safe delivery.
4. Tasks 8–9 repair client correctness and mobile/accessibility behavior.
5. Task 10 deploys the complete stack with observability and rollback.
6. Task 11 is the final release gate and must run against the built production artifact, not the development server.

## Self-review

- Every approved architecture section maps to at least one task.
- No task relies on SQLite for production or process-local state for cross-replica correctness.
- Tasks 3 and 10 explicitly preserve rollback data; neither deletes source data automatically.
- Task 11 covers the frontend audit's stale-result, farm-draft, location-scope, hydration, mobile, accessibility, and browser-matrix findings.
- Commits are intentionally absent because the user has not requested them.

# TerraField Atlas Production Scale Design

Date: 2026-11-24

## Goal

Make TerraField Atlas safe for verified-account production writes on a self-hosted VPS, with shared durable state, stateless web replicas, durable background jobs, cross-replica realtime delivery, mobile-safe UI, and verified rollback.

## Approved architecture

- Docker Compose on the existing VPS.
- PostgreSQL/PostGIS for durable application and spatial data.
- Redis for shared cache, rate limits, circuit state, sessions, BullMQ, and pub/sub.
- At least two stateless Next.js web replicas behind Caddy.
- Separate worker and database-leased scheduler services.
- Brief write-freeze maintenance window for SQLite cutover.
- Verified accounts required for every mutation; seeded data is public and read-only.
- Administrator role required for operational actions.

The VPS remains a single infrastructure failure domain. This design permits horizontal application scaling but does not claim VPS high availability.

## Verified baseline

- `bun test tests src/components/three/live-globe-events.test.ts`: 232 pass, 0 fail.
- `bun run build`: passes and emits 41 static/dynamic application pages plus API routes.
- `bun run lint`: fails with 21 errors in CommonJS browser/verification scripts.
- Production runtime against the current local SQLite database returns HTTP 500 for farms, watchlists, and provenance because account columns are missing.
- CodeRabbit CLI is not installed.

## Release blockers

1. Deployment and runtime use different database paths; production schema changes use `db:push --accept-data-loss`; no complete migration baseline exists.
2. Public Caddy accepts a query-controlled localhost proxy port.
3. Anonymous mutations can modify seeded records.
4. Cache invalidation and forced probes lack authorization; forced probes lack throttling and coalescing.
5. FNV-1s 32-bit cache keys can substitute data across coordinates.
6. Request bodies, result sets, provider work, and rate-limit buckets are unbounded or insufficiently bounded.
7. Multi-step mutations, audit records, evaluation status, and jobs are not transactional or idempotent.
8. Inline jobs have no durable recovery, whole-operation deadline, or bounded concurrency.
9. Backtests can overwrite current watchlist status; manual and scheduled evaluations can race.
10. Push state can be overwritten by stale GETs; scheduler/digest selection can use the wrong triggering event.
11. Farm editors can retain one farm's draft after switching farms; free-location observation queries can return all locations; mutation results can appear under a newer selection.
12. Narrow layouts clip watchlist bars and landing tables; map controls overlap; geography selection can target the wrong place.
13. Contrast, touch targets, keyboard shortcuts, tour modality, hydration, and mutually exclusive query states need correction.
14. Existing browser coverage omits most modules, 320/375 widths, hydration errors, overlap, focus, and out-of-order responses.

## Data requirements

- Prisma PostgreSQL provider with PostGIS enabled and a complete initial migration.
- Preserve IDs, owner IDs, timestamps, nulls, and source semantics during import.
- Add indexes derived from actual tenant and query predicates.
- Enforce uniqueness for tenant-scoped idempotency and scenario names.
- Date-partition high-volume observation, fire, and provenance ledgers where supported by the migration and query paths.
- Maintain retention/archival policy and verify backups with restore drills.
- Do not shard a single PostgreSQL node. Revisit sharding only after measured capacity thresholds require it.

## API and job requirements

- Uniform success/error envelopes, correlation headers, status semantics, strict calendar/range validation, request byte limits, pagination, and row limits.
- Verified-account authorization for writes; immutable seeded records; administrator authorization for diagnostics actions.
- Tenant/route/idempotency-key uniqueness with request fingerprint and replay of the original result.
- Transactions cover domain mutation, audit row, job creation, and outbox insertion. Provider calls remain outside transactions.
- Long-running operations return 202 and run through BullMQ with heartbeat leases, stale recovery, deadlines, cancellation, bounded per-tenant/global concurrency, and idempotent persistence.
- Redis-backed token buckets, caches keyed by SHA-256/canonical inputs, circuit state, and single-flight refreshes.
- Exponential backoff with jitter; honor Retry-After; retry only transient failures; never automatically replay unsafe mutations without idempotency.

## Realtime and delivery requirements

- Redis pub/sub fans out SSE events to all web replicas.
- A database lease elects one scheduler leader.
- Transactional outbox prevents committed state changes from losing notification work.
- Delivery workers use stable event/idempotency identifiers and durable deduplication.
- Outbound webhooks disable redirects or revalidate every redirect destination and DNS result; reject private/link-local/metadata targets unless explicitly allowlisted.
- Email and webhook retries honor provider throttling and expose protected operational diagnostics.
- Backtests append history but do not change current status. Evaluation leases/version checks reject stale completions.

## Frontend requirements

- Production-mode Chromium/Edge, Firefox, and WebKit checks at 320, 375, 390, 768, 1024, and 1440 widths across all modules.
- No horizontal page overflow, clipped actionable content, overlapping map controls, inaccessible dialogs, or sub-44px coarse-pointer primary actions.
- Normal text meets WCAG AA contrast; focus is visible and restored; charts have mobile labels and text alternatives.
- Loading, empty, error, offline, and success states are mutually exclusive and actionable.
- Results carry farm/location/input context; context changes cancel or invalidate stale work.
- Farm editors are keyed by farm ID; location queries always include the selected coordinates.
- Transport combines caller cancellation with timeout, owns retries in one layer, honors Retry-After, and rejects malformed successful payloads.
- Persisted client state hydrates after mount; console and marketing footers are not duplicated.

## Deployment and verification requirements

- Private database/Redis networks; Caddy is the only public listener and exposes fixed upstreams only.
- CI uses a real PostgreSQL service and verifies fresh migration, upgrade migration, tests, lint, build, and browser flows.
- Deploy order: build artifact, backup, write freeze, migration, row validation, service replacement, readiness, API smoke tests, browser smoke tests.
- Failed post-cutover checks restore the prior artifact and database snapshot.
- Readiness validates schema/seed baseline, database connectivity, scheduler heartbeat/leadership, queue/worker health, and Redis; public health responses do not leak infrastructure errors.
- Structured logs, metrics, dashboards, alert rules, log rotation, container resource limits, nightly backups, and restore drills are required.
- Documentation must replace stale claims that authentication, push delivery, and horizontal scaling limitations are absent.

## Out of scope

- Kubernetes, multi-VPS high availability, multi-region deployment, database sharding, physical-device certification, and guaranteed indexing/ranking.
- Scientific provider credentials or data products that remain externally unavailable; the UI must continue to show honest degraded/not-configured states.

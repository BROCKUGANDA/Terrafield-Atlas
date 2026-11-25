# TerraField Atlas production architecture

## Topology

```text
Browser
  │ HTTPS / same-origin API + SSE
  ▼
Caddy (only public listener: 80/443)
  ├─ web:3000
  └─ web-secondary:3000
       │
       ├─ PostgreSQL 16 + PostGIS (durable domain state)
       ├─ Redis 7 (cache, rate limits, circuits, pub/sub, BullMQ)
       ├─ worker (durable jobs, leases, retries, stale recovery)
       ├─ scheduler (PostgreSQL leadership lease, per-watchlist leases)
       └─ outbox (Redis SSE fan-out + durable webhook/email delivery)

Prometheus and Grafana run on the private Docker network.
```

The VPS remains one infrastructure failure domain. Two stateless web replicas permit horizontal application scaling, but this design does not claim multi-VPS or multi-region high availability.

## Data and migrations

- Prisma uses PostgreSQL; PostGIS is enabled by `deploy/postgres/init.sql` and the initial migration.
- `prisma migrate deploy` is the only production schema command. `db:push --accept-data-loss` is not used in deployment.
- `scripts/migrate-sqlite-to-postgres.ts` preserves IDs, owners, timestamps, nulls and Unicode for the legacy cutover.
- `scripts/validate-migration.ts` compares table counts and canonical sampled hashes before activation.
- Nightly `pg_dump -Fc` artifacts are checksummed; `deploy/restore-drill.sh` restores a named artifact into a disposable database and drops it after verification.

## API correctness

- Every domain mutation requires a verified account except the HMAC-authenticated inbound webhook. Public `ownerId: null` seed rows are read-only.
- Administrator capability is required for cache invalidation, forced provider probes and queue diagnostics.
- Request bodies are capped at 128 KiB and parsed as strict UTF-8 JSON. Dates are real calendar dates; ranges are ordered; arrays are bounded and deduplicated.
- Mutations require `Idempotency-Key`; tenant/route/key records store canonical request fingerprints and replay the original response. Conflicting fingerprints return `409`.
- Domain rows, audit rows, outbox events, job rows and response references commit atomically. Provider calls always occur before transactions.
- Errors use `{ error: { code, message, correlationId, details? } }`; responses carry `X-Correlation-Id` and `Cache-Control: private, no-store`.

## Durable jobs

`ProcessingJob` is the durable ledger; BullMQ carries only a pointer. Enqueue commits the job and `job.enqueued` outbox event before publishing to Redis. Workers use database leases, heartbeat renewal, deadlines, cooperative cancellation, exponential retry and stale-running recovery. Redis semaphores enforce global and per-tenant concurrency. Provider persistence uses natural-key upserts.

Long-running ingestion, trends, fire snapshots and watchlist evaluation return `202` with `/api/v1/analysis/jobs/{id}`. Protected queue metrics expose depth, oldest age, retries, failures, dead letters and worker heartbeats.

## Replica-safe scheduling and delivery

- A PostgreSQL `JobLease` elects one scheduler leader. Only the leader ticks; lease heartbeat and expiry make failover safe.
- Each watchlist evaluation holds a separate lease and commits through a monotonic `evaluationVersion` compare-and-swap. A stale provider response cannot overwrite newer status.
- Backtests append history but never change current live status.
- Digest events use a transactional outbox. Redis pub/sub fans committed events to SSE sinks on every web replica; private streams revalidate the owner session and enforce backpressure/caps.
- Digest reads fetch newest rows before applying the 200-row cap and carry an explicit triggering event identity.
- Webhook/email delivery uses stable outbox event IDs, durable `DeliveryReceipt` deduplication, transient-only retry and explicit destination validation. Webhooks disable redirects and reject private/link-local/metadata DNS results unless explicitly allowlisted.

## Client correctness

- One transport layer combines caller cancellation with a timeout, retries GET/HEAD once, honors `Retry-After`, and rejects malformed 2xx JSON.
- Every mutation receives an idempotency key and is never auto-retried.
- Results carry farm/location/input context; late results are discarded after the selection changes.
- Push handling cancels older digest GETs, deduplicates stable event IDs and rejects out-of-order pushes.
- Zustand persistence hydrates after mount. Farm crop/soil editors are keyed by farm ID and malformed stored JSON is ignored safely.

## Readiness and observability

`GET /api/v1/readyz` fails closed on missing schema/migrations, empty seed baseline, unavailable PostgreSQL/Redis, stale scheduler leadership or missing worker heartbeats. Public details are generic and redacted.

`GET /api/v1/metrics` is available only on the private container network; Caddy returns `403` publicly. Prometheus scrapes both web replicas. Metrics cover HTTP count/latency, database/Redis availability, queue depth/age/retries/failures, scheduler leadership, worker heartbeats and SSE subscribers. Grafana dashboards and alert rules are provisioned from `deploy/`.

## Security and operations

- Caddy exposes fixed upstreams only; no query-controlled proxy target remains.
- An enforced CSP ships from `src/middleware.ts` (static pages keep `'unsafe-inline'` scripts); violations go to the bounded `/api/v1/csp-report` intake and are logged, not stored.
- Production runs the standalone server under `terrafield.service` from the 600-mode `.env`; `scripts/deploy-vps.sh` ships, backs up, migrates, builds, restarts and gates readiness with automatic restore of the previous build.
- Database, Redis, Prometheus and Grafana publish no host ports.
- Containers use JSON logging with rotation, restart policies and resource limits.
- Release automation builds one image, takes a named backup, deploys migrations, waits for readiness/API checks and restores the prior image/database snapshot on failure.
- No secrets are stored in source, fixtures, browser bundles or committed environment files.

## Enterprise product layer

- Organizations and memberships are enforced both by API guards and PostgreSQL RLS. Web replicas run as `terrafield_app`; request handlers set transaction-local tenant context through a Prisma proxy.
- Configurable plans drive server-side quotas for farms, jobs, API requests, reports, intelligence runs, and storage. Only fulfilled operations are metered.
- Developer API keys are hashed at rest, scoped, revocable, and rate-limited; OpenAPI is served at `/api/v1/openapi.json`.
- Tenant webhooks use encrypted signing secrets, DNS-aware SSRF checks, no redirects, signed exact body bytes, and durable retry records.
- Intelligence plans are deterministic, permission-controlled, and approval-gated; every tool execution and evidence reference is persisted.
- A private `raster` service computes GeoTIFF/NetCDF/Zarr statistics and persists derived artifacts to a named volume; the database stores the artifact reference and lineage.
- Server-side PDF, CSV, JSON, and persisted report records are available.

## Verification

- `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:integration`, and `bun run build` are independent gates.
- PostgreSQL/Redis integration suites use disposable schemas and namespaces.
- Production browser acceptance runs against the built Compose artifact in Chromium/Edge, Firefox and WebKit at 320/375/390/768/1024/1440 widths. Physical-device certification and external-provider guarantees are not claimed.

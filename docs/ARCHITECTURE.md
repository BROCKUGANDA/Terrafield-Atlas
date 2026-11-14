# Architecture

## System overview

```
Browser (SPA at "/", 10 views)
  │  TanStack Query + Zustand + Zod
  ▼
Next.js route handlers  /api/v1/*            ← typed contracts, validation, rate limits,
  │                                            correlation IDs, structured errors
  ├─ lib/adapters/power.ts        ─── NASA POWER Daily API (public)
  ├─ lib/adapters/gibsLayers.ts   ─── NASA GIBS WMTS raster layers (browser-side tiles)
  ├─ lib/adapters/gibsFires.ts    ─── NASA GIBS VIIRS 375 m MVT (server-side decode)
  ├─ lib/adapters/soilgrids.ts    ─── ISRIC SoilGrids v2.0 point REST (supplementary)
  ├─ lib/adapters/firms.ts        ─── NASA FIRMS CSV (env-gated; host unreachable here)
  ├─ lib/stats/*                  ─── trend engine (MK / Theil-Sen / BH-FDR)
  ├─ lib/crops/*                  ─── FAO-cited catalogue + rotation engine
  ▼
Prisma + SQLite (provenance-first schema)
  ▲
lib/http.ts — resilient fetch: retry + backoff + circuit breakers + request ledger
```

## API contracts (v1)

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/api/v1/health` | GET | service + provider health (cheap, no external calls) |
| `/api/v1/regions` | GET | curated real-region demo presets |
| `/api/v1/farms` | GET, POST | farm list / create (validated GeoJSON boundary) |
| `/api/v1/farms/{id}` | GET, PATCH | farm profile, boundary, crop history |
| `/api/v1/farms/{id}/soil-tests` | GET, POST | farmer/lab soil measurements |
| `/api/v1/farms/{id}/soil-tests/soilgrids` | POST | supplementary modeled profile (graceful 502 on provider failure) |
| `/api/v1/observations` | GET | stored real observations, filtered |
| `/api/v1/observations/ingest` | POST | idempotent POWER ingestion (job-tracked, 5-year chunks) |
| `/api/v1/observations/sources` | GET | data-source register + GIBS map-layer registry |
| `/api/v1/analysis/trends` | POST | full trend pipeline over stored observations |
| `/api/v1/analysis/jobs/{id}` | GET | job status retrieval |
| `/api/v1/rotation/scenarios` | GET, POST | evaluate + persist a scenario |
| `/api/v1/rotation/compare` | POST | evaluate multiple alternatives under identical context |
| `/api/v1/crops` | GET | versioned crop catalogue with citations |
| `/api/v1/fires` | GET, POST | stored detections / ingest real VIIRS detections (≤ 40 days) |
| `/api/v1/provenance` | GET | API request ledger + sources + recent analyses |
| `/api/v1/reports` | POST | compiled farm assessment (printable) |
| `/api/v1/system/status` | GET, POST | diagnostics; cache invalidation |

Every endpoint returns a correlation ID header; errors use the envelope
`{ error: { code, message, correlationId, details? } }` with correct status codes
(400 validation, 404 unknown, 409 not-ingested, 429 rate-limited, 502 provider-unavailable —
which **never** substitutes fabricated data).

## Reliability model

- **Retry policy**: exponential backoff with full jitter (500 ms × 2^n ± random), max 3 attempts, transient-only (network/timeout/429/5xx). Permanent 4xx fails fast.
- **Circuit breakers**: per provider; open after 4 consecutive failures for 60 s. Surfaced in System Health.
- **Idempotent ingestion**: POWER rows are keyed on (lat, lon, variable, date) with an existence-filter before insert (SQLite lacks `skipDuplicates`); fire detections keyed on (lat, lon, date, time, uid) with in-batch dedup.
- **Request dedup + caching**: TTL memory cache (6 h POWER, 12 h fire tiles, 24 h SoilGrids). The cache interface mirrors a Redis store so the backend can be swapped without touching call sites.
- **Provenance ledger**: every external request (attempts included) is logged to `ApiRequestLog` with provider, operation, URL, status, latency, bytes, correlation ID.
- **Partial-data reporting**: POWER fill values become `null` (never 0, never dropped); short months (< 20 valid days) are excluded and counted as missing; fire archive gap days are reported explicitly.

## Security

- No API credentials in the frontend bundle: `FIRMS_MAP_KEY` is read server-side only; the FIRMS endpoint is proxied through our API routes.
- All request bodies are Zod-validated (bounds on every numeric field, string length caps, GeoJSON structural validation).
- Safe GeoJSON parsing: JSON.parse in a try/catch, ring closure, vertex caps, coordinate range checks, self-intersection detection, area ceiling, holes rejected.
- Prisma parameterized queries throughout (no string-built SQL).
- Rate limiting: in-memory token bucket per IP+route (documented single-process limitation; interface is Redis-swappable).
- Audit events for farm/soil/scenario mutations.
- CORS: same-origin only (the SPA talks to relative `/api/v1/*` paths through the gateway).

## Documented deviation: runtime topology

The original engineering brief suggested FastAPI + PostgreSQL/PostGIS + Redis + Celery. The challenge deployment sandbox provides **one** Node process, SQLite, and no message broker or additional ports for stateful services (the only externally exposed port is 3000 via the gateway). Replacing a working single-runtime application with a five-service cluster to satisfy a preferred framework list would violate the brief's own rule ("Never replace an entire working application to introduce a preferred framework" / "Do not add infrastructure that does not solve an actual requirement"). The implemented topology preserves the required *behaviors*: typed contracts, validation, provenance, retries, circuit breakers, idempotency, rate limits and a job ledger. Scaling to the reference topology is a swap of: route handlers → FastAPI controllers (same contracts), Prisma/SQLite → PostGIS (same schema plus geometry columns), in-memory cache → Redis (same interface), ProcessingJob table → Celery workers (same statuses).

## Testing strategy

- **Unit (54 tests, `bun test`)**: Mann-Kendall S/variance/ties/Hamed-Rao, Theil-Sen slope + Sen CI, seasonal MK (seasonality trap, zero-variance), BH-FDR canonical example, POWER request validation, GeoJSON rejection paths, monthly aggregation rules, trend-engine honesty paths, rotation-engine determinism/missing-data/incompatibility flags, catalogue citation integrity. Fixtures only — no network.
- **Live smoke (`bun scripts/live-smoke.mjs`)**: 9 checks against the real POWER, GIBS (raster, NDVI, SMAP, fire MVT decode, Domains), SoilGrids (supplementary-tolerated) and FIRMS (honest negative test), plus the platform health endpoint.
- **In-browser verification**: golden-path exercise documented in the run log (map → ingest → trends → farm → rotation → fire → report).

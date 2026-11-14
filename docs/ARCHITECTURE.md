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
| `/api/v1/fires/watchlists` | GET, POST | regional fire-alert watchlists (list with last evaluation / create, optional re-evaluation cadence) |
| `/api/v1/fires/watchlists/{id}` | GET, PATCH, DELETE | watchlist detail + event history / edit rule (resets status to unverified) + re-evaluation cadence / delete (events cascade) |
| `/api/v1/fires/watchlists/{id}/evaluate` | POST | LIVE evaluation or BACKTEST (body `{ end: 'YYYY-MM-DD' }` pins the window to a historical date): ensures per-day GIBS VIIRS archive coverage, computes clear/watch/alert from stored real detections, records a FireWatchEvent flagged with its trigger |
| `/api/v1/fires/watchlists/{id}/runs` | GET | scheduler-run history for one watchlist: the scheduler's audit ledger (successes AND failures) merged with the matching FireWatchEvents on correlationId |
| `/api/v1/fires/watchlists/{id}/digest` | GET | cadence-aware alert digest: window derives from the watchlist's re-evaluation cadence (default 24 h for manual lists, `?hours=1..720` override); compares the window with the equal-length previous one (status path, peak detections, alert entries/exits, failed runs, archive gaps) — delivered on demand here AND pushed live over the digest stream |
| `/api/v1/fires/watchlists/digest-stream` | GET | push-style digest delivery channel (Server-Sent Events, the push channel the topology now has): one held-open response on the single HTTP port — `retry: 5000`, `channel.hello`, 25 s keepalive comments, then `watchlist.digest` frames carrying the whole cadence-aware digest, recomputed and pushed to EVERY open console the instant an evaluation event lands or a scheduled run fails; no replay buffer (missed frames remain available from the digest endpoint), client cap 12 → 503 + Retry-After, `DIGEST_PUSH_OFF=1` disables |
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

## Fire watchlists (regional alert rules)

Standing regional fire alerts built entirely on stored real detections:

- **Model**: `FireWatchlist` (center, radius 5–25 km, confidence floor, lookback 3–30 days, alert threshold, re-evaluation cadence) + `FireWatchEvent` (one row per evaluation — the alert history, flagged manual/backtest/scheduled) + `FireCoverageDay` (per-(region, date) ledger of "we actually asked GIBS", with the bbox that was checked).
- **Evaluation** (`POST …/evaluate`): for every day in the window, coverage is ensured — days never asked, or asked with a narrower bbox, are fetched live from the GIBS VIIRS 375 m stream and persisted idempotently; the status is then computed by a pure engine from stored rows only. Archive-gap days are reported as no-data, never zero-filled. One shared pipeline (`lib/fires/watchlist-evaluate.ts`) serves every trigger: manual, backtest and scheduled.
- **Backtest**: the Evaluate action carries a date picker. Any historical window end inside the VIIRS archive replays the exact rule against the real archive as it stood and stores a normal `FireWatchEvent` with `trigger=backtest` — nothing is simulated. An end date whose lookback window would start before the archive (`2015-01-01`) is rejected with the minimum usable date, so a backtest can never report a guaranteed-unverified window.
- **Scheduled re-evaluation**: watchlists opt in per list to a cadence (6 h / 12 h / 24 h). The in-process scheduler (`lib/scheduler.ts`, started from `instrumentation.ts`) ticks every 60 s, claims due lists by advancing `nextReevaluateAt` BEFORE running (a crash can never hot-loop a failing evaluation), runs at most 5 evaluations per tick sequentially, skips lists already in flight, writes every run to the audit ledger (`watchlist.schedule.run` / `watchlist.schedule.fail`), and reports its live state in `/api/v1/system/status` and System Health. `WATCH_SCHEDULER_OFF=1` disables it entirely.
- **Scheduler-run history** (`GET …/runs`): the scheduler's audit ledger for one watchlist, merged with its evaluation events — successes join their `FireWatchEvent` on the shared correlationId (full window, per-day counts, rationale); failures exist ONLY in the ledger (no status was ever computed) and are listed with their error messages. Counts cover the whole ledger; entries are capped at the newest 50. Pure merge logic in `lib/fires/watchlist-runs.ts` (unit-tested); the console exposes it as the per-card Runs panel, and pulling a ledger with failures raises a warn entry in the mission log.
- **Cadence-aware alert digests** (`GET …/digest`): the digest window DERIVES from the watchlist's own cadence (6 h list → 6 h digest; manual lists default 24 h; `?hours=1..720` overrides, `windowSource` reports which). The current window is compared with the EQUAL-LENGTH window before it — end-exclusive boundary, so no evaluation is ever counted twice: status path and transitions, peak qualifying detections with delta, alert entered/cleared/held, failed scheduled runs, archive-gap days. Pure engine in `lib/fires/watchlist-digest.ts` (unit-tested); the shared computation service (`lib/fires/watchlist-digest-service.ts`) feeds both the REST route and the push path.
- **Push-style digest delivery** (`GET …/digest-stream`, SSE — the channel the topology now has): the channel the topology previously lacked is now real — a Server-Sent Events stream on the ONE exposed HTTP port (same-origin, through the gateway, no broker/no extra port — the same move the in-process scheduler made for Celery). Wire: `retry: 5000` reconnect hint → `channel.hello` (connection id, live subscriber + scheduler facts) → `: keepalive` comments every 25 s → `watchlist.digest` frames. Every completed evaluation (manual, backtest, scheduled — published fire-and-forget from the shared evaluation core, so delivery can never fail an evaluation) and every failed scheduled run (published from the scheduler's ledger write) recomputes the watchlist's cadence-aware digest through the SAME service the REST route uses and writes the whole payload to every open console. Zero subscribers → the publish path touches no database; a deleted-mid-push watchlist is skipped honestly; dead streams are evicted mid-publish; cap 12 concurrent connections (503 + Retry-After above it); no replay buffer — a reconnect starts a fresh hello and missed frames stay available from the per-watchlist digest endpoint; `DIGEST_PUSH_OFF=1` disables (the route then opens, sends `channel.disabled` and closes so clients stop reconnecting). Pure engine in `lib/fires/digest-push.ts` (unit-tested: wire bytes, hub delivery/eviction/caps/counters, payload builders), runtime in `lib/fires/digest-channel.ts` (globalThis singleton, HMR-safe), surfaced in `/api/v1/system/status` and System Health.
- **Status semantics (honesty-first)**: `alert` = qualifying detections ≥ threshold; `watch` = ≥ ceil(threshold/2) OR partial coverage with real detections; `clear` requires complete coverage; `unverified` = nothing checked yet. Editing rule parameters resets the stored status to `unverified`.
- **Console integration**: cards in Fire Intelligence (evaluate / backtest / edit / delete, per-day bars, rationale, cadence + next-run line, trigger chip on the last evaluation, per-card scheduler-run history panel and cadence-aware digest popover with its last push timestamp), a header alert chip visible from any module while any watchlist alerts (push-accelerated: digest pushes invalidate the rows instantly; the DB-only 120 s poll remains the fallback), a live push-channel chip in the watchlists header, a console-wide EventSource subscription (app shell) that writes pushed digests straight into the popover's cache key and toasts/mission-logs scheduler-driven pushes, counts in System Health plus a scheduler panel (tick health, next due, last runs) and a digest-channel panel (open consoles, frames delivered, last event).
- **Operational note**: `FireWatchlist`/`FireWatchEvent` datetimes are Prisma-managed ISO strings in SQLite. Writing them through anything other than Prisma (e.g. raw `sqlite3` with `YYYY-MM-DD HH:MM:SS` formatting) poisons the row for Prisma reads (`P2023 Inconsistent column data`) — always write via Prisma or use full `YYYY-MM-DDTHH:MM:SS.sssZ`.

## Guided first-run tour

A 17-step walkthrough (`src/lib/tour-steps.ts`) that drives the real console: steps switch modules, wait for their `[data-tour]` target element to mount (async data, view-swap animation) with a patience fallback to a centered card, spotlight it with a box-shadow mask, and track scroll/resize/DOM mutations. State persists per browser keyed by a `TOUR_VERSION` (a version bump re-offers the tour once). Offered automatically on the operator's first login; restartable via System Health → Operations, the ⌘K palette, or the `T` hotkey. Keyboard: ←/→ navigate, Esc skips.

## Security

- No API credentials in the frontend bundle: `FIRMS_MAP_KEY` is read server-side only; the FIRMS endpoint is proxied through our API routes.
- All request bodies are Zod-validated (bounds on every numeric field, string length caps, GeoJSON structural validation).
- Safe GeoJSON parsing: JSON.parse in a try/catch, ring closure, vertex caps, coordinate range checks, self-intersection detection, area ceiling, holes rejected.
- Prisma parameterized queries throughout (no string-built SQL).
- Rate limiting: in-memory token bucket per IP+route (documented single-process limitation; interface is Redis-swappable).
- Audit events for farm/soil/scenario mutations.
- CORS: same-origin only (the SPA talks to relative `/api/v1/*` paths through the gateway).

## Documented deviation: runtime topology

The original engineering brief suggested FastAPI + PostgreSQL/PostGIS + Redis + Celery. The challenge deployment sandbox provides **one** Node process, SQLite, and no message broker or additional ports for stateful services (the only externally exposed port is 3000 via the gateway). Replacing a working single-runtime application with a five-service cluster to satisfy a preferred framework list would violate the brief's own rule ("Never replace an entire working application to introduce a preferred framework" / "Do not add infrastructure that does not solve an actual requirement"). The implemented topology preserves the required *behaviors*: typed contracts, validation, provenance, retries, circuit breakers, idempotency, rate limits and a job ledger. The one behavior that normally requires Celery — scheduled re-evaluation of fire watchlists — is served by a real in-process scheduler (interval timer started at boot via `instrumentation.ts`, claim-before-run, per-tick run budget, audit trail); it needs no broker, no extra port and no second process, and the cadence is opt-in per watchlist so idle deployments generate zero provider traffic. The one behavior that normally requires a message/websocket tier — push-style digest delivery — is served by a real Server-Sent Events channel on the single exposed HTTP port (held-open responses through the existing gateway, server-side publish the moment a digest-relevant fact lands, browser EventSource with auto-reconnect; no broker, no extra port). Scaling to the reference topology is a swap of: route handlers → FastAPI controllers (same contracts), Prisma/SQLite → PostGIS (same schema plus geometry columns), in-memory cache → Redis (same interface), ProcessingJob table + in-process scheduler → Celery workers (same statuses, same claim semantics), SSE channel → broker-backed push (same event payloads, same `watchlist.digest` contract).

## Testing strategy

- **Unit (115 tests, `bun test`)**: Mann-Kendall S/variance/ties/Hamed-Rao, Theil-Sen slope + Sen CI, seasonal MK (seasonality trap, zero-variance), BH-FDR canonical example, POWER request validation, GeoJSON rejection paths, monthly aggregation rules, trend-engine honesty paths, rotation-engine determinism/missing-data/incompatibility flags, catalogue citation integrity, watchlist-engine status semantics (alert/watch/clear/unverified boundaries, confidence floors, coverage gaps, window math), backtest date validation (future/archive-start/full-window-inside-archive boundaries, UTC day math), the scheduler core (cadence membership, due selection order, claim-before-run, failure handling without hot-loop, in-flight skips, per-tick budget), the scheduler-run history merge + cadence-aware digest engine (ledger parsing/degradation, correlationId join, caps, window boundary no-double-count, status paths, peak deltas, alert entries/exits, failure and archive-gap reporting, no leaked `undefined`/`NaN` in digest prose) and the digest push channel engine (SSE wire bytes, escaped-newline single-line data, dead-sink eviction, register/unregister delivery, client cap with retry hint and slot reuse, counters, payload builders incl. scheduled-failure trigger honesty). Fixtures only — no network.
- **Live smoke (`bun scripts/live-smoke.mjs`)**: 9 checks against the real POWER, GIBS (raster, NDVI, SMAP, fire MVT decode, Domains), SoilGrids (supplementary-tolerated) and FIRMS (honest negative test), plus the platform health endpoint.
- **In-browser verification**: golden-path exercise documented in the run log (map → ingest → trends → farm → rotation → fire → report).

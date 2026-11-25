# TerraField Atlas

[![CodSpeed](https://img.shields.io/endpoint?url=https://codspeed.io/badge.json)](https://app.codspeed.io/BROCKUGANDA/Terrafield-Atlas?utm_source=badge)

**NASA Earth Intelligence, Agricultural Resilience & Geospatial Decision Support**
Built for the 2026 NASA Space Apps Challenge — primary challenge: **Field Shift: Adapting Farms with NASA Data**; related capabilities: *Be An Earth System Trend Detective!* and *Harmonization of MODIS and VIIRS Hot Spots*.

TerraField Atlas is a real-data application: farmers, cooperatives, researchers and extension officers can explore what NASA satellites observe about a location (rainfall, temperature, radiation, humidity, root-zone wetness, vegetation, fire history), test whether changes are statistically meaningful, and compare crop-rotation options in which every score is explainable and every observation is traceable to its source.

---

## Core engineering principle

> Every recommendation must have evidence, every observation must have provenance, every score must have an explainable calculation, and every operational feature must actually work.

Concretely enforced in the codebase:

- No synthetic observations are ever written to the observation store; missing days are counted and surfaced, never imputed.
- Environmental correlations are never presented as proof of agricultural causation.
- No yield or profit prediction exists anywhere.
- Modeled SoilGrids values never silently substitute measured soil tests.
- Every external API request (success or failure) is logged in the provenance ledger with status, latency and retrieval time.

## Quickstart (public demo)

The demo needs **no signup**:

1. Open the application (the preview panel / deployed URL). A **17-step guided tour** starts automatically on first login — or restart it any time with the `T` key, System Health → Operations, or the ⌘K palette.
2. **Overview** page → *Explore satellite data*.
3. **Geospatial Explorer** — toggle MODIS true color, MOD13Q1 NDVI (16-day), SMAP L4 soil-moisture layers; pick any date; draw a farm boundary.
4. **Earth Intelligence** — ingest the 12-year NASA POWER record for the selected location (~10–30 s, real MERRA-2 data).
5. **Environmental Analysis** — run the trend pipeline (seasonal Mann-Kendall, Theil-Sen, FDR).
6. **Farm Workspace** — create a farm, enter a soil test (or fetch the supplementary SoilGrids profile).
7. **Rotation Planner** — build scenarios, set priorities, compare alternatives with full factor-level explanations.
8. **Fire Intelligence** — ingest real VIIRS 375 m detections (region presets now cover the fire-active geographies — Zambia Central miombo, Rondônia Amazon frontier, Top End savanna, San Joaquin/Sierra foothills — each carrying its real fire season), view the fire calendar, and set up **regional fire watchlists**: pick a geography, radius, confidence floor and threshold; *Evaluate now* checks every uncovered day against the live VIIRS archive and reports clear / watch / alert from real detections only (a red header chip surfaces alerts from anywhere in the console). Every completed evaluation and every scheduler failure is **pushed live** to the console as a cadence-aware digest over the Server-Sent-Events channel (the `push live` chip in the watchlists header shows the connection) — and, when armed, over the **webhook exit** (HMAC-signed POST) and the **email exit** (SMTP, scheduler facts only).
9. **Reports** — compile and print the farm assessment (browser print → PDF).
10. **Evidence & Provenance / System Health** — inspect the request ledger, source register and diagnostics.

## Stack

| Layer | Choice | Note |
| --- | --- | --- |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, shadcn/ui | SPA on a single `/` route with view switching |
| State | Zustand (session), TanStack Query (server state) | |
| Map | MapLibre GL + NASA GIBS WMTS raster tiles | live NASA imagery |
| Charts | Recharts | scientific series with trend overlays |
| Validation | Zod (both directions) | every API request and response |
| Backend | Next.js route handlers under `/api/v1/*` | typed, versioned, rate-limited, correlation IDs |
| Data | Prisma + PostgreSQL 16 + PostGIS | durable schema; `prisma migrate deploy` |
| Shared runtime | Redis 7 | cache, limits, circuits, pub/sub and BullMQ |
| Jobs | Durable `ProcessingJob` ledger + BullMQ workers | leases, retries, deadlines and stale recovery |
| Statistics | Custom TypeScript implementations of Mann-Kendall / Theil-Sen / BH-FDR | cross-checked against the R `modifiedmk` reference implementation |

**Production topology:** two stateless Next.js replicas behind Caddy, PostgreSQL/PostGIS, Redis, separate BullMQ worker/scheduler/outbox services, and private Prometheus/Grafana. The VPS remains a single failure domain; see `docs/ARCHITECTURE.md` and `docs/LIMITATIONS.md`.

## Commands

```bash
bun run dev                 # local Next.js development
bun run lint                # ESLint
bun run typecheck           # TypeScript
bun test tests/             # unit + focused integration suites
bun run test:integration    # PostgreSQL/Redis integration suites
bun run db:migrate:deploy   # production schema migration
bun run db:seed             # idempotent production baseline
bun run build               # production build

docker compose up -d --wait  # full private Compose stack (requires .env)
./deploy/backup.sh
./deploy/restore-drill.sh /var/backups/terrafield/<named-artifact>.dump
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection URL; SQLite is only a legacy migration source |
| `REDIS_URL` | yes | Redis connection URL for shared state, pub/sub and BullMQ |
| `NEXTAUTH_SECRET` / `NEXTAUTH_URL` / `NEXT_PUBLIC_SITE_URL` | yes | verified-account session secret, canonical auth origin and public site origin |
| `POSTGRES_PASSWORD` / `DOMAIN` / `ACME_EMAIL` | production | Compose database credential, Caddy hostname and TLS email |
| `GRAFANA_ADMIN_PASSWORD` | production | private monitoring administrator password |
| `FIRMS_MAP_KEY` | no | enables the FIRMS CSV adapter (free NASA registration). Without it the adapter reports `credentials-not-configured` and fire features are served from the GIBS VIIRS stream (same detections). The key is server-side only and never exposed to the client. |
| `WATCH_SCHEDULER_OFF` | no | web replicas set `=1`; the dedicated database-leased scheduler service sets `=0`. |
| `DIGEST_PUSH_OFF` | no | `=1` disables the SSE digest push channel (digests remain available on demand from `GET …/digest`). |
| `DIGEST_WEBHOOK_URL` | no | arms the **webhook digest exit**: every digest-relevant fact (evaluation or failed scheduled run) is POSTed to this http(s) URL as the identical digest payload. `DIGEST_WEBHOOK_SECRET` signs every POST per OWASP webhook guidance: `X-Terrafield-Signature: t=<unix-sec>,v1=hex(HMAC-SHA256(secret, "<t>.<exact body>"))` — timestamp-bound with a ±300 s replay window, constant-time verification (`verifyWebhookSignature`, exported for receivers), zero-downtime rotation via `DIGEST_WEBHOOK_SECRET_PREVIOUS`, and an SSRF guard that refuses loopback/RFC1918/link-local/metadata targets before any request. `DIGEST_WEBHOOK_OFF=1` disables. Transient-only retry (max 3 attempts), one provenance row per attempt, one audit row per outcome. |
| `DIGEST_WEBHOOK_ALLOWLIST` | no | comma-separated `host` / `host:port` entries that EXPLICITLY allow a webhook target inside a refused range (loopback/RFC1918/…) — the OWASP "default deny + explicit allow" pattern for an ops relay that deliberately lives inside the private network. Exact host or host:port match; garbage entries are dropped, never broadened; the http(s)-only scheme rule and unparseable URLs can never be allowlisted. Allowlisted targets are surfaced as `ALLOWLISTED private target (operator opt-in)` in System Health. |
| `DIGEST_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` / `_FROM` / `_TO` | no | arms the **email digest exit** (nodemailer/SMTP): completed scheduled re-evaluations and failed scheduled runs are emailed to the `_TO` list; manual and backtest evaluations are console-feedback-only by design. Without the credentials the exit reports `credentials-not-configured` and attempts zero sends — the same honest state as FIRMS without a MAP_KEY. `DIGEST_EMAIL_OFF=1` disables. |
| `JOB_WORKER_MODE` | no | `embedded` (default) starts the durable worker in the web process; `external` requires `bun run worker`; `off` disables job execution. |
| `WEBHOOK_ENCRYPTION_KEY` | no | 32-byte base64url or hex key required to create organization webhooks. Signing secrets are AES-GCM encrypted at rest and shown once. |
| `STAC_API_URL` | no | STAC search endpoint; defaults to the verified NASA MAAP public API. |
| `RASTER_SERVICE_URL` | no | Private FastAPI/Rasterio service URL for quantitative GeoTIFF statistics. |

## Live source signs & critical infrastructure (hardening round 2)

- **Live source signs** — every provider chip in the console is backed by a real reachability probe (`GET /api/v1/system/sources`, 60 s cache): the FIRMS host (`FIRMS_API`), the FIRMS detection stream via GIBS (`FIRMS_STREAM`, one real VIIRS 375 m tile — a 404 gap-day still proves the host answers), EONET, GIBS, POWER, SoilGrids. One transient failure within 5 min of a success reads as `DEGRADED`, not `UNREACHABLE`; probes never open circuits or spam the provenance ledger. `FIRMS_API` unreachable simply reflects network egress — the detection stream keeps flowing via GIBS, and the FIRMS adapter chain (MAP_KEY area API → keyless continental CSV archives) engages wherever full egress exists.
- **Probes surface:** `/api/v1/system/sources` (per-sign state + latency + NASA EONET open wildfire events), mirrored into `/api/v1/system/status` (`providers` + `sourceSigns`) and the DataSource table.
- **Liveness / readiness:** `GET /api/v1/healthz` is process-only; `GET /api/v1/readyz` verifies PostgreSQL/schema/seed, Redis, fresh scheduler leadership and worker heartbeats. Public failure details are redacted.
- **Watchdog & safety nets:** `src/instrumentation.ts` registers a 5-min watchdog that restarts a hung scheduler timer (`ensureSchedulerAlive`), logs `unhandledRejection`/`uncaughtException` (serve continues; readiness reports honestly), and closes Prisma on SIGTERM/SIGINT.
- **Always-live degradation:** GIBS tile fetches serve the last good snapshot labeled `stale` on a total host outage; EONET serves stale snapshots with a labeled note; a hard error only ever means "no snapshot ever existed", never fabricated data.
- **Race safety:** scheduler claims are conditional atomic updates (`updateMany` guarded on `nextReevaluateAt` — losers skip, never double-run); bulk inserts (POWER observations, fire detections) are P2002-safe (`lib/db-write.ts`): concurrent duplicate natural keys resolve row-by-row instead of failing the job.
- **Security headers:** X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP, HSTS (next.config.ts). CSP is a documented non-goal at the Next layer (inline flight scripts need a nonce strategy; a broken CSP would break serving).
- **Transport hardening (client):** caller/timeout cancellation stays distinguishable, `Retry-After` is honored, malformed 2xx JSON rejects, GETs retry once, and every mutation carries an idempotency key without auto-retry.
- **Error/loading UX:** themed SSR `loading.tsx` / `error.tsx` / `global-error.tsx` / `not-found.tsx`, per-module error boundaries with fault digests + copyable diagnostics, unified QueryState skeletons/fault/empty panels.

## A/B experiments (deterministic, ledger-backed)

- **Assignment:** pure SHA-256 bucketing of `(experiment key, anonymous unit id)` into [0, 1000) mapped by cumulative variant weights — stable across restarts and processes, no flicker, no sticky sessions (`src/lib/experiments.ts`).
- **Ledger:** assignment is public and read-only. Exposure/outcome persistence requires a verified same-origin writer and commits audit/outbox effects atomically with idempotent replay.
- **Live experiment:** `landing-hero-v1` — full mission brief (control) vs fire-intelligence-first brief (treatment); the variant swaps the hero intro and primary CTA label.
- **Surfaces:** `GET /api/v1/experiments?exp=&unit=` assigns without writing; `POST /api/v1/experiments` records an exposure/outcome for a verified writer; aggregate counts appear in System Health without unit identities.
- **Privacy:** the unit id is a client-generated UUID in localStorage — a random label with no identity, location or fingerprint attached.

## Branding, SEO / GEO / AEO

- **Identity:** the mission badge (flame over a perspective field grid with a satellite pass arc) is generated programmatically — `scripts/make-brand-assets.py` (Pillow) renders the favicon.ico (16/32/48), PNG icons (16→512), `apple-touch-icon.png`, `maskable-512.png` and the 1200×630 Open Graph card; `public/logo.svg` is the hand-authored vector twin. No stock art, no placeholders.
- **PWA:** `public/manifest.webmanifest` (standalone, theme #050914, full icon set incl. maskable), wired through the metadata API with `appleWebApp` support.
- **SEO:** full Next.js metadata — title template, canonical, keywords, OpenGraph + Twitter `summary_large_image` (og-image), robots directives with `max-image-preview: large`, structured icon set.
- **GEO:** `geo.region ZM-02`, `geo.placename` (demo operations area), `geo.position`/`ICBM` — matching the seeded Zambia demo watchlist.
- **AEO:** `public/robots.txt` explicitly welcomes search AND AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot…); `public/llms.txt` + `public/llms-full.txt` (llmstxt.org) give LLMs a curated brief of capabilities, sources, API and the honesty contract; `src/app/sitemap.ts` serves `/sitemap.xml`; JSON-LD `@graph` (Organization, WebSite, SoftwareApplication, FAQPage with the six mission questions) ships in the document head.

## Hackathon submission package

- `download/hackathon/terrafield-atlas-demo.mp4` — 2:44 end-to-end demo with voice narration (agent-browser captures → Pillow compositing → z-ai TTS → ffmpeg).
- `download/hackathon/terrafield-atlas-demo-60s.mp4` — **56.5 s final take for the submission form at 1920×1080** (6 scenes, condensed `jam` narration at speed 1.25, native 1080p compositing; `NN/06` scene counters). Judges'-screen resolution assumption: 16:9 → 1920×1080; re-render at any target with `TF_VIDEO_SCALE=<factor> bash scripts/demo-video/build_final_take.sh` (1.0 → 1280×720, 1.5 → 1920×1080).
- `download/hackathon/narration-script.md` — the 10-scene narration script; `download/hackathon/narration-script-60.md` — the 60 s cut script.
- `download/hackathon/SUBMISSION.md` — the submission write-up (pitch, feature map, architecture, judging mapping).
- `download/hackathon/exits/` — durable signed-delivery proof: `webhook-deliveries.jsonl` (per-POST HMAC scheme verdicts from the verification receiver) + `smtp-deliveries.jsonl` (per-message SMTP transcripts from the verification sink).
- `scripts/demo-video/` — the reproducible pipeline (frames, compositor, TTS generator, ffmpeg assembly; `*-60s` variants for the cut).
- `scripts/arm-digest-exits.sh` + `scripts/exercise-digest-exits.sh` — arm both signed exits live and exercise them end-to-end through the real scheduler.
- `scripts/webhook-receiver.mjs` — the local **ops relay**: a verification-first receiver (`node scripts/webhook-receiver.mjs <port> <jsonl-path> <tolerance-ms>`, default 4317) that checks `x-terrafield-signature` per scheme, refuses replays, and appends one JSONL verdict per POST — `DIGEST_WEBHOOK_URL` points at it with `DIGEST_WEBHOOK_ALLOWLIST=127.0.0.1:4317` as the explicit operator opt-in.

## Documentation

- `docs/ARCHITECTURE.md` — system design, API contracts, reliability model, deviations
- `docs/DATA_SOURCES.md` — the full data-source register (providers, products, coverage, resolution, licenses, limitations, live status)
- `docs/METHODOLOGY.md` — trend statistics and the rotation decision engine, with citations
- `docs/LIMITATIONS.md` — what the product does not claim and why

## Attribution

NASA POWER (NASA Langley Research Center) · NASA EOSDIS GIBS (MODIS Terra true color; MOD13Q1 NDVI; SMAP L4 root-zone soil moisture; VIIRS 375 m thermal anomalies — the FIRMS detection stream) · ISRIC SoilGrids 2.0 (CC BY 4.0).

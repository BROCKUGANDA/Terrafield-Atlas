# TerraField Atlas — NASA Space Apps Challenge 2026 Submission

**Challenge:** Field Shift — NASA Earth intelligence for agricultural resilience
**Project:** TerraField Atlas — a mission-console web platform that turns raw NASA Earth-observation streams into auditable, push-delivered fire intelligence and evidence-backed crop-rotation planning for smallholder agriculture.

---

## The pitch (250 words)

Smallholder farmers face a two-sided information gap: satellite data exists, but it arrives either as raw pixels nobody can audit or as black-box advice nobody can trust. TerraField Atlas closes that gap with a mission-console web application built entirely on **real NASA data** — NASA POWER (MERRA-2 daily meteorology), NASA GIBS EOSDIS (VIIRS/MODIS tiles, including the 375 m thermal-anomaly stream that carries the same active-fire detections NASA FIRMS distributes), NASA EONET v3 (live wildfire events), and ISRIC SoilGrids.

Every number in the console is traceable to a retrieval: a provenance ledger records each external request — provider, URL, status, latency, response size, correlation ID — success or failure, nothing hidden. Statistical claims use seasonal Mann-Kendall with tie-corrected variance, Theil-Sen slopes with 95% CI, Hamed-Rao autocorrelation adjustment, and Benjamini-Hochberg FDR across variables; at least eight full years are required before any significance claim, and archive gaps are reported as no-data — never zero-filled, never imputed, nothing fabricated.

Fire Intelligence adds regional fire watchlists with 6/12/24-hour re-evaluation cadences, an in-process atomic scheduler, per-list run history, cadence-aware alert digests, and **push delivery**: a Server-Sent Events channel with live sign chips, plus OWASP-signed webhooks and scheduler email exits. Critical-infrastructure practices — liveness/readiness probes, watchdog, circuit breakers, stale-while-revalidate degradation, race-safe atomic writes — keep the console serving through upstream outages, honestly labeled.

## What it does (feature map)

1. **Guided first-run tour** — a 17-step walkthrough starts automatically for new operators; restartable anytime from System Health or the ⌘K palette.
2. **Regional fire watchlists** — define geography (lat/lon/radius), confidence floor, lookback window, and alert thresholds per region; one-click evaluate.
3. **Backtest date picker** — replays the identical rule against any historical window end date; results stored as `trigger: backtest` events.
4. **Scheduled re-evaluation** — opt-in 6/12/24 h cadences; the in-process scheduler ticks every 60 s and claims due lists with a **conditional atomic update** (race-safe, crash-safe claim-before-run ordering).
5. **Per-watchlist run history** — every scheduled run (success joined to its evaluation, failures with their errors) reads from the audit ledger with correlation IDs.
6. **Cadence-aware alert digests** — digest windows derive from the watchlist's own interval; status path, peak detections, transitions, archive-gap days, failure notices; window comparison against the previous period.
7. **Push-style delivery** — SSE channel (`watchlist.digest` events, keepalive, capacity-guarded), console PUSH chip counting live pushes, plus env-gated exits: **signed webhook** (HMAC-SHA256 `t=…,v1=…` with ±300 s replay window, constant-time verify, secret rotation, SSRF target guard) and SMTP email for scheduler facts.
8. **Live source signs** — every data-source chip in the UI is backed by a real reachability probe (FIRMS host, FIRMS detection stream via GIBS, EONET, GIBS, POWER, SoilGrids) with latency and transient-failure grace (`LIVE / DEGRADED / UNREACHABLE`) — never a hardcoded "operational" string.
9. **Commercialization-grade hardening** — `/healthz` (liveness), `/readyz` (readiness: DB + seed + scheduler heartbeat + channel), scheduler watchdog with automatic timer restart, unhandledRejection/uncaughtException safety nets (log-and-serve), graceful SIGTERM/SIGINT shutdown, security headers (XFO DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP, HSTS), per-route rate limiting, circuit breakers with jittered backoff, stale-while-revalidate caching that degrades to labeled last-good snapshots instead of hard failure.
10. **Error/loading UX everywhere** — themed SSR `loading.tsx`/`error.tsx`/`global-error.tsx`/`not-found.tsx`, per-module React error boundaries with fault digests and copyable diagnostics, unified `QueryState` skeleton/fault/empty panels, client transport hardening (20 s timeout, HTML-502 detection, idempotent GET retry).

## Architecture

- **Stack:** Next.js 15 (single runtime, App Router) · TypeScript · Prisma + SQLite · TanStack Query · Tailwind + shadcn/ui · Server-Sent Events · Bun test suite.
- **Topology:** one process, one HTTP port. The scheduler, SSE channel, and all delivery exits run in-process (documented deviation: no broker/worker tier at this scale — every async path is idempotent and race-audited).
- **Reliability contract:** transient-only retries with exponential backoff + full jitter; per-provider circuit breakers (4 failures → 60 s open); claim-before-run scheduling; conditional-update atomic claims; P2002-safe bulk idempotent writes (concurrent duplicate inserts resolve row-by-row, data wins); provenance row per external attempt.
- **Honesty rules:** no fabricated telemetry anywhere. A 404 gap-day is a reported no-data day; an unreachable host is a red chip and a fault panel — never substituted data.

## Demo

- **Video (2:44, 1280×720, voice narration):** `hackathon/terrafield-atlas-demo.mp4` — end-to-end platform tour: guided tour → honest trends → live FIRMS/EONET signs → detection ledger → watchlist + scheduled run → pushed digest → System Health probes → provenance ledger. Pipeline: agent-browser captures → Pillow compositing → z-ai TTS narration → ffmpeg assembly (scripts in `scripts/demo-video/`).
- **Narration script:** `hackathon/narration-script.md` (10 scenes).
- **Live walkthrough:** open the console → DEMO ACCESS → follow the guided tour; Fire Intelligence shows live source signs, the Zambia demo watchlist (6 h cadence) with Runs + Digest panels.

## Run it

```bash
bun install
bun run db:push && bun run db:generate
bun run dev            # http://localhost:3000
bun test tests/        # 151 unit tests (fixtures only — no network)
# production: bun run build && bun run start
```

Environment (all optional, surfaced honestly in System Health):
`FIRMS_MAP_KEY` (arms the direct FIRMS CSV API) · `DIGEST_WEBHOOK_URL` + `DIGEST_WEBHOOK_SECRET` (≥32 B) + `DIGEST_WEBHOOK_SECRET_PREVIOUS` (rotation) · `DIGEST_SMTP_*` (email exit) · `WATCH_SCHEDULER_OFF=1` / `DIGEST_PUSH_OFF=1` (disables).

## API surface (v1)

`/api/v1/health` (deep) · `/healthz` (liveness) · `/readyz` (readiness) · `/regions` · `/farms` (+ soil tests, SoilGrids fetch) · `/crops` · `/observations` (+ ingest, sources) · `/analysis/trends` · `/rotation/compare` · `/fires` (GET/POST) · `/fires/watchlists` (+ `[id]/evaluate|runs|digest`, `/digest-stream` SSE) · `/system/status` · `/system/sources` (live signs) · `/provenance` · `/reports`. Every route: correlation ID, Zod validation, rate limiting, JSON error contract.

## Judging criteria mapping

- **Impact:** actionable fire-alert surveillance + rotation planning for smallholder contexts; push delivery means alerts arrive, they are not hunted for.
- **Creativity:** mission-console metaphor with honest telemetry aesthetics; cadence-derived digest windows; FIRMS-detection-stream-over-GIBS fallback that keeps real data flowing when the FIRMS host is blocked.
- **Validity:** every value traceable to a logged retrieval; significance only after ≥8 years; gaps reported as gaps; 151 unit tests pin the engine semantics.
- **Relevance:** built on NASA POWER, GIBS, EONET, and the FIRMS detection stream — the exact data the challenge celebrates.

## What we built with NASA data (mandatory question)

NASA POWER (meteorology + trends), NASA GIBS (raster layers + VIIRS 375 m thermal-anomaly vector tiles — the active-fire detection stream), NASA EONET v3 (live wildfire events), NASA FIRMS (detection-stream distribution target, MAP_KEY-armed CSV API in the failover chain), ISRIC SoilGrids (soil properties, cited CC BY 4.0).

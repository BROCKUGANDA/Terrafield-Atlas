# TerraField Atlas

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
8. **Fire Intelligence** — ingest real VIIRS 375 m detections (e.g. the Zambia preset, Jul–Oct), view the fire calendar, and set up **regional fire watchlists**: pick a geography, radius, confidence floor and threshold; *Evaluate now* checks every uncovered day against the live VIIRS archive and reports clear / watch / alert from real detections only (a red header chip surfaces alerts from anywhere in the console).
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
| Data | Prisma + SQLite | provenance-first schema; migrations via `prisma db push` |
| Statistics | Custom TypeScript implementations of Mann-Kendall / Theil-Sen / BH-FDR | cross-checked against the R `modifiedmk` reference implementation |

**Documented deviation from the suggested stack:** the deployment sandbox for this challenge runs a single Node process with SQLite and no external message broker, so the FastAPI/PostgreSQL/PostGIS/Redis/Celery topology of the original architecture brief is replaced by Next.js route handlers + Prisma/SQLite + in-process job ledger + in-memory TTL cache. The domain contracts (typed APIs, validation, provenance, retry/backoff, circuit breakers, idempotent ingestion, rate limiting) are preserved; see `docs/ARCHITECTURE.md` for the rationale and the swap path.

## Commands

```bash
bun run dev            # dev server (auto-run in this sandbox)
bun run lint           # ESLint
bun run db:push        # apply the Prisma schema
bun test tests/        # 69 unit tests (fixtures only — no network)
bun scripts/live-smoke.mjs   # live integration smoke tests against real NASA/ISRIC endpoints
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | SQLite file path (set by the sandbox) |
| `FIRMS_MAP_KEY` | no | enables the FIRMS CSV adapter (free NASA registration). Without it the adapter reports `credentials-not-configured` and fire features are served from the GIBS VIIRS stream (same detections). The key is server-side only and never exposed to the client. |

## Documentation

- `docs/ARCHITECTURE.md` — system design, API contracts, reliability model, deviations
- `docs/DATA_SOURCES.md` — the full data-source register (providers, products, coverage, resolution, licenses, limitations, live status)
- `docs/METHODOLOGY.md` — trend statistics and the rotation decision engine, with citations
- `docs/LIMITATIONS.md` — what the product does not claim and why

## Attribution

NASA POWER (NASA Langley Research Center) · NASA EOSDIS GIBS (MODIS Terra true color; MOD13Q1 NDVI; SMAP L4 root-zone soil moisture; VIIRS 375 m thermal anomalies — the FIRMS detection stream) · ISRIC SoilGrids 2.0 (CC BY 4.0).

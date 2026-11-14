# Known limitations & deferred work

Being explicit about what this product does not do is part of its engineering contract.

## Data & science limitations

1. **POWER is reanalysis, not stations.** 0.5° × 0.625° grid-cell values on LST day boundaries approximate regional climate; they are not the farm's microclimate. Heavy convective rainfall can be underestimated. Every analysis repeats this caveat.
2. **MOD13Q1 NDVI and SMAP L4 are visualization layers here.** GIBS serves them as colormap renders; quantitative per-pixel NDVI with QA flags and SMAP m³/m³ values require Earthdata credentials (AppEEARS/LAADS/GES DISC) that this deployment does not have. The product says so wherever those layers appear, and the trend engine does not pretend to analyze them numerically. NDVI dates snap to 16-day composite starts.
3. **SMAP's 9 km native grid** is displayed with its resolution label and is never presented as field-scale soil moisture.
4. **FIRMS CSV API is unreachable from this deployment sandbox** (verified connection timeouts). Fire features are served from the GIBS VIIRS 375 m stream — the same detection stream — with the substitution stated openly in the UI and the source register.
5. **SoilGrids is intermittent** (verified: sub-second and > 90 s responses within one session). It is optional, labeled as modeled, confidence-discounted, and fails with an honest 502 instead of fabricating values.
6. **VIIRS fire detections** miss fires that start and end between the twice-daily overpasses; clouds block detection; archive gap days exist and are reported as no-data.
7. **Rotation engine scope**: it compares documented requirements against evidence (rainfall climatology, thermal season, measured soil, sequence rules). It does not model local pest pressure, varieties, labor, input logistics or markets. Economic viability is explicitly "not assessed" rather than invented.
8. **Trend methods**: Mann-Kendall/Theil-Sen detect monotonic change only; they can miss step changes. The Hamed-Rao lag-1 term applied to the seasonal statistic is a documented adaptation (see METHODOLOGY.md §1.8).
9. **Correlation ≠ causation**: nowhere does the product claim an environmental association proves an agricultural cause or effect; no yield or profit prediction exists.
10. **Fire watchlists are threshold alerts, not a fire-perimeter or real-time warning system.** Evaluations count stored VIIRS 375 m detections inside a radius around a center over a lookback window. A watch radius cannot extend past the decoded tile area; a `clear` status means “no detections in the checked window within the archive's twice-daily overpass limits”, not “no fire”; days the GIBS archive lacks are reported as no-data and a `clear` is only issued when every day of the window was actually checked. VIIRS cannot see fires that start and end between overpasses or under cloud. Watchlists re-evaluate on demand (or when their rule is edited) — there is no background scheduler in this topology, so alert freshness equals the last evaluation time, which is always displayed.

## Engineering limitations (sandbox-imposed, documented)

1. **Single-process topology**: SQLite + in-process cache + inline job execution instead of PostgreSQL/PostGIS + Redis + Celery workers. Rationale and swap path in `docs/ARCHITECTURE.md`. Consequences: rate limiting is per-process (not cluster-wide); heavy ingestions run inside the request (the UI shows running state and the job ledger records outcomes); no horizontal scaling.
2. **SQLite lacks `skipDuplicates`** — idempotency is implemented with an existence-filter before insert (correct but O(existing rows) on re-ingest).
3. **No authentication layer in the demo** (public demo route per the challenge requirement). The schema reserves `users`/owner labels and the API seams support per-farm authorization; cross-user farm access prevention is therefore *not* enforced in this deployment — documented rather than hidden.
4. **Report PDF** is produced via the browser's print-to-PDF (print stylesheet included) rather than a server-side PDF renderer — a deliberate scope decision for the 48-hour window.

## Features deliberately deferred (honest backlog)

- Authenticated accounts and per-user farm isolation (schema seams present).
- Administrative-region gazetteer (replaced by curated real-region presets + free coordinate/boundary entry).
- Farmer-uploaded raster/shapefile import; GeoJSON import of farm boundaries (export of drawn boundaries works; import parsing is next).
- MODIS+Aqua/NOAA20 fire sensor switching in the UI (the ingestion currently uses the SNPP layer; the harmonization story is told via the register and multi-sensor-ready schema).
- Server-side PDF generation with cover page; scheduled background re-ingestion; multi-language UI.

## Remaining known defects

- None known in the shipped flows at time of delivery (69/69 unit tests, 9/9 live smoke checks, browser-verified golden path). The product intentionally surfaces provider failures (SoilGrids slowness, FIRMS unreachability) as visible, honest degraded states — these are environmental, not defects.

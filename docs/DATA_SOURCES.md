# Data-source register

Live status was verified during this session against each endpoint (see `/api/v1/provenance` for the ongoing ledger). This register is also machine-readable at `GET /api/v1/observations/sources`.

## 1. NASA POWER Daily API — PRIMARY meteorological source

| Field | Value |
| --- | --- |
| Provider | NASA Langley Research Center (LaRC) — POWER Project |
| Product | POWER Daily API v2 (point requests), MERRA-2 assimilated meteorology |
| Endpoint | `https://power.larc.nasa.gov/api/temporal/daily/point?parameters={vars}&community=AG&longitude=&latitude=&start=YYYYMMDD&end=YYYYMMDD&format=JSON` |
| Format | JSON |
| Coverage | 1981-01-02 → present minus ~3 days (5-day safety buffer enforced) |
| Resolution | 0.5° × 0.625° grid cell (≈ 55 × 62 km at the equator) |
| Units | mm/day (PRECTOTCORR), °C (T2M, T2M_MAX, T2M_MIN), MJ/m²/day (ALLSKY_SFC_SW_DWN), % (RH2M), m/s (WS2M), fraction 0–1 (GWETROOT, GWETTOP) |
| Auth | none (public) |
| Rate | ~1 request/sec sustained recommended |
| License | NASA open data; attribution requested |
| Time standard | **LST** (local solar time) — not UTC; surfaced in every analysis |
| Limitations | Grid-cell reanalysis, not farm microclimate; convective precipitation can be underestimated; fill value −999 handled as missing (never 0) |
| Live status | **operational** (verified: 26,399–30,688 real observations ingested this session) |

## 2. NASA GIBS WMTS — satellite map layers (no auth)

| Layer | Product | Format / TMS | Resolution | Coverage | Live status |
| --- | --- | --- | --- | --- | --- |
| MODIS_Terra_CorrectedReflectance_TrueColor | MODIS/Terra corrected reflectance | JPEG / GoogleMapsCompatible_Level9 | 250 m, daily | 2000-02-24 → | operational |
| VIIRS_SNPP_CorrectedReflectance_TrueColor | VIIRS/SNPP corrected reflectance | JPEG / Level9 | 250 m, daily | 2015-11-24 → | operational |
| MODIS_Terra_L3_NDVI_16Day | **MOD13Q1 v6.1** vegetation indices (rendered) | PNG / Level9 | 250 m, 16-day composites (dates snap to Jan 1 + 16k) | 2000-02 → | operational |
| SMAP_L4_Analyzed_Root_Zone_Soil_Moisture | **SPL4SMGP.007** (SMAP L4 assimilation) | PNG / Level6 | **≈ 9 km native** | 2015-03-31 → (3-day lag) | operational |

Limitations: MOD13Q1 and SMAP are colormap **visualizations** here — quantitative per-pixel values with QA flags require MOD13Q1/SPL4SMGP science files via Earthdata/AppEEARS, whose credentials are not configured in this deployment (adapters report an explicit not-configured status; nothing is fabricated). SMAP's 9 km grid is prominently labeled in the UI and is never treated as field-level moisture.

## 3. NASA GIBS VIIRS thermal anomalies — fire detections (no auth)

| Field | Value |
| --- | --- |
| Provider | NASA EOSDIS GIBS — vector tiles |
| Product | `VIIRS_SNPP_Thermal_Anomalies_375m_All` (VIIRS 375 m active-fire detections; the same detection stream NASA FIRMS distributes) |
| Endpoint | `.../wmts/epsg4326/best/VIIRS_SNPP_Thermal_Anomalies_375m_All/default/{date}/500m/7/{row}/{col}.mvt` |
| Coverage | 2015-01-01 → present, with isolated gap days (verified via the GIBS Domains service; gap days are reported as no-data, never zero) |
| Attributes | LATITUDE, LONGITUDE, BRIGHT_TI4/TI5 (K), SCAN, TRACK, ACQ_DATE, ACQ_TIME (UTC), SATELLITE, CONFIDENCE (l/n/h), DAYNIGHT, UID, FRP (MW) |
| Live status | **operational** (verified: 1,100 real detections decoded from a single Zambia tile, 2024-08-15) |

Limitations: twice-daily overpasses miss fires that start and end between them; clouds block detection; 375 m pixel size limits detection of small/smoldering fires.

## 4. NASA FIRMS area CSV API — implemented, honestly unavailable here

Adapter fully implemented (`lib/adapters/firms.ts`), gated on the server-side `FIRMS_MAP_KEY` environment variable. Live status this session: the FIRMS host is **unreachable from the deployment sandbox** (connection timeouts, verified repeatedly). The platform never fabricates FIRMS data: fire features are served from the GIBS VIIRS stream above (same detections), and the FIRMS row in the source register is flagged `unreachable` with the reason.

## 5. ISRIC SoilGrids v2.0 — SUPPLEMENTARY soil information

| Field | Value |
| --- | --- |
| Provider | ISRIC — World Soil Information |
| Product | SoilGrids 2.0 (2020 release), point REST |
| Endpoint | `https://rest.isric.org/soilgrids/v2.0/properties/query?lon=&lat=&property={phh2o,soc,sand,clay,nitrogen}&value=mean&depth=0-5cm` |
| Units | converted server-side using each property's `d_factor` (pH×10 → pH; dg/kg → g/kg; g/kg → %; cg/kg → g/kg) |
| Coverage / resolution | global; 250 m modeled grid |
| License | CC BY 4.0 |
| Live status | **operational but intermittently slow/unavailable** (observed both < 1 s and > 90 s within one session) — always stored with `source='soilgrids'`, marked as a modeled estimate, and weighted with reduced confidence |

Limitations: modeled predictions (regression-kriging), never in-field measurements; never silently substituted for farmer/lab tests.

## 6. Deliberately not integrated (with reasons)

- **AppEEARS / LAADS (MOD13Q1, SMAP L3/L4 science files)**: require Earthdata credentials not available in this deployment. The adapter seam exists (data-source register documents them as "not configured"); no placeholder science values are ever produced.
- **SoilGrids REST "bulk" endpoints / paused services**: the brief notes the REST API's paused status; the point-query used here was verified live, is optional in the product, and fails gracefully.

## Crop catalogue sources (agronomic values)

- FAO *Irrigation and Drainage Paper 33* (Doorenbos & Kassam, 1979) — seasonal water-requirement ranges.
- FAO EcoCrop database / FAO crop-production extension guidance — pH ranges, durations, adaptation classes.
- Karlen et al. (1994), *Crop rotations for the 21st century*, Advances in Agronomy 53:1–45 — rotation/diversity rationale.
- FAO (2016), *Pulses: Nutritious seeds for a sustainable future* — legume N-fixation guidance.
- ICRISAT pigeonpea agronomy guidance — indicative pigeonpea water range.

No LLM-invented agronomic values: every crop row in `GET /api/v1/crops` carries its citation list.

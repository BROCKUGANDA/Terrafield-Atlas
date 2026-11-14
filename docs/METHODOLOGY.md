# Scientific methodology

## 1. Environmental trend detection ("Trend Detective" workflow)

Pipeline per variable (implementation: `src/lib/stats/analyze.ts`, primitives in `src/lib/stats/core.ts`):

1. **Temporal coverage** from stored observations; the record's dataset version and retrieval time are carried into every result.
2. **Daily → monthly aggregation**: months with < 20 valid days are excluded (never imputed); precipitation is summed (mm/month), other variables averaged.
3. **Missing-observation accounting**: POWER fill values (−999) and plausibility outliers become null; counts are reported (`missingCount`) and warned about.
4. **Seasonal-cycle handling**: the primary test is the **seasonal Mann-Kendall test** (Hirsch, Slack & Smith 1982; Hirsch & Slack 1984): S and its tie-corrected variance are computed *within each calendar month* and summed, so the annual cycle itself cannot manufacture a trend. This is the standard guard against the "two selected dates differ" fallacy.
5. **Baseline statistics**: monthly climatology (mean, σ) over all complete years excluding the final year; the final year is scored as anomalies (z-scores) against that baseline; |z| ≥ 2 months are reported.
6. **Trend magnitude**: **Theil-Sen slope** — median of pooled within-month pairwise slopes (per-year steps), with the **Sen (1968)/Gilbert (1987) rank-based 95% confidence interval** (C_α = z·√Var(S); ranks M1, M2 interpolated on the sorted slopes).
7. **Direction & significance**: two-sided p from the normal approximation of S; significance at α = 0.05.
8. **Autocorrelation treatment**: the lag-1 autocorrelation of the deseasonalized series is tested against the ±2/√n white-noise bound; when significant, the Mann-Kendall variance is inflated by the exact lag-1 term of the **Hamed & Rao (1998)** correction (factor 1 + 2ρ₁(n−3)/n), making the test more conservative. *Adaptation note (documented honestly in the product):* Hamed-Rao was derived for the non-seasonal statistic; applying its lag-1 term to the summed seasonal statistic is a pragmatic adaptation consistent with common hydrological practice, and it only ever *widens* the interval (never fabricates significance).
9. **Multiple testing**: **Benjamini-Hochberg FDR** across all variables analysed in one request; adjusted p is reported next to the raw p.
10. **Minimum evidence rule**: ≥ 8 full years and ≥ 8 observations per calendar month are required before *any* significance claim; otherwise the result is "insufficient record" with the exact numbers, and no direction/slope is emitted.
11. **Explanation**: every result ships a plain-language interpretation stating period, n, method, slope with CI, p (raw and FDR-adjusted), anomaly count, the seasonality guard, and the standing caveats (MERRA-2 grid cell, LST time standard, correlation ≠ causation).

Reference cross-check: the Hamed-Rao implementation was written against the published algorithm and cross-checked line-by-line with the R package `modifiedmk::mmkh` (CRAN), including the detrend-by-Sen's-slope, ACF-of-ranks, significant-lag zeroing and the correction-factor formula.

Unit presentation follows the aggregation actually tested: rainfall slopes are reported in **mm/month per year** (with an annual-rainfall equivalent in the narrative); temperature/radiation/humidity/wetness slopes in their native units per year.

## 2. Crop-rotation decision engine

Implementation: `src/lib/crops/rotation-engine.ts` — a deterministic, pure function of (crop sequence, environmental record, soil information, farmer priorities, rule version).

### Criteria and their evidence

| Criterion | Evidence used | Rule source |
| --- | --- | --- |
| Family-sequence compatibility | botanical families of the chosen crops | Karlen et al. 1994 (repeated families concentrate pests) |
| Legume N contribution | fraction of N-fixing positions | FAO 2016 (biological N fixation) |
| Water-demand compatibility | FAO I&D Paper 33 seasonal ranges vs the best consecutive-window median/IQR rainfall from the stored POWER climatology | FAO 1979 + NASA POWER |
| Seasonal (thermal) feasibility | crop thermal class vs consecutive ≥ 12 °C / ≥ 5 °C season length from the POWER temperature climatology | FAO EcoCrop classes |
| Nutrient-balance sequence | consecutive high-N-demand non-fixing crops (penalty); legume→high-demand (benefit) | FAO extension guidance |
| Crop diversity | distinct families per position | Karlen et al. 1994 |
| Soil pH & texture suitability | measured (or SoilGrids, labeled) pH/texture vs documented ranges; > 0.5 outside the range is an incompatibility flag | FAO EcoCrop ranges |
| Staple-calorie presence | documented staple crops in sequence | FAO food-balance guidance |
| Economic viability | **not assessed** — no configured market-price source; never estimated | honesty rule |

### Scoring rules

- Farmer priorities are normalized to weights summing to 1 and distributed across criteria; the effective weights and the rule version are stored with every scenario (reproducibility: identical inputs → identical outputs, enforced by a byte-equality unit test).
- **Missing inputs remove the affected criterion from the weighted mean and reduce confidence** — they are never scored as zero. Confidence = weighted coverage of assessed criteria × data-quality factor (SoilGrids-only soil × 0.85; < 10-year record × 0.9).
- Incompatibilities (pH far out of range; thermal season too short; water demand above the p75 rainfall) are *flagged explicitly* in a dedicated list and in the narrative, not buried in the score.
- Narratives state the actual numbers ("cowpea needs 300–500 mm [FAO I&D 33]; its Sep–Dec window median rainfall is X mm (IQR a–b) in the 12-year POWER record…") and every factor card shows its weight.

### What the engine refuses to do

- Predict yields, harvests or profit.
- Treat modeled soil (SoilGrids) as equivalent to a measured test.
- Score economics without a price source.
- Invent agronomic values (catalogue rows are published ranges with citations; the catalogue is versioned).

## 3. Fire intelligence

- Detections are real VIIRS 375 m observations decoded from GIBS vector tiles (the FIRMS detection stream): latitude/longitude, acquisition date/time (UTC), satellite, day/night, confidence class (l/n/h), FRP (MW), brightness temperatures (K).
- Ingestion is per-date and bbox-bounded (≤ 12 tiles, ≤ 40 days per call), idempotent on (lat, lon, date, time, uid).
- **Honesty rules**: gap days in the GIBS archive are returned as `noDataDays` (never zero counts); the twice-daily-overpass limitation and cloud occlusion are displayed next to every fire result; the FIRMS CSV adapter's unavailability is stated rather than substituted.

## 4. Provenance

- Every external request is logged (provider, dataset, operation, URL, HTTP status, latency, bytes, correlation ID, retrieval time) in `ApiRequestLog`.
- Stored observations carry `sourceProvider` and `datasetVersion`; trend analyses store their full structured result, method and rule version; rotation scenarios store weights, scores, rule version and incompatibilities.
- The Evidence & Provenance page renders the live ledger; the compiled report embeds the most recent provenance rows.

# Known limitations

TerraField Atlas reports uncertainty explicitly. Nothing in this document is hidden from the product UI.

## Science and data

1. **POWER is reanalysis, not a farm weather station.** Its 0.5° × 0.625° grid and LST day boundaries approximate regional climate; they are not field microclimate.
2. **GIBS NDVI and SMAP layers are visualizations.** Quantitative science products and QA flags require Earthdata credentials not configured here.
3. **SoilGrids is modeled and supplementary.** It never silently replaces farmer or laboratory measurements.
4. **FIRMS direct CSV access is credential- and egress-dependent.** Fire detections use the NASA GIBS VIIRS 375 m stream, the same underlying detection stream, with honest degraded states.
5. **VIIRS is not a confirmed-fire perimeter service.** Clouds, twice-daily overpasses and archive gaps limit detection; gap days are reported as no-data.
6. **Trend and rotation methods have bounded scope.** They detect monotonic change and compare documented requirements; they do not predict yield, profit, pests, labor or markets. Correlation is not causation.

## Platform

1. **Single VPS failure domain.** Two web replicas improve application availability but do not make the VPS, PostgreSQL node or network highly available.
2. **No physical-device certification.** Browser automation covers desktop/mobile viewport engines, not every real phone, tablet, assistive technology or network carrier.
3. **External providers can be unavailable or slow.** The application serves honest stale/degraded/not-configured states and never fabricates missing values.
4. **SSE is not a replay log.** Redis fans out live events across replicas; disconnected clients recover current state through REST endpoints.
5. **Exactly-once external delivery is not possible without receiver cooperation.** Stable event IDs, idempotency headers and durable receipts provide at-least-once delivery with deduplication; receivers should deduplicate by event ID.
6. **Backups require operator storage policy.** Automated artifacts are checksummed and restore-drilled, but off-VPS replication and retention remain deployment responsibilities.
7. **Account deletion is not self-service.** Password reset is self-service (single-use, one-hour, hashed tokens); deleting an account still requires an operator because owned farms and organizations must be transferred first.
8. **CSP is report-only.** Violations are collected and logged, not blocked, until the report ledger is clean enough to enforce.

## Deliberate scope exclusions

- Kubernetes, multi-region deployments, database sharding and multi-VPS HA.
- Guaranteed scientific-provider credentials or data products.
- Server-side PDF, CSV, and JSON report exports are available; browser print remains as a fallback.
- Raster statistics accept GeoTIFF, NetCDF, and Zarr uploads; importing raster values into farm boundaries or crop models is not automatic.
- Economic or yield forecasting.

# TerraField Raster Processing Service

A bounded compute service for quantitative raster workflows. It keeps GDAL/Rasterio array processing out of Next.js request handlers.

## Endpoints

- `GET /health`
- `POST /v1/raster/stats` — multipart GeoTIFF upload with optional `band`, WGS84 `bbox` JSON, `target_crs`, and `target_resolution`.
- `POST /v1/dataset/stats` — multipart NetCDF (`.nc`/`.nc4`) or Zarr store ZIP, with optional `variable`, `crs`, and the same clipping/reprojection parameters.

The service validates CRS, clips to a bounded window, optionally reprojects/resamples, excludes nodata, computes pixel statistics, and returns source/output metadata plus processing lineage. Uploads are limited to 50 MB and windows to 25,000,000 pixels.

## Run locally

```bash
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8001
python -m unittest test_processing.py
```

## Production

Build `Dockerfile` and place the service on the private application network. Set `RASTER_SERVICE_URL=http://raster:8001` in the Next.js runtime. Do not expose the service publicly unless authentication and abuse controls are added.

## Limitations

- This foundation computes statistics and can persist the derived result JSON to `RASTER_ARTIFACT_DIR` (default `/artifacts`); the Next API records the artifact reference and lineage in `RasterAsset`.
- Categorical rasters should use nearest-neighbour reprojection.
- NetCDF/Zarr ingestion requires a separate reviewed adapter.
- Scientific validation remains the responsibility of the analytical method that consumes these statistics.

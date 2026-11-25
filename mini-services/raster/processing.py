from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

import numpy as np
import rasterio
from rasterio import transform as raster_transform
from rasterio import warp as raster_warp
from rasterio import windows as raster_windows
from pydantic import BaseModel, Field


class Bbox(BaseModel):
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)

    def valid(self) -> bool:
        return self.west < self.east and self.south < self.north


def _json_value(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    return value


def process_raster_bytes(
    data: bytes,
    *,
    band: int = 1,
    bbox: Bbox | None = None,
    target_crs: str | None = None,
    target_resolution: float | None = None,
    max_pixels: int = 25_000_000,
) -> dict[str, Any]:
    if len(data) > 50 * 1024 * 1024:
        raise ValueError("raster exceeds 50 MB upload limit")
    if data[:4] not in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        raise ValueError("file is not a TIFF/BigTIFF raster")
    if band < 1:
        raise ValueError("band must be 1-based")
    if target_resolution is not None and target_resolution <= 0:
        raise ValueError("target_resolution must be positive")

    steps: list[dict[str, Any]] = []
    with rasterio.MemoryFile(data) as memfile:
        with memfile.open() as src:
            if src.crs is None:
                raise ValueError("raster CRS is required")
            if band > src.count:
                raise ValueError(f"band {band} exceeds raster band count {src.count}")
            source_meta = {
                "driver": src.driver,
                "width": src.width,
                "height": src.height,
                "count": src.count,
                "dtypes": list(src.dtypes),
                "crs": src.crs.to_string(),
                "transform": list(src.transform),
                "bounds": list(src.bounds),
                "nodata": src.nodata,
                "resolution": list(src.res),
            }
            if bbox is not None:
                if not bbox.valid():
                    raise ValueError("bbox west/east and south/north must be ordered")
                left, bottom, right, top = raster_warp.transform_bounds("EPSG:4326", src.crs, bbox.west, bbox.south, bbox.east, bbox.north)
                window = raster_windows.from_bounds(left, bottom, right, top, transform=src.transform)
                window = window.round_offsets().round_lengths()
                if window.width <= 0 or window.height <= 0:
                    raise ValueError("bbox does not intersect the raster")
                array = src.read(band, window=window, masked=True)
                transform = src.window_transform(window)
                steps.append({"operation": "clip", "inputCrs": "EPSG:4326", "sourceWindow": [window.col_off, window.row_off, window.width, window.height]})
            else:
                array = src.read(band, masked=True)
                transform = src.transform

            width, height = array.shape[1], array.shape[0]
            if width * height > max_pixels:
                raise ValueError("raster window exceeds 25,000,000 pixel processing limit")

            dst_crs = src.crs
            if target_crs or target_resolution is not None:
                if target_crs:
                    dst_crs = rasterio.crs.CRS.from_user_input(target_crs)
                left, bottom, right, top = raster_transform.array_bounds(height, width, transform)
                if target_resolution is not None:
                    if target_crs:
                        left, bottom, right, top = raster_warp.transform_bounds(src.crs, dst_crs, left, bottom, right, top)
                    dst_width = max(1, int(np.ceil((right - left) / target_resolution)))
                    dst_height = max(1, int(np.ceil((top - bottom) / target_resolution)))
                    dst_transform = raster_transform.from_origin(left, top, target_resolution, target_resolution)
                else:
                    dst_transform, dst_width, dst_height = raster_warp.calculate_default_transform(
                        src.crs, dst_crs, width, height, left, bottom, right, top
                    )
                dtype = array.dtype
                resampling = rasterio.enums.Resampling.bilinear if np.issubdtype(dtype, np.floating) else rasterio.enums.Resampling.nearest
                fill_value = src.nodata if src.nodata is not None else (np.nan if np.issubdtype(dtype, np.floating) else 0)
                destination = np.full((dst_height, dst_width), fill_value, dtype=dtype)
                raster_warp.reproject(
                    source=array.filled(fill_value),
                    destination=destination,
                    src_transform=transform,
                    src_crs=src.crs,
                    src_nodata=src.nodata,
                    dst_transform=dst_transform,
                    dst_crs=dst_crs,
                    dst_nodata=src.nodata,
                    resampling=resampling,
                )
                array = np.ma.masked_equal(destination, fill_value) if src.nodata is not None else np.ma.masked_invalid(destination)
                transform = dst_transform
                width, height = dst_width, dst_height
                steps.append({
                    "operation": "reproject_resample",
                    "targetCrs": dst_crs.to_string(),
                    "targetResolution": target_resolution,
                    "resampling": resampling.name,
                })

            valid = np.ma.compressed(array).astype(np.float64)
            valid_count = int(valid.size)
            total_count = int(array.size)
            if valid_count == 0:
                raise ValueError("raster window contains no valid pixels")
            stats = {
                "validPixels": valid_count,
                "totalPixels": total_count,
                "validFraction": valid_count / total_count,
                "minimum": float(np.min(valid)),
                "maximum": float(np.max(valid)),
                "mean": float(np.mean(valid)),
                "standardDeviation": float(np.std(valid)),
                "percentiles": {str(p): float(np.percentile(valid, p)) for p in (5, 25, 50, 75, 95)},
            }
            output_meta = {
                "width": width,
                "height": height,
                "crs": dst_crs.to_string(),
                "transform": list(transform),
                "bounds": list(raster_transform.array_bounds(height, width, transform)),
                "nodata": src.nodata,
            }
            output_meta["resolution"] = [transform.a, -transform.e]

    return {
        "metadata": {"source": source_meta, "output": output_meta},
        "statistics": stats,
        "lineage": {
            "inputSha256": hashlib.sha256(data).hexdigest(),
            "inputBytes": len(data),
            "band": band,
            "steps": steps,
            "processorVersion": "terrafield-raster/2026.11",
            "processedAt": datetime.now(timezone.utc).isoformat(),
        },
        "limitations": [
            "Statistics describe the processed pixel window, not ground truth.",
            "Nodata and masked pixels are excluded and counted.",
            "Reprojection uses the documented resampling method; categorical rasters should use nearest-neighbour.",
        ],
    }

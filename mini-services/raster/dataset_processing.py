from __future__ import annotations

import hashlib
import io
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import rasterio
import xarray as xr
from rasterio import transform as raster_transform
from rasterio.crs import CRS

from processing import Bbox, process_raster_bytes

MAX_DATASET_BYTES = 100 * 1024 * 1024
MAX_ZARR_MEMBERS = 5_000
MAX_ZARR_UNCOMPRESSED_BYTES = 300 * 1024 * 1024
MAX_ZARR_MEMBER_BYTES = 50 * 1024 * 1024


def _resolve_crs(dataset: xr.Dataset, variable: xr.DataArray, override: str | None) -> CRS:
    if override:
        return CRS.from_user_input(override)
    sources: list[dict[str, Any]] = [dict(dataset.attrs), dict(variable.attrs)]
    for attrs in sources:
        for key in ("spatial_ref", "crs_wkt", "crs"):
            value = attrs.get(key)
            if value is None:
                continue
            try:
                return CRS.from_user_input(str(value))
            except Exception:
                try:
                    return CRS.from_wkt(str(value))
                except Exception:
                    continue
    raise ValueError("dataset CRS is required; pass crs explicitly (for example EPSG:4326)")


def _spatial_dims(variable: xr.DataArray) -> tuple[str, str]:
    candidates = [("y", "x"), ("lat", "lon"), ("latitude", "longitude"), ("row", "col")]
    lowered = [str(dim).lower() for dim in variable.dims]
    for y_name, x_name in candidates:
        if y_name in lowered and x_name in lowered:
            return lowered[lowered.index(y_name)], lowered[lowered.index(x_name)]
    raise ValueError("dataset must expose y/x, lat/lon, latitude/longitude, or row/col dimensions")


def _to_geotiff(array: np.ndarray, crs: CRS, transform: Any, nodata: float) -> bytes:
    with rasterio.MemoryFile() as memfile:
        with memfile.open(
            driver="GTiff",
            height=array.shape[0],
            width=array.shape[1],
            count=1,
            dtype=array.dtype,
            crs=crs,
            transform=transform,
            nodata=nodata,
        ) as dataset:
            dataset.write(array, 1)
        return memfile.read()


def _safe_zip_extract(data: bytes, destination: str) -> None:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > MAX_ZARR_MEMBERS:
            raise ValueError('zarr archive has too many members')
        if sum(member.file_size for member in members) > MAX_ZARR_UNCOMPRESSED_BYTES:
            raise ValueError('zarr archive expands beyond the allowed size')
        if any(member.file_size > MAX_ZARR_MEMBER_BYTES for member in members):
            raise ValueError("zarr archive member exceeds the allowed size")
        for member in members:
            name = member.filename
            path = Path(name)
            if path.is_absolute() or ".." in path.parts or name.startswith("\\"):
                raise ValueError("Zarr archive contains an unsafe path")
            archive.extract(member, destination)


def _open_dataset(data: bytes, filename: str) -> tuple[xr.Dataset, Any, str]:
    suffix = Path(filename.lower()).suffix
    if suffix in (".nc", ".nc4", ".netcdf"):
        if len(data) > MAX_DATASET_BYTES:
            raise ValueError("dataset exceeds 100 MB upload limit")
        temporary = tempfile.NamedTemporaryFile(suffix=".nc", delete=False)
        try:
            temporary.write(data)
            temporary.close()
            return xr.open_dataset(temporary.name, engine="netcdf4"), temporary.name, "netcdf"
        except Exception:
            Path(temporary.name).unlink(missing_ok=True)
            raise
    if suffix == ".zip":
        if len(data) > MAX_DATASET_BYTES:
            raise ValueError("dataset exceeds 100 MB upload limit")
        directory = tempfile.TemporaryDirectory()
        _safe_zip_extract(data, directory.name)
        if not (Path(directory.name) / ".zgroup").exists() and not (Path(directory.name) / "zarr.json").exists():
            directory.cleanup()
            raise ValueError("ZIP does not contain a Zarr store")
        return xr.open_zarr(directory.name, consolidated=False), directory, "zarr"
    raise ValueError("dataset must be a NetCDF file (.nc/.nc4) or a Zarr store ZIP (.zip)")


def process_dataset_bytes(
    data: bytes,
    *,
    filename: str,
    variable_name: str | None = None,
    band: int = 1,
    bbox: Bbox | None = None,
    target_crs: str | None = None,
    target_resolution: float | None = None,
    crs_override: str | None = None,
) -> dict[str, Any]:
    dataset, cleanup_target, input_format = _open_dataset(data, filename)
    try:
        variables = {name: value for name, value in dataset.data_vars.items() if np.issubdtype(value.dtype, np.number)}
        if not variables:
            raise ValueError("dataset has no numeric data variables")
        variable = variables[variable_name] if variable_name else next(iter(variables.values()))
        y_dim, x_dim = _spatial_dims(variable)
        drop = {dim: 0 for dim in variable.dims if dim not in (y_dim, x_dim)}
        if drop:
            variable = variable.isel(drop)
        values = np.asarray(variable.transpose(y_dim, x_dim).values)
        if values.ndim != 2 or values.size == 0:
            raise ValueError("selected dataset slice is not a non-empty 2D array")

        y_values = np.asarray(variable.coords[y_dim].values, dtype=np.float64)
        x_values = np.asarray(variable.coords[x_dim].values, dtype=np.float64)
        if y_values.size < 2 or x_values.size < 2:
            raise ValueError("dataset spatial coordinates need at least two values per axis")
        x_res = abs(float(x_values[1] - x_values[0]))
        y_res = abs(float(y_values[1] - y_values[0]))
        if x_res <= 0 or y_res <= 0:
            raise ValueError("dataset spatial coordinates are not regular")
        transform = raster_transform.from_origin(float(x_values.min()), float(y_values.max()), x_res, y_res)
        crs = _resolve_crs(dataset, variable, crs_override)

        nodata = variable.attrs.get("_FillValue", variable.attrs.get("missing_value", np.nan))
        nodata_value = float(nodata) if nodata is not None and np.isfinite(float(nodata)) else -9999.0
        array = values.astype("float32")
        array[~np.isfinite(array)] = nodata_value
        geotiff = _to_geotiff(array, crs, transform, nodata_value)

        result = process_raster_bytes(
            geotiff,
            band=1,
            bbox=bbox,
            target_crs=target_crs,
            target_resolution=target_resolution,
        )
        result["metadata"]["dataset"] = {
            "inputFormat": input_format,
            "variable": str(variable.name),
            "dimensions": list(variable.dims),
            "sourceAttributes": {key: str(value)[:500] for key, value in dict(variable.attrs).items()},
        }
        result["lineage"]["inputFormat"] = input_format
        result["lineage"]["inputSha256"] = hashlib.sha256(data).hexdigest()
        result["lineage"]["inputBytes"] = len(data)
        result["lineage"]["steps"].insert(0, {
            "operation": "dataset_decode",
            "format": input_format,
            "variable": str(variable.name),
            "transformedToGeoTIFF": True,
        })
        result["limitations"].append("Dataset georeferencing was reconstructed from coordinate arrays; verify CRS and axis order before scientific use.")
        return result
    finally:
        dataset.close()
        if isinstance(cleanup_target, tempfile.TemporaryDirectory):
            cleanup_target.cleanup()
        elif cleanup_target:
            Path(cleanup_target).unlink(missing_ok=True)

import io
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
import xarray as xr

from dataset_processing import process_dataset_bytes


def sample_dataset() -> xr.Dataset:
    values = np.arange(64, dtype="float32").reshape(8, 8)
    values[0, 0] = -9999
    dataset = xr.Dataset(
        {"temperature": (("lat", "lon"), values)},
        coords={"lat": np.linspace(0.5, -0.4, 8), "lon": np.linspace(36.0, 36.7, 8)},
        attrs={"crs": "EPSG:4326"},
    )
    dataset.temperature.attrs["_FillValue"] = np.float32(-9999)
    return dataset


def netcdf_bytes(dataset: xr.Dataset) -> bytes:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "sample.nc"
        dataset.to_netcdf(path, engine="netcdf4")
        return path.read_bytes()


def zarr_zip_bytes(dataset: xr.Dataset) -> bytes:
    buffer = io.BytesIO()
    with tempfile.TemporaryDirectory() as directory:
        store = Path(directory) / "store.zarr"
        dataset.to_zarr(store, mode="w", consolidated=False)
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in store.rglob("*"):
                if path.is_file():
                    archive.write(path, path.relative_to(store).as_posix())
    return buffer.getvalue()


class DatasetProcessingTests(unittest.TestCase):
    def test_netcdf_statistics_exclude_nodata(self):
        result = process_dataset_bytes(netcdf_bytes(sample_dataset()), filename="sample.nc", variable_name="temperature")
        self.assertEqual(result["metadata"]["dataset"]["inputFormat"], "netcdf")
        self.assertEqual(result["metadata"]["dataset"]["variable"], "temperature")
        self.assertEqual(result["statistics"]["totalPixels"], 64)
        self.assertEqual(result["statistics"]["validPixels"], 63)
        self.assertTrue(any(step["operation"] == "dataset_decode" for step in result["lineage"]["steps"]))

    def test_zarr_store_zip_is_processed(self):
        result = process_dataset_bytes(zarr_zip_bytes(sample_dataset()), filename="sample.zip", variable_name="temperature")
        self.assertEqual(result["metadata"]["dataset"]["inputFormat"], "zarr")
        self.assertEqual(result["statistics"]["validPixels"], 63)

    def test_unsafe_zip_path_is_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("../escape.txt", "unsafe")
        with self.assertRaises(ValueError):
            process_dataset_bytes(buffer.getvalue(), filename="bad.zip")


if __name__ == "__main__":
    unittest.main()

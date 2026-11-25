import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

import artifacts
from processing import Bbox, process_raster_bytes


def tiff_bytes(array: np.ndarray, nodata: float = -9999) -> bytes:
    with rasterio.MemoryFile() as memfile:
        with memfile.open(
            driver="GTiff",
            height=array.shape[0],
            width=array.shape[1],
            count=1,
            dtype=array.dtype,
            crs="EPSG:4326",
            transform=from_origin(36.0, 1.0, 0.01, 0.01),
            nodata=nodata,
        ) as dataset:
            dataset.write(array, 1)
        return memfile.read()


class RasterProcessingTests(unittest.TestCase):
    def test_statistics_exclude_nodata_and_preserve_lineage(self):
        array = np.array([[1, 2, 3], [4, -9999, 6], [7, 8, 9]], dtype="float32")
        result = process_raster_bytes(tiff_bytes(array))
        self.assertEqual(result["statistics"]["validPixels"], 8)
        self.assertEqual(result["statistics"]["totalPixels"], 9)
        self.assertAlmostEqual(result["statistics"]["mean"], 5.0)
        self.assertEqual(result["metadata"]["output"]["crs"], "EPSG:4326")
        self.assertEqual(len(result["lineage"]["inputSha256"]), 64)

    def test_clip_reproject_and_resample(self):
        array = np.arange(100, dtype="float32").reshape(10, 10)
        result = process_raster_bytes(
            tiff_bytes(array, nodata=-1),
            bbox=Bbox(west=36.02, south=0.92, east=36.08, north=0.98),
            target_crs="EPSG:3857",
            target_resolution=500,
        )
        self.assertEqual(result["metadata"]["output"]["crs"], "EPSG:3857")
        self.assertEqual(result["metadata"]["output"]["resolution"], [500.0, 500.0])
        self.assertTrue(any(step["operation"] == "clip" for step in result["lineage"]["steps"]))
        self.assertTrue(any(step["operation"] == "reproject_resample" for step in result["lineage"]["steps"]))

    def test_invalid_inputs_fail_closed(self):
        with self.assertRaises(ValueError):
            process_raster_bytes(b"not a tiff")
        with self.assertRaises(ValueError):
            process_raster_bytes(tiff_bytes(np.ones((2, 2), dtype="float32")), band=2)
        with self.assertRaises(ValueError):
            process_raster_bytes(tiff_bytes(np.ones((2, 2), dtype="float32")), bbox=Bbox(west=2, south=2, east=1, north=1))

    def test_persist_result_writes_artifact_to_bounded_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            original = artifacts.ARTIFACT_DIR
            artifacts.ARTIFACT_DIR = Path(directory)
            try:
                result = artifacts.persist_result({"statistics": {"mean": 1}, "lineage": {"inputSha256": "abc"}})
                self.assertTrue(result["artifactRef"].startswith("raster:"))
                self.assertGreater(result["artifactBytes"], 0)
                self.assertEqual(len(list(Path(directory).glob("*.json"))), 1)
            finally:
                artifacts.ARTIFACT_DIR = original


if __name__ == "__main__":
    unittest.main()

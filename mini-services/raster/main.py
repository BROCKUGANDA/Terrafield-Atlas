from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from processing import Bbox, process_raster_bytes
from dataset_processing import process_dataset_bytes

app = FastAPI(title="TerraField Raster Processing Service", version="2026.11")
MAX_BYTES = 50 * 1024 * 1024


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "terrafield-raster", "version": "2026.11"}


@app.post("/v1/raster/stats")
async def raster_stats(
    file: UploadFile = File(...),
    band: int = Form(1, ge=1, le=64),
    bbox: str | None = Form(None, max_length=2_000),
    target_crs: str | None = Form(None, max_length=200),
    target_resolution: float | None = Form(None, gt=0),
) -> dict:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="raster exceeds 50 MB upload limit")
    parsed_bbox = Bbox.model_validate_json(bbox) if bbox else None
    try:
        return process_raster_bytes(
            data,
            band=band,
            bbox=parsed_bbox,
            target_crs=target_crs,
            target_resolution=target_resolution,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/v1/dataset/stats")
async def dataset_stats(
    file: UploadFile = File(...),
    variable: str | None = Form(None, max_length=200),
    band: int = Form(1, ge=1, le=64),
    bbox: str | None = Form(None, max_length=2_000),
    target_crs: str | None = Form(None, max_length=200),
    target_resolution: float | None = Form(None, gt=0),
    crs: str | None = Form(None, max_length=200),
) -> dict:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="dataset exceeds 100 MB upload limit")
    parsed_bbox = Bbox.model_validate_json(bbox) if bbox else None
    try:
        return process_dataset_bytes(
            data,
            filename=file.filename or "dataset.nc",
            variable_name=variable,
            band=band,
            bbox=parsed_bbox,
            target_crs=target_crs,
            target_resolution=target_resolution,
            crs_override=crs,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

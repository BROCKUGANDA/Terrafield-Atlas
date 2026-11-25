from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

ARTIFACT_DIR = Path(os.environ.get("RASTER_ARTIFACT_DIR", "/artifacts"))


def persist_result(result: dict[str, Any]) -> dict[str, Any]:
    canonical = json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    path = ARTIFACT_DIR / f"{digest}.json"
    if not path.exists():
        temporary = ARTIFACT_DIR / f"{digest}.json.tmp"
        temporary.write_bytes(canonical)
        temporary.replace(path)
    return {
        **result,
        "artifactRef": f"raster:{digest}",
        "artifactBytes": path.stat().st_size,
    }

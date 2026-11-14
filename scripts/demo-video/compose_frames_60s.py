#!/usr/bin/env python3
"""
TerraField Atlas — 60-second cut frame compositor (Pillow).

Same frame contract as compose_frames.py, driven by scenes-60.json:
title card + closing card + HUD-labeled shots with correct NN/06 scene
counters, emitted to composed-60/ for build_video_60s.py.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import compose_frames as cf  # noqa: E402  (reuse palette, cards, hud)

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "composed-60"
OUT.mkdir(exist_ok=True)

scenes = json.loads((ROOT / "scenes-60.json").read_text())

# Raw 1600×900 screenshots behind each shot scene (the 60 s cut reuses the
# full tour's captures — same mission console, condensed story).
RAW_FRAMES = {
    "60-fire-signs": "s03b-fire-top.png",
    "60-watchlists": "s06-push-live.png",
    "60-digest-exits": "s07-digest.png",
    "60-system-health": "s08b-settings-providers.png",
}


def main() -> None:
    total = len(scenes)
    for i, s in enumerate(scenes):
        if s["kind"] == "title":
            img = cf.title_card()
        elif s["kind"] == "closing":
            img = cf.closing_card()
        else:
            img = cf.shot_frame(RAW_FRAMES[s["id"]], s["label"], i, total)
        out = OUT / f"{i:02d}-{s['id']}.png"
        img.save(out)
        print(f"frame: {out.name}")
    print(f"done → {OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
TerraField Atlas — 60-second cut narration generator.

Synthesizes one WAV per scene of scenes-60.json with the z-ai TTS CLI
(voice 'jam', speed 1.2 — same voice as the full tour) into audio-60/,
and writes narration-script-60.md. The 60 s cut reuses the composed
frames of the full pipeline; only the narration is condensed.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
AUDIO = ROOT / "audio-60"
AUDIO.mkdir(exist_ok=True)
SCENES = json.loads((ROOT / "scenes-60.json").read_text())


def tts(text: str, out: pathlib.Path) -> None:
    assert len(text) <= 1024, f"segment too long: {len(text)}"
    cmd = ["z-ai", "tts", "-i", text, "-o", str(out), "--voice", "jam", "--speed", "1.25", "--format", "wav"]
    for attempt in (1, 2, 3):
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            if out.stat().st_size > 2000:
                return
        except subprocess.CalledProcessError as e:
            print(f"  attempt {attempt} failed: {e.stderr.decode()[:200]}", file=sys.stderr)
        except subprocess.TimeoutExpired:
            print(f"  attempt {attempt} timed out", file=sys.stderr)
    raise RuntimeError(f"TTS failed for {out.name}")


def main() -> None:
    lines = [
        "# TerraField Atlas — 60-second cut narration script",
        "",
        "Voice: `jam` (English) · speed 1.25 · one WAV per scene, 24000 Hz.",
        "Condensed from the full 10-scene tour for the Space Apps submission form.",
        "",
    ]
    manifest = []
    total_chars = 0
    for i, s in enumerate(SCENES):
        out = AUDIO / f"{i:02d}-{s['id']}.wav"
        print(f"[{i:02d}] TTS: {s['id']} ({len(s['narration'])} chars)")
        tts(s["narration"], out)
        total_chars += len(s["narration"])
        manifest.append({**s, "audio": str(out)})
        lines += [f"## Scene {i + 1} — `{s['id']}` ({s['kind']})", f"**Overlay label:** {s['label']}", "", f"> {s['narration']}", ""]
    (ROOT / "scenes-60.json").write_text(json.dumps(manifest, indent=1))
    (ROOT / "narration-script-60.md").write_text("\n".join(lines))
    print(f"total narration chars: {total_chars} (~{total_chars / 14:.0f}s at speed 1.2)")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
TerraField Atlas — hackathon demo narration generator.

Writes narration-script.md (the human-readable TTS script) and synthesizes
one WAV per scene with the z-ai TTS CLI (voice 'jam', English narration,
speed 1.2 for an energetic mission-brief pace).

Output: scripts/demo-video/audio/NN.wav + narration-script.md + scenes.json
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
AUDIO = ROOT / "audio"
AUDIO.mkdir(exist_ok=True)

# Scene order matches the frame composition step exactly.
SCENES = [
    {
        "id": "00-title",
        "kind": "title",
        "label": "TERRAFIELD ATLAS",
        "narration": (
            "TerraField Atlas — NASA Earth intelligence for agricultural resilience, "
            "built for the NASA Space Apps Challenge. This is the end-to-end tour."
        ),
    },
    {
        "id": "01-landing",
        "kind": "shot",
        "frame": "s01-landing.png",
        "label": "MISSION OVERVIEW · GUIDED TOUR",
        "narration": (
            "The mission overview briefs the operator, and a guided seventeen-step tour "
            "walks new users through every module — automatically on first run."
        ),
    },
    {
        "id": "02-dashboard",
        "kind": "shot",
        "frame": "s02-dashboard.png",
        "label": "EARTH INTELLIGENCE · HONEST TRENDS",
        "narration": (
            "Earth Intelligence ingests the real NASA POWER record and tests it with "
            "seasonal Mann-Kendall statistics and multiple-testing control. Missing days "
            "are reported as missing — never imputed."
        ),
    },
    {
        "id": "03-fire-signs",
        "kind": "shot",
        "frame": "s03b-fire-top.png",
        "label": "FIRE INTELLIGENCE · LIVE SOURCE SIGNS",
        "narration": (
            "Fire Intelligence decodes the VIIRS thermal anomaly stream — the same "
            "detections NASA FIRMS distributes. Live probes show which upstreams answer "
            "right now: the detection stream is live; the FIRMS API host is blocked here — "
            "flagged, never faked. NASA EONET adds live wildfire events."
        ),
    },
    {
        "id": "04-fire-calendar",
        "kind": "shot",
        "frame": "s04-fire-calendar.png",
        "label": "FIRE CALENDAR · DETECTION LEDGER",
        "narration": (
            "Detections land in a queryable ledger with a fire calendar, confidence "
            "classes, and radiative power. Archive gaps are reported as no-data — never "
            "zero-filled."
        ),
    },
    {
        "id": "05-watchlists",
        "kind": "shot",
        "frame": "s06-push-live.png",
        "label": "FIRE WATCHLISTS · SCHEDULED RUN",
        "narration": (
            "Regional watchlists define a geography and a threshold rule. This Zambia list "
            "runs on a six-hour cadence: the scheduler claimed it atomically, evaluated the "
            "real GIBS stream, and recorded a scheduled run — while backtest mode replays "
            "the same rule on any historical date."
        ),
    },
    {
        "id": "06-digest-push",
        "kind": "shot",
        "frame": "s07-digest.png",
        "label": "PUSH DIGEST · SSE CHANNEL",
        "narration": (
            "Every run pushes a cadence-aware digest over Server-Sent Events — the push "
            "chip counts it live. The digest window derives from the cadence itself, and "
            "the same payload exits through a signed webhook."
        ),
    },
    {
        "id": "07-system-health",
        "kind": "shot",
        "frame": "s08b-settings-providers.png",
        "label": "SYSTEM HEALTH · CRITICAL INFRASTRUCTURE",
        "narration": (
            "System Health is the operational truth: liveness and readiness probes, a "
            "scheduler watchdog, circuit breakers, and per-provider latency — one hundred "
            "twenty requests logged, success and failure, nothing hidden."
        ),
    },
    {
        "id": "08-provenance",
        "kind": "shot",
        "frame": "s10-provenance.png",
        "label": "EVIDENCE & PROVENANCE",
        "narration": (
            "Every number is traceable: the evidence ledger records each request — status, "
            "latency, and correlation I D — so any claim audits back to its exact retrieval."
        ),
    },
    {
        "id": "09-closing",
        "kind": "closing",
        "label": "REAL DATA · HONEST GAPS · PUSH-DELIVERED INTELLIGENCE",
        "narration": (
            "Webhooks are signed with timestamped H MAC signatures under O W A S P guidance "
            "— replay protection and SSRF guards included. TerraField Atlas: real data, "
            "honest gaps, push-delivered intelligence."
        ),
    },
]


def write_script_md() -> pathlib.Path:
    lines = [
        "# TerraField Atlas — hackathon demo narration script",
        "",
        "Voice: `jam` (English) · speed 1.2 · one WAV per scene, 24000 Hz.",
        "Pipeline: z-ai TTS → Pillow frames → ffmpeg Ken Burns + mix → 1280×720 H.264 MP4.",
        "",
    ]
    for i, s in enumerate(SCENES, 1):
        lines += [f"## Scene {i} — `{s['id']}` ({s['kind']})", f"**Overlay label:** {s['label']}", "", f"> {s['narration']}", ""]
    p = ROOT / "narration-script.md"
    p.write_text("\n".join(lines))
    return p


def tts(text: str, out: pathlib.Path) -> None:
    assert len(text) <= 1024, f"segment too long: {len(text)}"
    cmd = ["z-ai", "tts", "-i", text, "-o", str(out), "--voice", "jam", "--speed", "1.2", "--format", "wav"]
    for attempt in (1, 2, 3):
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            if out.stat().st_size > 2000:
                return
        except subprocess.CalledProcessError as e:
            print(f"  attempt {attempt} failed: {e.stderr.decode()[:200]}", file=sys.stderr)
    raise RuntimeError(f"TTS failed for {out.name}")


def main() -> None:
    md = write_script_md()
    print(f"script: {md}")
    manifest = []
    for i, s in enumerate(SCENES):
        out = AUDIO / f"{i:02d}-{s['id']}.wav"
        print(f"[{i:02d}] TTS: {s['id']} ({len(s['narration'])} chars)")
        tts(s["narration"], out)
        manifest.append({**s, "audio": str(out)})
    (ROOT / "scenes.json").write_text(json.dumps(manifest, indent=1))
    print(f"manifest: {ROOT / 'scenes.json'}")


if __name__ == "__main__":
    main()

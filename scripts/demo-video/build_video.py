#!/usr/bin/env python3
"""
TerraField Atlas — demo video assembly (ffmpeg).

Per scene: composed 1280×720 PNG → subtle Ken Burns zoom → H.264 clip with the
scene's TTS narration (300 ms lead-in, 600 ms tail). All clips share codec
parameters and are concatenated losslessly → final MP4.

Output: download/hackathon/terrafield-atlas-demo.mp4 (+ per-scene clips).
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
COMPOSED = ROOT / "composed"
AUDIO = ROOT / "audio"
CLIPS = ROOT / "clips"
CLIPS.mkdir(exist_ok=True)
OUTDIR = pathlib.Path("/home/z/my-project/download/hackathon")
OUTDIR.mkdir(parents=True, exist_ok=True)
FINAL = OUTDIR / "terrafield-atlas-demo.mp4"

FPS = 30
LEAD_S = 0.3
TAIL_S = 0.7

scenes = json.loads((ROOT / "scenes.json").read_text())


def run(cmd: list[str]) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"cmd failed ({res.returncode}):\n{' '.join(cmd[:6])}…\n{res.stderr[-1200:]}")


def wav_duration(path: pathlib.Path) -> float:
    res = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(res.stdout.strip())


def build_clip(i: int, scene: dict) -> pathlib.Path:
    frame = COMPOSED / f"{i:02d}-{scene['id']}.png"
    wav = AUDIO / f"{i:02d}-{scene['id']}.wav"
    dur = wav_duration(wav) + LEAD_S + TAIL_S
    frames = round(dur * FPS)
    clip = CLIPS / f"{i:02d}-{scene['id']}.mp4"
    if clip.exists():
        return clip
    zoom_expr = "min(1.0+0.00035*on,1.09)"
    fc = (
        f"[0:v]zoompan=z='{zoom_expr}':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps={FPS},"
        f"format=yuv420p[v];"
        f"[1:a]aresample=48000,adelay={int(LEAD_S*1000)}|{int(LEAD_S*1000)},apad=pad_dur={TAIL_S+0.5}[a]"
    )
    run([
        "ffmpeg", "-y",
        "-i", str(frame),
        "-i", str(wav),
        "-filter_complex", fc,
        "-map", "[v]", "-map", "[a]",
        "-t", f"{dur:.3f}",
        "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        "-movflags", "+faststart",
        str(clip),
    ])
    return clip


def main() -> None:
    clips = []
    for i, s in enumerate(scenes):
        c = build_clip(i, s)
        d = wav_duration(AUDIO / f"{i:02d}-{s['id']}.wav") + LEAD_S + TAIL_S
        print(f"clip {c.name} ({d:.1f}s)")
        clips.append(c)

    concat_list = CLIPS / "list.txt"
    concat_list.write_text("".join(f"file '{c.resolve()}'\n" for c in clips))
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
        "-c", "copy", "-movflags", "+faststart", str(FINAL),
    ])
    total = wav_duration(FINAL)
    size_mb = FINAL.stat().st_size / 1e6
    print(f"FINAL: {FINAL} — {total:.1f}s, {size_mb:.1f} MB")


if __name__ == "__main__":
    main()

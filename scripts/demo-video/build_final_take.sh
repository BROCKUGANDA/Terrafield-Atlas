#!/usr/bin/env bash
# Final take of the 60-second cut at the judges'-screen resolution.
# Judges' screen dimensions are not published per-device; the universal
# Space Apps judging assumption is a 16:9 display → 1920×1080 (TF_VIDEO_SCALE=1.5).
# If actual judging-screen dimensions ever differ, re-run this script with a
# different scale, e.g. TF_VIDEO_SCALE=2.0 (2560×1440) — one knob, full re-render.
set -eu
cd /home/z/my-project/scripts/demo-video

echo "== [1/3] fresh narration recording (final voice take, z-ai TTS 'jam' @1.25) =="
python3 generate_narration_60s.py

echo "== [2/3] native 1920×1080 frame composition =="
rm -f composed-60/*.png clips-60/*.mp4
TF_VIDEO_SCALE=1.5 python3 compose_frames_60s.py

echo "== [3/3] ffmpeg assembly (1080p clips + concat) =="
TF_VIDEO_SCALE=1.5 python3 build_video_60s.py

echo "== final-take probe =="
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,codec_name -show_entries format=duration,size \
  -of default=noprint_wrappers=1 /home/z/my-project/download/hackathon/terrafield-atlas-demo-60s.mp4
echo "FINAL-TAKE DONE"

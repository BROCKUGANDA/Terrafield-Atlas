#!/usr/bin/env python3
"""
TerraField Atlas — demo frame compositor (Pillow).

Takes the browser screenshots (1600×900) + builds title/closing cards, and
emits one 1280×720 PNG per scene with a HUD-style label bar — the frames the
ffmpeg assembly step turns into the narrated demo video.

Mission palette matches the console: void navy, NASA blue, ember accents.
"""
import json
import os
import pathlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent
FRAMES = ROOT / "frames"
OUT = ROOT / "composed"
OUT.mkdir(exist_ok=True)

# Design space is 1280×720; TF_VIDEO_SCALE (default 1.0) renders every card
# natively at scale× that (e.g. 1.5 → 1920×1080 for the judges'-screen final
# take). Coordinates and font sizes are scaled by a draw proxy — no layout
# literals are touched.
SCALE = float(os.environ.get("TF_VIDEO_SCALE", "1"))
W, H = int(round(1280 * SCALE)), int(round(720 * SCALE))
VOID = (5, 9, 20)
PANEL = (10, 16, 31)
NASA = (90, 200, 250)
SIGNAL = (74, 222, 128)
CAUTION = (255, 178, 36)
EMBER = (255, 106, 61)
INK = (238, 242, 248)
DIM = (154, 167, 187)
FAINT = (109, 122, 144)
EDGE = (38, 48, 66)

F = "/usr/share/fonts/truetype/dejavu/"
def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(F + name, max(1, int(round(size * SCALE))))


class _ScaledDraw:
    """Draw proxy that scales every coordinate and stroke width by SCALE."""

    def __init__(self, d: ImageDraw.ImageDraw) -> None:
        self._d = d

    def _pt(self, xy):  # point, box, or list of points
        if isinstance(xy, (list, tuple)):
            if xy and isinstance(xy[0], (list, tuple)):
                return [tuple(int(round(c * SCALE)) for c in p) for p in xy]
            return tuple(int(round(c * SCALE)) for c in xy)
        return xy

    @staticmethod
    def _width(kw: dict) -> dict:
        if "width" in kw:
            kw["width"] = max(1, int(round(kw["width"] * SCALE)))
        return kw

    def text(self, xy, txt, **kw):
        return self._d.text(self._pt(xy), txt, **kw)

    def line(self, xy, **kw):
        return self._d.line(self._pt(xy), **self._width(kw))

    def rectangle(self, box, **kw):
        return self._d.rectangle(self._pt(box), **self._width(kw))

    def ellipse(self, box, **kw):
        return self._d.ellipse(self._pt(box), **self._width(kw))


def Draw(img: Image.Image) -> _ScaledDraw:
    return _ScaledDraw(ImageDraw.Draw(img))

F_MONO = "DejaVuSansMono.ttf"
F_MONO_B = "DejaVuSansMono-Bold.ttf"
F_SANS_B = "DejaVuSans-Bold.ttf"

scenes = json.loads((ROOT / "scenes.json").read_text())


def crosshair_grid(draw: ImageDraw.ImageDraw) -> None:
    for x in range(0, W, 64):
        draw.line([(x, 0), (x, H)], fill=(8, 13, 25), width=1)
    for y in range(0, H, 64):
        draw.line([(0, y), (W, y)], fill=(8, 13, 25), width=1)


def kicker(draw, xy, text, color, size=13):
    draw.text(xy, text.upper(), font=font(F_MONO_B, size), fill=color)


def title_card() -> Image.Image:
    img = Image.new("RGB", (W, H), VOID)
    d = Draw(img)
    crosshair_grid(d)
    # glow band
    bh = int(round(160 * SCALE))
    band = Image.new("RGB", (W, bh), VOID)
    bd = Draw(band)
    for i in range(bh):
        t = abs(bh / 2 - i) / (bh / 2)
        bd.line([(0, i), (W, i)], fill=(int(20 * (1 - t)), int(60 * (1 - t)), int(110 * (1 - t))))
    img.paste(band.filter(ImageFilter.GaussianBlur(6 * SCALE)), (0, int(round(210 * SCALE))))
    d = Draw(img)
    # mission patch: concentric reticle
    cx, cy, r = 200, 320, 70
    for rr, c in [(r + 14, EDGE), (r, NASA), (r - 26, EDGE)]:
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=c, width=3)
    d.line([(cx - r - 24, cy), (cx - r + 8, cy)], fill=NASA, width=3)
    d.line([(cx + r - 8, cy), (cx + r + 24, cy)], fill=NASA, width=3)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=EMBER)
    kicker(d, (330, 240), "NASA SPACE APPS CHALLENGE 2026 · FIELD SHIFT", NASA, 15)
    d.text((330, 272), "TERRAFIELD", font=font(F_SANS_B, 64), fill=INK)
    d.text((330, 344), "ATLAS", font=font(F_SANS_B, 64), fill=NASA)
    d.text((330, 430), "NASA Earth intelligence for agricultural resilience", font=font(F_SANS_B, 21), fill=DIM)
    d.text((330, 466), "real satellite observations · auditable statistics · push-delivered fire intelligence",
           font=font(F_MONO, 15), fill=FAINT)
    # telemetry footer
    kicker(d, (64, 620), "POWER · GIBS · EONET · FIRMS — EVERY NUMBER TRACEABLE TO SOURCE + RETRIEVAL TIME", FAINT, 12)
    d.line([(64, 648), (W - 64, 648)], fill=EDGE, width=1)
    d.text((64, 664), "END-TO-END PLATFORM DEMO · VOICE NARRATION · TTS + PILLOW + FFMPEG PIPELINE",
           font=font(F_MONO, 12), fill=DIM)
    return img


def closing_card() -> Image.Image:
    img = Image.new("RGB", (W, H), VOID)
    d = Draw(img)
    crosshair_grid(d)
    kicker(d, (64, 90), "MISSION SUMMARY", NASA, 15)
    rows = [
        ("SOURCES", "NASA POWER · GIBS VIIRS/MODIS · EONET · FIRMS stream · ISRIC SoilGrids", SIGNAL),
        ("FIRE WATCH", "regional watchlists · 6/12/24 h cadences · atomic scheduler · SSE push digests", SIGNAL),
        ("DELIVERY", "signed webhooks (HMAC v1, replay window, SSRF guard) · SMTP for scheduler facts", SIGNAL),
        ("INFRASTRUCTURE", "/healthz · /readyz · watchdog · circuit breakers · stale-while-revalidate", SIGNAL),
        ("HONESTY", "archive gaps reported as no-data · failures logged · nothing fabricated", CAUTION),
    ]
    y = 150
    for k, v, c in rows:
        d.text((64, y), k.ljust(16), font=font(F_MONO_B, 16), fill=c)
        d.text((300, y), v, font=font(F_MONO, 16), fill=DIM)
        y += 52
    d.line([(64, y + 12), (W - 64, y + 12)], fill=EDGE, width=1)
    d.text((64, y + 40), "REAL DATA · HONEST GAPS · PUSH-DELIVERED INTELLIGENCE", font=font(F_SANS_B, 30), fill=INK)
    d.text((64, y + 92), "TerraField Atlas — NASA Space Apps Challenge 2026", font=font(F_MONO, 15), fill=FAINT)
    return img


def hud_label(img: Image.Image, label: str, idx: int, total: int) -> Image.Image:
    bar_h = int(round(46 * SCALE))
    out = img.copy()
    d = Draw(out)
    # top-left HUD chip
    d.rectangle([0, 0, 560, bar_h], fill=(7, 12, 24))
    d.rectangle([0, 0, 4, bar_h], fill=EMBER)
    d.text((18, 14), f"{idx:02d}/{total:02d}", font=font(F_MONO_B, 14), fill=NASA)
    d.text((78, 14), label.upper(), font=font(F_MONO_B, 14), fill=INK)
    d.text((W - 210, 14), "TERRAFIELD ATLAS · LIVE", font=font(F_MONO, 12), fill=FAINT)
    return out


def shot_frame(name: str, label: str, idx: int, total: int) -> Image.Image:
    src = Image.open(FRAMES / name).convert("RGB")
    # 1600×900 capture → cover the design frame (0.8 scale at 1280×720;
    # at TF_VIDEO_SCALE=1.5 the capture upscales 1.2× with LANCZOS)
    if src.size != (W, H):
        src = src.resize((W, H), Image.LANCZOS)
    return hud_label(src, label, idx, total)


def main() -> None:
    total = len(scenes)
    for i, s in enumerate(scenes):
        if s["kind"] == "title":
            img = title_card()
        elif s["kind"] == "closing":
            img = closing_card()
        else:
            img = shot_frame(s["frame"], s["label"], i, total)
        out = OUT / f"{i:02d}-{s['id']}.png"
        img.save(out)
        print(f"frame: {out.name}")
    print(f"done → {OUT}")


if __name__ == "__main__":
    main()

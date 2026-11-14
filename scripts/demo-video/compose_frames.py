#!/usr/bin/env python3
"""
TerraField Atlas — demo frame compositor (Pillow).

Takes the browser screenshots (1600×900) + builds title/closing cards, and
emits one 1280×720 PNG per scene with a HUD-style label bar — the frames the
ffmpeg assembly step turns into the narrated demo video.

Mission palette matches the console: void navy, NASA blue, ember accents.
"""
import json
import pathlib
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent
FRAMES = ROOT / "frames"
OUT = ROOT / "composed"
OUT.mkdir(exist_ok=True)

W, H = 1280, 720
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
    return ImageFont.truetype(F + name, size)

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
    d = ImageDraw.Draw(img)
    crosshair_grid(d)
    # glow band
    band = Image.new("RGB", (W, 160), VOID)
    bd = ImageDraw.Draw(band)
    for i in range(160):
        t = abs(80 - i) / 80
        bd.line([(0, i), (W, i)], fill=(int(20 * (1 - t)), int(60 * (1 - t)), int(110 * (1 - t))))
    img.paste(band.filter(ImageFilter.GaussianBlur(6)), (0, 210))
    d = ImageDraw.Draw(img)
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
    d = ImageDraw.Draw(img)
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
    bar_h = 46
    out = img.copy()
    d = ImageDraw.Draw(out)
    # top-left HUD chip
    d.rectangle([0, 0, 560, bar_h], fill=(7, 12, 24))
    d.rectangle([0, 0, 4, bar_h], fill=EMBER)
    d.text((18, 14), f"{idx:02d}/{total:02d}", font=font(F_MONO_B, 14), fill=NASA)
    d.text((78, 14), label.upper(), font=font(F_MONO_B, 14), fill=INK)
    d.text((W - 210, 14), "TERRAFIELD ATLAS · LIVE", font=font(F_MONO, 12), fill=FAINT)
    return out


def shot_frame(name: str, label: str, idx: int, total: int) -> Image.Image:
    src = Image.open(FRAMES / name).convert("RGB")
    # 1600×900 → cover 1280×720 (exact 0.8 scale, no crop needed)
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

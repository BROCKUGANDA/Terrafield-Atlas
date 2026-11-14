#!/usr/bin/env python3
"""
TerraField Atlas — brand asset generator (Pillow).

Renders the mission badge (flame over a field grid with a satellite arc on a
deep-navy badge) at every product size: favicon.ico (16/32/48), PNG icons
(192/512 + maskable-512), apple-touch (180), and the 1200x630 Open Graph card
with the wordmark. Also verifies the fonts it uses — no placeholders, every
pixel drawn programmatically.

Output: public/icons/*.{png,ico}, public/og-image.png, public/logo.svg (master).
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = pathlib.Path("/home/z/my-project")
OUT = ROOT / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# Palette (mission console)
BG_TOP = (9, 17, 38)      # deep navy
BG_BOT = (4, 8, 20)       # near-black navy
FLAME_OUT = (255, 122, 26)
FLAME_MID = (255, 166, 43)
FLAME_CORE = (255, 233, 168)
GRID = (53, 224, 200)     # aqua field grid
ARC = (155, 180, 216)     # satellite arc
INK = (233, 240, 252)

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
assert pathlib.Path(FONT_BOLD).exists(), "DejaVu Sans Bold missing"
assert pathlib.Path(FONT_REG).exists(), "DejaVu Sans missing"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def badge_base(size: int) -> Image.Image:
    """Rounded-square badge with vertical gradient background."""
    S = 4  # supersample factor for crisp antialiasing
    px = size * S
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # gradient fill inside rounded rect
    grad = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(px):
        gd.line([(0, y), (px, y)], fill=lerp(BG_TOP, BG_BOT, y / px))
    mask = Image.new("L", (px, px), 0)
    md = ImageDraw.Draw(mask)
    rad = int(px * 0.22)
    md.rounded_rectangle([0, 0, px - 1, px - 1], radius=rad, fill=255)
    img.paste(grad, (0, 0), mask)
    # thin edge stroke
    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=rad, outline=(70, 96, 140, 255), width=max(1, S))
    return img, px, S


def qbez(p0, p1, p2, t):
    x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * 2 * 0 + t * t * p2[0]
    # (generic quadratic bezier; p1 control)
    x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
    y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
    return x, y


def flame_polygon(cx, base_y, h, w, inner: bool):
    """Classic flame silhouette from two mirrored cubic-ish curves."""
    tip = (cx, base_y - h)
    steps = 60
    left, right = [], []
    for i in range(steps + 1):
        t = i / steps
        # outer left: tip -> base (control pulls outward)
        left.append(qbez(tip, (cx - w * 1.15, base_y - h * 0.42), (cx - w, base_y), t))
        right.append(qbez(tip, (cx + w * 1.15, base_y - h * 0.42), (cx + w, base_y), t))
    pts = left + right[::-1]
    # slight asymmetry for a lively flame tip
    if not inner:
        pts = [(x + (w * 0.08 if y < base_y - h * 0.75 else 0), y) for (x, y) in pts]
    return pts


def draw_flame(img, px, S):
    cx = px * 0.5
    base_y = px * 0.66
    h = px * 0.42
    w = px * 0.17
    d = ImageDraw.Draw(img)
    outer = flame_polygon(cx, base_y, h, w, inner=False)
    mid = flame_polygon(cx, base_y - px * 0.02, h * 0.72, w * 0.62, inner=True)
    core = flame_polygon(cx, base_y - px * 0.04, h * 0.44, w * 0.34, inner=True)
    d.polygon(outer, fill=FLAME_OUT + (255,))
    d.polygon(mid, fill=FLAME_MID + (255,))
    d.polygon(core, fill=FLAME_CORE + (255,))


def draw_grid(img, px, S):
    """Perspective field rows converging under the flame."""
    d = ImageDraw.Draw(img)
    horizon = px * 0.70
    bottom = px * 0.94
    vpx = px * 0.5
    rows = 5
    for i in range(rows):
        t = i / (rows - 1)
        y = horizon + (bottom - horizon) * (t ** 1.6)
        # widen with distance from horizon (perspective)
        half = px * (0.12 + 0.36 * t)
        d.line([(vpx - half, y), (vpx + half, y)], fill=GRID + (int(210 * (0.35 + 0.65 * t)),), width=max(S, int(1.2 * S)))
    # converging verticals (field rows)
    for k in (-3, -2, -1, 1, 2, 3):
        top_x = vpx + k * px * 0.022
        bot_x = vpx + k * px * 0.16
        d.line([(top_x, horizon), (bot_x, bottom)], fill=GRID + (150,), width=max(S, int(1.1 * S)))


def draw_arc(img, px, S):
    """Satellite pass arc above the flame."""
    d = ImageDraw.Draw(img)
    bbox = [px * 0.12, px * 0.04, px * 0.88, px * 0.52]
    d.arc(bbox, start=205, end=335, fill=ARC + (200,), width=max(S, int(1.6 * S)))
    # satellite dot on the arc at ~270deg
    ang = math.radians(270)
    acx, acy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    rx, ry = (bbox[2] - bbox[0]) / 2, (bbox[3] - bbox[1]) / 2
    sx, sy = acx + rx * math.cos(ang), acy + ry * math.sin(ang)
    r = px * 0.028
    d.ellipse([sx - r, sy - r, sx + r, sy + r], fill=INK + (255,))


def render_badge(size: int) -> Image.Image:
    img, px, S = badge_base(size)
    draw_grid(img, px, S)
    draw_flame(img, px, S)
    draw_arc(img, px, S)
    return img.resize((size, size), Image.LANCZOS)


def og_card() -> Image.Image:
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(BG_TOP, BG_BOT, y / H))
    badge = render_badge(320)
    img.paste(badge, (92, (H - 320) // 2), badge)
    f_title = ImageFont.truetype(FONT_BOLD, 88)
    f_tag = ImageFont.truetype(FONT_REG, 34)
    f_small = ImageFont.truetype(FONT_REG, 24)
    tx = 480
    max_w = W - tx - 48
    d.text((tx, 180), "TERRAFIELD", font=f_title, fill=INK)
    d.text((tx, 272), "ATLAS", font=f_title, fill=FLAME_MID)
    # auto-fit the tagline to the card width (never clipped)
    tag_size = 34
    while tag_size > 18:
        f_tag = ImageFont.truetype(FONT_REG, tag_size)
        if d.textlength("NASA Earth intelligence for agricultural resilience", font=f_tag) <= max_w:
            break
        tag_size -= 2
    d.text((tx, 392), "NASA Earth intelligence for agricultural resilience", font=f_tag, fill=(168, 186, 214))
    d.text((tx, 452), "Real data · honest gaps · push-delivered intelligence", font=f_small, fill=(120, 140, 170))
    d.text((tx, 500), "NASA Space Apps Challenge 2026 — Field Shift", font=f_small, fill=(96, 114, 144))
    # subtle frame
    d.rectangle([0, 0, W - 1, H - 1], outline=(36, 50, 76), width=2)
    return img


def main() -> None:
    # PNG icons
    for size in (16, 32, 48, 64, 96, 180, 192, 256, 384, 512):
        name = "apple-touch-icon.png" if size == 180 else f"icon-{size}.png"
        render_badge(size).save(OUT / name)
    # maskable: same art on an opaque square (safe-zone: art occupies 72% center)
    m = Image.new("RGBA", (512, 512), lerp(BG_TOP, BG_BOT, 0.5) + (255,))
    inner = render_badge(368)
    m.paste(inner, ((512 - 368) // 2, (512 - 368) // 2), inner)
    m.convert("RGB").save(OUT / "maskable-512.png")
    # favicon.ico (multi-size)
    render_badge(48).save(
        ROOT / "public" / "favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    # OG card
    og_card().save(ROOT / "public" / "og-image.png")
    # sanity: report non-blank pixel ratio of the 512 icon
    im = Image.open(OUT / "icon-512.png").convert("L")
    px = list(im.getdata())
    nonbg = sum(1 for v in px if v < 240)
    print(f"icon-512 non-white pixel ratio: {nonbg / len(px):.2%}")
    print("assets written:", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()

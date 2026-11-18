"""Generate the hushscreen brand assets.

Draws the hushscreen mark (a dark rounded screen tile with one flat, glowing
"hush" line) at 4x supersampling, downscales it with LANCZOS, and writes the
PNG, ICO, SVG and wordmark banner files into src/assets/img/brand/.

Run from the repository root:

    python scripts/brand/generate_brand.py

Requires Python 3 and Pillow. Existing outputs are overwritten. The banners
use Noto Sans SemiBold (SIL Open Font License) from the @fontsource/noto-sans
dependency, so run `npm ci` first; the script exits with an error if it is missing.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "src" / "assets" / "img" / "brand"
FONT_PATH = REPO_ROOT / "node_modules" / "@fontsource" / "noto-sans" / "files" / "noto-sans-latin-600-normal.woff"

SCALE = 4
MASTER = 512
RESAMPLE = Image.Resampling.LANCZOS

TILE_RADIUS = 115
TILE_TOP = "#1A1C24"
TILE_BOTTOM = "#0B0C10"
HIGHLIGHT_WIDTH = 4
HIGHLIGHT_ALPHA = 0.10
HIGHLIGHT_HEIGHT_RATIO = 0.40

SCREEN_BOX = (96, 150, 416, 362)
SCREEN_RADIUS = 36
SCREEN_STROKE_WIDTH = 10
SCREEN_STROKE_ALPHA = 0.18
SCREEN_FILL_ALPHA = 0.25

LINE_Y = 256
LINE_X0 = 150
LINE_X1 = 362
LINE_THICKNESS = 14
LINE_LEFT = "#FFB36B"
LINE_RIGHT = "#FF5E7A"
GLOW_BLUR = 18
GLOW_ALPHA = 0.60

WHITE = "#FFFFFF"
BLACK = "#000000"

TOUCH_ICONS = (
    ("touchicon512.png", 512),
    ("touchicon144.png", 144),
    ("touchicon114.png", 114),
    ("touchicon72.png", 72),
    ("touchicon.png", 180),
)
FAVICON_SIZES = [(16, 16), (32, 32), (48, 48)]

BANNER_SIZE = (1302, 378)
BANNER_ICON_PX = 300
BANNER_ICON_X = 24
BANNER_ICON_Y = (BANNER_SIZE[1] - BANNER_ICON_PX) // 2
BANNER_CENTRE_Y = BANNER_ICON_Y + BANNER_ICON_PX // 2
BANNER_TEXT = "hushscreen"
BANNER_FONT_PX = 168
BANNER_TRACKING = -4
BANNER_TEXT_X = 360
BANNER_LIGHT_TEXT = "#FFFFFF"
BANNER_DARK_TEXT = "#111318"

SVG_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{tile_top}"/>
      <stop offset="1" stop-color="{tile_bottom}"/>
    </linearGradient>
    <linearGradient id="hush" x1="{line_x0}" y1="0" x2="{line_x1}" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="{line_left}"/>
      <stop offset="1" stop-color="{line_right}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="{band_height}" gradientUnits="userSpaceOnUse">
{fade_stops}
    </linearGradient>
    <mask id="top40" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <rect width="512" height="512" fill="url(#fade)"/>
    </mask>
    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <feGaussianBlur stdDeviation="{glow_blur}"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="{tile_radius}" fill="url(#tile)"/>
  <rect x="2" y="2" width="508" height="508" rx="{highlight_rx}" fill="none" stroke="{white}" stroke-opacity="{highlight_alpha}" stroke-width="{highlight_width}" mask="url(#top40)"/>
  <rect x="96" y="150" width="320" height="212" rx="{screen_radius}" fill="{black}" fill-opacity="{screen_fill_alpha}"/>
  <rect x="101" y="155" width="310" height="202" rx="{screen_stroke_rx}" fill="none" stroke="{white}" stroke-opacity="{screen_stroke_alpha}" stroke-width="{screen_stroke_width}"/>
  <line x1="{line_x0}" y1="{line_y}" x2="{line_x1}" y2="{line_y}" stroke="url(#hush)" stroke-width="{line_thickness}" stroke-linecap="round" opacity="{glow_alpha}" filter="url(#glow)"/>
  <line x1="{line_x0}" y1="{line_y}" x2="{line_x1}" y2="{line_y}" stroke="url(#hush)" stroke-width="{line_thickness}" stroke-linecap="round"/>
</svg>
"""


def hex_rgb(value):
    digits = value.lstrip("#")
    return tuple(int(digits[i:i + 2], 16) for i in (0, 2, 4))


def lerp(start, end, t):
    return round(start + (end - start) * t)


def mix(left, right, t):
    return tuple(lerp(a, b, t) for a, b in zip(left, right)) + (255,)


def scaled(value):
    return round(value * SCALE)


def scaled_box(box):
    return tuple(scaled(v) for v in box)


def downscale(image, px):
    return image.resize((px, px), RESAMPLE)


def scale_mask(mask, alpha):
    return mask.point(lambda v: round(v * alpha))


def vertical_gradient(size, top, bottom):
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    top_rgb, bottom_rgb = hex_rgb(top), hex_rgb(bottom)
    for y in range(size[1]):
        draw.line([(0, y), (size[0] - 1, y)], fill=mix(top_rgb, bottom_rgb, y / (size[1] - 1)))
    return image


def horizontal_gradient(size, left, right, x_start, x_end):
    """Colour runs from left at x_start to right at x_end, clamped outside that span."""
    image = Image.new("RGBA", size)
    draw = ImageDraw.Draw(image)
    left_rgb, right_rgb = hex_rgb(left), hex_rgb(right)
    for x in range(size[0]):
        t = min(1.0, max(0.0, (x - x_start) / (x_end - x_start)))
        draw.line([(x, 0), (x, size[1] - 1)], fill=mix(left_rgb, right_rgb, t))
    return image


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def composite_colour(canvas, colour, mask):
    layer = Image.new("RGBA", canvas.size, hex_rgb(colour) + (0,))
    layer.putalpha(mask)
    canvas.alpha_composite(layer)


def fade_value(t):
    """Eased fade from 1 at t=0 to 0 at t=1 (smoothstep complement), clamped outside."""
    t = min(1.0, max(0.0, t))
    return 1 - (3 * t * t - 2 * t ** 3)


def fade_mask(size):
    """Vertical fade: full at the top edge, eased to zero at HIGHLIGHT_HEIGHT_RATIO of the height."""
    fade = Image.new("L", size, 0)
    draw = ImageDraw.Draw(fade)
    band_bottom = round(size[1] * HIGHLIGHT_HEIGHT_RATIO)
    for y in range(band_bottom + 1):
        draw.line([(0, y), (size[0] - 1, y)], fill=round(255 * fade_value(y / band_bottom)))
    return fade


def highlight_mask(size):
    stroke = Image.new("L", size, 0)
    ImageDraw.Draw(stroke).rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1),
        radius=scaled(TILE_RADIUS),
        outline=255,
        width=scaled(HIGHLIGHT_WIDTH),
    )
    return scale_mask(ImageChops.multiply(stroke, fade_mask(size)), HIGHLIGHT_ALPHA)


def fade_stops():
    """SVG gradient stops reproducing fade_value, used as the highlight mask."""
    stops = []
    for step in range(5):
        t = step / 4
        grey = round(255 * fade_value(t))
        stops.append(f'      <stop offset="{t}" stop-color="#{grey:02X}{grey:02X}{grey:02X}"/>')
    return "\n".join(stops)


def screen_masks(size):
    box = scaled_box(SCREEN_BOX)
    radius = scaled(SCREEN_RADIUS)
    fill = Image.new("L", size, 0)
    ImageDraw.Draw(fill).rounded_rectangle(box, radius=radius, fill=255)
    stroke = Image.new("L", size, 0)
    ImageDraw.Draw(stroke).rounded_rectangle(box, radius=radius, outline=255, width=scaled(SCREEN_STROKE_WIDTH))
    return scale_mask(fill, SCREEN_FILL_ALPHA), scale_mask(stroke, SCREEN_STROKE_ALPHA)


def line_mask(size):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    y = scaled(LINE_Y)
    x_start, x_end = scaled(LINE_X0), scaled(LINE_X1)
    radius = scaled(LINE_THICKNESS) // 2
    draw.line([(x_start, y), (x_end, y)], fill=255, width=scaled(LINE_THICKNESS))
    for x in (x_start, x_end):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    return mask


def line_gradient(size):
    return horizontal_gradient(
        size, LINE_LEFT, LINE_RIGHT, scaled(LINE_X0), scaled(LINE_X1)
    )


def render_mark(opaque):
    """Render the mark at master scale times SCALE. Opaque output fills the square."""
    size = (scaled(MASTER), scaled(MASTER))
    canvas = vertical_gradient(size, TILE_TOP, TILE_BOTTOM)
    # The rounded rim highlight belongs to the tile's edge; on an opaque square the platform rounds the corners
    # itself, so the rim would show as an arc inside them.
    if not opaque:
        canvas.putalpha(rounded_mask(size, scaled(TILE_RADIUS)))
        composite_colour(canvas, WHITE, highlight_mask(size))
    screen_fill, screen_stroke = screen_masks(size)
    composite_colour(canvas, BLACK, screen_fill)
    composite_colour(canvas, WHITE, screen_stroke)
    gradient = line_gradient(size)
    glow = gradient.copy()
    glow_mask = line_mask(size).filter(ImageFilter.GaussianBlur(scaled(GLOW_BLUR)))
    glow.putalpha(scale_mask(glow_mask, GLOW_ALPHA))
    canvas.alpha_composite(glow)
    sharp = gradient.copy()
    sharp.putalpha(line_mask(size))
    canvas.alpha_composite(sharp)
    return canvas


def wordmark_layer(colour, font):
    """Return an RGBA layer holding the wordmark, ink-aligned at BANNER_TEXT_X and centred on the icon."""
    mask = Image.new("L", BANNER_SIZE, 0)
    draw = ImageDraw.Draw(mask)
    _, top, _, bottom = font.getbbox(BANNER_TEXT)
    origin_y = round(BANNER_CENTRE_Y - (top + bottom) / 2)
    pen_x = BANNER_TEXT_X - font.getbbox(BANNER_TEXT[0])[0]
    for char in BANNER_TEXT:
        draw.text((round(pen_x), origin_y), char, font=font, fill=255)
        pen_x += font.getlength(char) + BANNER_TRACKING
    layer = Image.new("RGBA", BANNER_SIZE, hex_rgb(colour) + (255,))
    layer.putalpha(mask)
    return layer


def write_banners(icon, font):
    icon_px = icon.resize((BANNER_ICON_PX, BANNER_ICON_PX), RESAMPLE)
    for name, colour in (
        ("banner-light.png", BANNER_LIGHT_TEXT),
        ("banner-dark.png", BANNER_DARK_TEXT),
    ):
        banner = Image.new("RGBA", BANNER_SIZE, (0, 0, 0, 0))
        banner.alpha_composite(icon_px, (BANNER_ICON_X, BANNER_ICON_Y))
        banner.alpha_composite(wordmark_layer(colour, font))
        banner.save(OUT_DIR / name)


def write_svg():
    svg = SVG_TEMPLATE.format(
        tile_top=TILE_TOP,
        tile_bottom=TILE_BOTTOM,
        tile_radius=TILE_RADIUS,
        line_x0=LINE_X0,
        line_x1=LINE_X1,
        line_y=LINE_Y,
        line_left=LINE_LEFT,
        line_right=LINE_RIGHT,
        line_thickness=LINE_THICKNESS,
        band_height=MASTER * HIGHLIGHT_HEIGHT_RATIO,
        fade_stops=fade_stops(),
        glow_blur=GLOW_BLUR,
        glow_alpha=GLOW_ALPHA,
        highlight_rx=TILE_RADIUS - HIGHLIGHT_WIDTH // 2,
        highlight_width=HIGHLIGHT_WIDTH,
        highlight_alpha=HIGHLIGHT_ALPHA,
        white=WHITE,
        black=BLACK,
        screen_radius=SCREEN_RADIUS,
        screen_fill_alpha=SCREEN_FILL_ALPHA,
        screen_stroke_rx=SCREEN_RADIUS - SCREEN_STROKE_WIDTH // 2,
        screen_stroke_width=SCREEN_STROKE_WIDTH,
        screen_stroke_alpha=SCREEN_STROKE_ALPHA,
    )
    (OUT_DIR / "icon.svg").write_text(svg, encoding="utf-8")


def main():
    if not FONT_PATH.is_file():
        sys.exit(f"Font not found: {FONT_PATH}. Run `npm ci` to install @fontsource/noto-sans.")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(FONT_PATH), BANNER_FONT_PX)

    transparent_master = render_mark(opaque=False)
    icon = downscale(transparent_master, MASTER)
    icon.save(OUT_DIR / "icon-transparent.png")

    opaque_master = render_mark(opaque=True)
    for name, px in TOUCH_ICONS:
        downscale(opaque_master, px).save(OUT_DIR / name)

    icon.save(OUT_DIR / "favicon.ico", format="ICO", sizes=FAVICON_SIZES)
    write_banners(icon, font)
    write_svg()
    print(f"Wrote brand assets to {OUT_DIR}")


if __name__ == "__main__":
    main()

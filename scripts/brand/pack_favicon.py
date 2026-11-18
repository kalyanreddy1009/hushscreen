"""Pack src/assets/img/brand/favicon.ico (16, 32 and 48 px) from the PNGs rendered by render_brand.mjs.

Run after the renderer, from the repository root:

    node scripts/brand/render_brand.mjs
    python scripts/brand/pack_favicon.py

render_brand.mjs writes favicon-16.png, favicon-32.png and favicon-48.png (16 and 32 use a simplified mark)
into <system temp>/hushscreen-brand-favicon. Requires Python 3 and Pillow.
"""

import sys
import tempfile
from pathlib import Path

from PIL import Image

SIZES = (16, 32, 48)
SRC_DIR = Path(tempfile.gettempdir()) / "hushscreen-brand-favicon"
OUT_FILE = Path(__file__).resolve().parents[2] / "src" / "assets" / "img" / "brand" / "favicon.ico"


def load(size: int) -> Image.Image:
    path = SRC_DIR / f"favicon-{size}.png"
    if not path.is_file():
        sys.exit(f"Missing {path}. Run `node scripts/brand/render_brand.mjs` first.")
    image = Image.open(path).convert("RGBA")
    if image.size != (size, size):
        sys.exit(f"{path} is {image.size}, expected {size}x{size}.")
    return image


def main() -> None:
    frames = [load(size) for size in SIZES]
    frames[-1].save(OUT_FILE, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"Wrote {OUT_FILE}")


if __name__ == "__main__":
    main()

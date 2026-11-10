"""Derive desktop branding from the same committed artwork as the web app.

Run with the workspace's existing image tooling:
    uv run --package browser-worker python apps/desktop/scripts/make_icons.py

This copies the light/dark lockups and renders the folded V at app/tray sizes.
The macOS template uses only the mark's alpha silhouette, so the OS can tint it.
"""

import shutil
import sys
from pathlib import Path

from PIL import Image


def mark_on_square(mark: Image.Image, size: int, fill: float) -> Image.Image:
    width = round(size * fill)
    height = round(width * mark.height / mark.width)
    scaled = mark.resize((width, height), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size))
    canvas.alpha_composite(scaled, ((size - width) // 2, (size - height) // 2))
    return canvas


def main() -> None:
    desktop = Path(__file__).resolve().parent.parent
    source = desktop.parent / "web" / "public" / "brand"
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else desktop / "resources"
    out.mkdir(parents=True, exist_ok=True)
    with Image.open(source / "veyquo-mark.png") as image:
        mark = image.convert("RGBA")
    mark_on_square(mark, 512, 0.8).save(out / "icon.png", optimize=True)
    mark_on_square(mark, 32, 0.94).save(out / "tray.png", optimize=True)
    for size, name in [(16, "trayTemplate.png"), (32, "trayTemplate@2x.png")]:
        canvas = mark_on_square(mark, size, 0.94)
        template = Image.new("RGBA", canvas.size)
        template.putalpha(canvas.getchannel("A"))
        template.save(out / name, optimize=True)
    for name in ["veyquo-logo.png", "veyquo-logo-dark.png"]:
        shutil.copyfile(source / name, out / name)


if __name__ == "__main__":
    main()

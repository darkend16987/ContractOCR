"""Regenerate the app icon (icon.ico + icon.png) from a source logo PNG.

The brand logo now lives as a finished raster (../../logo_nabu.png at the repo
root). This replaces the hand-drawn make_icon.py output: we downscale the logo
with LANCZOS to every size Windows needs and pack a multi-resolution .ico plus
the PNG used as the Electron window icon.

Run:  ..\\.venv\\Scripts\\python make_icon_from_logo.py   (from desktop/build)
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
# repo root is two levels up: desktop/build -> desktop -> repo
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "logo_nabu.png"))


def load_master():
    im = Image.open(SRC).convert("RGBA")
    # Square-pad if the source is not 1:1 so nothing is distorted on resize.
    w, h = im.size
    if w != h:
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
        im = canvas
    return im.resize((1024, 1024), Image.LANCZOS)


def main():
    master = load_master()
    master.save(os.path.join(HERE, "icon.png"))                 # window icon / docs
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "icon@512.png"))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save(os.path.join(HERE, "icon.ico"), sizes=[(n, n) for n in sizes])
    print("wrote icon.png (1024), icon@512.png, icon.ico", sizes, "from", SRC)


if __name__ == "__main__":
    main()

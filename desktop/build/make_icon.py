"""Generate the Nabu PDF app icon (icon.ico + icon.png) with Pillow only.

We have no SVG rasterizer on this machine (no cairosvg/inkscape/ImageMagick),
so the icon is drawn directly with ImageDraw at 3x supersample and downscaled
with LANCZOS for smooth, antialiased edges. Concept: a folded document with a
magnifier (read / OCR) on a rounded-square blue badge — clean, flat, modern.

Run:  ..\\.venv\\Scripts\\python make_icon.py   (from desktop/build)
"""
import math
import numpy as np
from PIL import Image, ImageDraw

SS = 3                      # supersample factor
U = 1024                    # design grid (logical units)
N = U * SS                  # canvas pixels


def s(v):
    return v * SS


def vertical_gradient(size, top, bottom):
    """RGB vertical linear gradient as a Pillow image."""
    h = size
    t = np.linspace(0.0, 1.0, h)[:, None]
    top = np.array(top, dtype=float)
    bottom = np.array(bottom, dtype=float)
    row = top[None, :] * (1 - t) + bottom[None, :] * t   # (h,3)
    arr = np.repeat(row[:, None, :], size, axis=1).astype(np.uint8)
    return Image.fromarray(arr, "RGB").convert("RGBA")


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_master():
    # --- background: rounded-square badge with brand-blue gradient -----------
    grad = vertical_gradient(N, (76, 184, 245), (12, 127, 214))   # #4CB8F5 -> #0C7FD6
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    img.paste(grad, (0, 0), rounded_mask(N, s(224)))

    d = ImageDraw.Draw(img, "RGBA")

    # --- soft drop shadow under the document --------------------------------
    shadow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow, "RGBA")
    sd.rounded_rectangle([s(312), s(252), s(736), s(804)], radius=s(26),
                         fill=(8, 47, 92, 90))
    img.alpha_composite(shadow)

    # --- document with folded top-right corner ------------------------------
    px0, py0, px1, py1 = s(300), s(236), s(724), s(788)
    F = s(120)                                   # fold size
    page = [
        (px0, py0),
        (px1 - F, py0),
        (px1, py0 + F),
        (px1, py1),
        (px0, py1),
    ]
    d.polygon(page, fill=(255, 255, 255, 255))
    # folded flap (underside of the turned corner)
    d.polygon([(px1 - F, py0), (px1, py0 + F), (px1 - F, py0 + F)],
              fill=(201, 222, 242, 255))

    # --- text lines on the page (OCR'd content) -----------------------------
    lx0, lx1 = s(356), s(668)
    line_h = s(22)
    for i, (y, w, col) in enumerate([
        (s(322), 1.00, (199, 210, 221, 255)),
        (s(378), 1.00, (199, 210, 221, 255)),
        (s(434), 0.62, (56, 189, 248, 255)),     # accent: an extracted field
    ]):
        d.rounded_rectangle([lx0, y, lx0 + (lx1 - lx0) * w, y + line_h],
                            radius=line_h / 2, fill=col)

    # --- magnifier (read / OCR), overlapping the lower-right ----------------
    cx, cy, R, T = s(706), s(648), s(132), s(40)
    # handle (behind the ring)
    ang = math.radians(45)
    hx0, hy0 = cx + R * math.cos(ang), cy + R * math.sin(ang)
    hx1, hy1 = cx + s(170) * math.cos(ang), cy + s(170) * math.sin(ang)
    d.line([(hx0, hy0), (hx1, hy1)], fill=(255, 255, 255, 255),
           width=int(s(48)), joint="curve")
    d.ellipse([hx1 - s(26), hy1 - s(26), hx1 + s(26), hy1 + s(26)],
              fill=(255, 255, 255, 255))
    # ring + glass
    d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(255, 255, 255, 255))
    d.ellipse([cx - (R - T), cy - (R - T), cx + (R - T), cy + (R - T)],
              fill=(214, 238, 255, 255), outline=(12, 127, 214, 255),
              width=int(s(6)))
    # two short bars inside the lens — "reading lines of text" (OCR), not a
    # single bar (which reads as a zoom-out minus sign).
    for y, w in [(cy - s(20), s(52)), (cy + s(14), s(34))]:
        d.rounded_rectangle([cx - w, y - s(7), cx + w, y + s(7)],
                            radius=s(7), fill=(56, 189, 248, 255))

    return img.resize((U, U), Image.LANCZOS)


def main():
    master = make_master()
    master.save("icon.png")                      # 1024 master for docs/store
    master.resize((512, 512), Image.LANCZOS).save("icon@512.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    master.save("icon.ico", sizes=[(n, n) for n in sizes])
    print("wrote icon.png (1024), icon@512.png, icon.ico", sizes)


if __name__ == "__main__":
    main()

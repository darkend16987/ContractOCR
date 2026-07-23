# PyInstaller build spec for the Nabu PDF desktop sidecar.
#
# Build:  pyinstaller sidecar.spec --noconfirm
# Output: dist/sidecar/sidecar.exe  (onedir — bundled by electron-builder)
#
# NOTE: torch / rapidocr / onnxruntime / vietocr ship large native libs and data
# files. collect_all() pulls binaries + datas + hidden imports for each package.
# Expect to iterate: build, run `dist/sidecar/sidecar.exe --port 8000`, read the
# ModuleNotFoundError, then add the missing module to `extra_hiddenimports` below.

from PyInstaller.utils.hooks import collect_all, copy_metadata

# Heavy packages whose binaries/datas/hidden imports must be collected wholesale.
# NB: fitz/pymupdf and matplotlib are imported *lazily* (inside functions in api.py)
# for searchable/compress/text-edit + the Vietnamese DejaVuSans font, so PyInstaller's
# static analysis misses them — they MUST be collected here or the packaged app fails
# at runtime on those features. collect_all("matplotlib") bundles mpl-data/fonts/ttf/
# DejaVuSans.ttf (the font _vietnamese_font() looks up).
# Default engine = RapidViet (RapidOCR ONNX detect + VietOCR recognise). The
# paddle stack is intentionally NOT bundled: it's only a manual fallback
# (OCR_ENGINE=paddleocr/hybrid), AutoOCREngine degrades gracefully without it, and
# dropping it shaves ~400MB off the installer/portable (paddlepaddle ~392MB +
# paddlex ~19MB + paddleocr). shapely + pyclipper feed RapidOCR's detection
# post-process; skimage/scipy arrive via vietocr (albumentations/imgaug) so stay.
HEAVY_PACKAGES = (
    "rapidocr",  # default engine: PP-OCR on onnxruntime (bundles default config yaml)
    "onnxruntime",  # native inference runtime for rapidocr; ships its own DLLs
    "torch",
    "torchvision",
    "vietocr",
    "cv2",
    "shapely",
    "pyclipper",
    "skimage",
    "scipy",
    "google.genai",
    "openpyxl",
    "docx",  # python-docx (import name); PDF→Office DOCX export, lazy-imported
    "lxml",  # python-docx's engine; ships native binaries collect_all must gather
    "fitz",  # PyMuPDF (import name); lazy-imported in api.py
    "pymupdf",  # newer PyMuPDF dist name — loop skips whichever isn't present
    "matplotlib",  # provides DejaVuSans.ttf for the Vietnamese text layer / text-edit
)

datas, binaries, hiddenimports = [], [], []
for pkg in HEAVY_PACKAGES:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # package may be optional / not importable at build time
        print(f"[sidecar.spec] skipped {pkg}: {exc}")

# Some packages probe their dependencies' *installed metadata* at runtime via
# importlib.metadata.version(). collect_all() bundles a package's own metadata but
# NOT its dependencies', so in the frozen app those lookups return None and the
# probe fails. Bundle the .dist-info metadata for the rapidocr pipeline's deps.
# Names are the *distribution* names (as on PyPI), not import names.
METADATA_PACKAGES = (
    "rapidocr",
    "onnxruntime",
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
)
for dist in METADATA_PACKAGES:
    try:
        datas += copy_metadata(dist)
    except Exception as exc:  # not installed under this dist name on the build host
        print(f"[sidecar.spec] no metadata for {dist}: {exc}")

# uvicorn loads protocol/loop implementations dynamically — name them explicitly.
extra_hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # PDF compare module — imported lazily inside the /compare endpoint, so pin it
    # explicitly to be safe against a frozen-app ModuleNotFoundError.
    "src.compare",
    "src.compare.comparator",
    # PDF helper modules (Phase 4 refactor). api.py imports these statically so the
    # analysis already follows them; pinned here too to match the project's cautious
    # convention against stale/partial frozen builds.
    "src.pdf.util",
    "src.pdf.fonts",
    "src.pdf.legacy_text",
    "src.pdf.layout",
    # PDF→Office converter — imported lazily inside the /pdf-to-office endpoint,
    # so pin it (and the analysis follows src.output.writer already).
    "src.output.pdf_office",
    # Add modules here as PyInstaller reports them missing at runtime.
]

a = Analysis(
    ["sidecar.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + extra_hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # Hard-exclude the paddle stack so a build host that still has it installed
    # doesn't drag ~400MB back in via some transitive collect. RapidViet is default.
    excludes=[
        "streamlit", "tkinter", "matplotlib.tests", "PyQt5",
        "paddle", "paddleocr", "paddlex", "paddlepaddle",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    console=True,  # P0: keep console to read OCR logs while debugging. Disable for release.
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,  # UPX corrupts some torch/onnxruntime DLLs — leave off.
    name="sidecar",
)

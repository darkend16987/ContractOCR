# PyInstaller build spec for the Nabu PDF desktop sidecar.
#
# Build:  pyinstaller sidecar.spec --noconfirm
# Output: dist/sidecar/sidecar.exe  (onedir — bundled by electron-builder)
#
# NOTE: torch / paddle / paddleocr / vietocr ship large native libs and data
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
HEAVY_PACKAGES = (
    "torch",
    "torchvision",
    "paddle",
    "paddleocr",
    "paddlex",  # paddleocr 3.x runs all inference through paddlex — must be bundled
    "vietocr",
    "cv2",
    "shapely",
    "pyclipper",
    "skimage",
    "scipy",
    "google.genai",
    "openpyxl",
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

# CRITICAL: paddlex gates every inference pipeline behind a dependency check that
# reads each package's *installed metadata* via importlib.metadata.version() (see
# paddlex/utils/deps.py). collect_all() bundles a package's own metadata but NOT
# its dependencies', so in the frozen app these lookups return None and paddlex
# raises DependencyError -> PaddleOCR reports "A dependency error occurred during
# pipeline creation". The OCR pipeline needs the paddlex `ocr-core` extra; bundle
# the .dist-info metadata for every package paddlex inspects. Names are the
# *distribution* names (as on PyPI), not import names.
METADATA_PACKAGES = (
    "paddlex",
    "paddleocr",
    "paddlepaddle",
    # paddlex `ocr-core` extra (required by the OCR detection+recognition pipeline)
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
    excludes=["streamlit", "tkinter", "matplotlib.tests", "PyQt5"],
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
    upx=False,  # UPX corrupts some torch/paddle DLLs — leave off.
    name="sidecar",
)

# PyInstaller build spec for the ContractOCR desktop sidecar.
#
# Build:  pyinstaller sidecar.spec --noconfirm
# Output: dist/sidecar/sidecar.exe  (onedir — bundled by electron-builder)
#
# NOTE: torch / paddle / paddleocr / vietocr ship large native libs and data
# files. collect_all() pulls binaries + datas + hidden imports for each package.
# Expect to iterate: build, run `dist/sidecar/sidecar.exe --port 8000`, read the
# ModuleNotFoundError, then add the missing module to `extra_hiddenimports` below.

from PyInstaller.utils.hooks import collect_all

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

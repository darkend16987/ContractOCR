"""Desktop sidecar entry point: runs the FastAPI OCR server on a given port.

Reuses the existing FastAPI `app` from api.py — no OCR logic is duplicated here.

Dev:    python sidecar.py --port 8000
Frozen: sidecar.exe --port 8000   (built via PyInstaller, see sidecar.spec)

It has a SECOND mode, used by the server itself:

    sidecar.exe --compress-worker <in.pdf> <out.pdf> <preset>

which compresses one file and exits. See the block above `_COMPRESS_WORKER_FLAG` in
api.py for why compression has to leave the server process at all; the short version
is that PyMuPDF's `rewrite_images` holds the GIL for its whole run, so a thread frees
nothing and only a separate process keeps the sidecar answering. Re-launching THIS
program means there is no second binary to build, sign or ship.
"""

from __future__ import annotations

import argparse
import sys

import uvicorn

from api import app  # the existing FastAPI app (OCR endpoints, lifespan, CORS)

# Imported, not re-declared. api.py builds the argv that launches this mode, so a second
# copy of the string here would let the two drift: the flag would stop being recognised,
# argparse would reject it, and the parent would report a bare "exited with code 2".
from api import _COMPRESS_WORKER_FLAG as COMPRESS_WORKER_FLAG


def _err(msg: str) -> None:
    """Write `msg` to stderr as UTF-8, whatever the child's locale is.

    Not cosmetic. Every message this worker can emit is Vietnamese, and a plain
    `sys.stderr.write` encodes with the console codepage (cp1258/cp1252 on Windows)
    while the parent decodes UTF-8 — so "preset phải là screen|ebook|printer|lossless"
    reached the user as mojibake. Writing bytes pins both ends to one encoding.
    """
    data = msg.encode("utf-8", "replace")
    buf = getattr(sys.stderr, "buffer", None)
    if buf is not None:
        buf.write(data)
        buf.flush()
    else:  # stderr replaced by something without a binary layer
        sys.stderr.write(msg)
        sys.stderr.flush()


def _run_compress_worker(argv: list[str]) -> int:
    """`--compress-worker <src> <dst> <preset>` — compress one file, then exit.

    Exit codes are the contract with api.py `_compress_via_worker_blocking`:
      0 = done, `dst` holds the PDF
      3 = the request was wrong (bad preset, unopenable PDF, too many pages); stderr
          carries the Vietnamese message the user should see
      1 = anything else; stderr carries the detail for the log
    stdout is deliberately left empty so nothing can be mistaken for data.
    """
    if len(argv) < 3:
        _err("Thiếu tham số cho --compress-worker")
        return 1
    src, dst, preset = argv[0], argv[1], argv[2]
    try:
        from fastapi import HTTPException

        from api import _compress_pdf_bytes

        with open(src, "rb") as f:
            data = f.read()
        try:
            out = _compress_pdf_bytes(data, preset)
        except HTTPException as e:
            _err(str(e.detail))
            return 3
        with open(dst, "wb") as f:
            f.write(out)
        return 0
    except Exception as e:  # noqa: BLE001 — the parent turns this into a user-visible error
        _err(f"{type(e).__name__}: {e}")
        return 1


def main() -> None:
    # Checked before argparse: the worker flag is not a declared server option, so
    # argparse would exit(2) on it before this branch ever ran.
    if len(sys.argv) > 1 and sys.argv[1] == COMPRESS_WORKER_FLAG:
        raise SystemExit(_run_compress_worker(sys.argv[2:]))

    parser = argparse.ArgumentParser(description="Nabu PDF desktop sidecar")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (local-only)")
    args = parser.parse_args()

    # Pass the app object (not an import string) so it works inside a frozen binary.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

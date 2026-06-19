"""Desktop sidecar entry point: runs the FastAPI OCR server on a given port.

Reuses the existing FastAPI `app` from api.py — no OCR logic is duplicated here.

Dev:    python sidecar.py --port 8000
Frozen: sidecar.exe --port 8000   (built via PyInstaller, see sidecar.spec)
"""

from __future__ import annotations

import argparse

import uvicorn

from api import app  # the existing FastAPI app (OCR endpoints, lifespan, CORS)


def main() -> None:
    parser = argparse.ArgumentParser(description="ContractOCR desktop sidecar")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (local-only)")
    args = parser.parse_args()

    # Pass the app object (not an import string) so it works inside a frozen binary.
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

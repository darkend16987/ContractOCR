"""Application configuration loaded from environment variables."""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


def _is_frozen() -> bool:
    """True when running inside a PyInstaller bundle (desktop sidecar)."""
    return getattr(sys, "frozen", False)


def _data_root() -> Path:
    """Writable base dir for app-generated files (uploads/results).

    Dev: the repo root (unchanged behaviour). Frozen: a per-user writable dir,
    because a PyInstaller bundle lives in a temp/read-only location and must not
    write next to the executable.
    """
    if _is_frozen():
        local = os.getenv("LOCALAPPDATA")  # Windows
        return Path(local) / "ContractOCR" if local else Path.home() / ".contractocr"
    return Path(__file__).resolve().parent.parent.parent


def _resolve_dir(env_var: str, default_name: str) -> Path:
    """Resolve a data dir: absolute env override respected, else under the data root."""
    override = os.getenv(env_var)
    if override:
        p = Path(override)
        return p if p.is_absolute() else _data_root() / p
    return _data_root() / default_name


# Base paths
BASE_DIR = _data_root()
UPLOAD_DIR = _resolve_dir("UPLOAD_DIR", "uploads")
RESULTS_DIR = _resolve_dir("RESULTS_DIR", "results")

# Ensure directories exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# OCR settings
OCR_ENGINE = os.getenv("OCR_ENGINE", "auto")  # "vietocr", "paddleocr", "hybrid", "auto"
VIETOCR_MODEL = os.getenv("VIETOCR_MODEL", "vgg_transformer")

# Gemini API
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

# Google Sheets (optional)
GOOGLE_SHEETS_CREDENTIALS_FILE = os.getenv("GOOGLE_SHEETS_CREDENTIALS_FILE", "credentials.json")
GOOGLE_SHEETS_SPREADSHEET_ID = os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID", "")

# Output
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "json")  # "json", "excel", "gsheet", "markdown", "all"

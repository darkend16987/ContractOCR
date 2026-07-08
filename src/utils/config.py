"""Application configuration loaded from environment variables."""

import json
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
        return Path(local) / "Nabu PDF" if local else Path.home() / ".nabupdf"
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
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

# ---- User settings (persisted, editable from the app's Settings UI) ----------
# Stored in a writable per-user file so the packaged app needs no .env / env var.
# Dev: repo root; frozen: %LOCALAPPDATA%\Nabu PDF (see _data_root()).
SETTINGS_FILE = BASE_DIR / "settings.json"


def load_settings() -> dict:
    """Read the user settings file; return {} if missing or unreadable."""
    try:
        if SETTINGS_FILE.exists():
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_settings(data: dict) -> None:
    """Persist the user settings dict (atomic-ish write)."""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)


def get_gemini_key() -> str:
    """Effective Gemini key: the key entered in the app (settings.json) wins;
    fall back to the GEMINI_API_KEY env var (dev convenience)."""
    return (load_settings().get("gemini_api_key") or "").strip() or GEMINI_API_KEY


def set_gemini_key(key: str) -> None:
    """Save the Gemini key entered by the user into settings.json."""
    data = load_settings()
    data["gemini_api_key"] = (key or "").strip()
    save_settings(data)

# Google Sheets (optional)
GOOGLE_SHEETS_CREDENTIALS_FILE = os.getenv("GOOGLE_SHEETS_CREDENTIALS_FILE", "credentials.json")
GOOGLE_SHEETS_SPREADSHEET_ID = os.getenv("GOOGLE_SHEETS_SPREADSHEET_ID", "")

# Output
OUTPUT_FORMAT = os.getenv("OUTPUT_FORMAT", "json")  # "json", "excel", "gsheet", "markdown", "all"

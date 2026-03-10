"""Application configuration loaded from environment variables."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# Base paths
BASE_DIR = Path(__file__).resolve().parent.parent.parent
UPLOAD_DIR = BASE_DIR / os.getenv("UPLOAD_DIR", "uploads")
RESULTS_DIR = BASE_DIR / os.getenv("RESULTS_DIR", "results")

# Ensure directories exist
UPLOAD_DIR.mkdir(exist_ok=True)
RESULTS_DIR.mkdir(exist_ok=True)

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

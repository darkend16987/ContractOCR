"""Output writers for saving extracted contract data."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class JSONWriter:
    """Write extracted data to JSON files."""

    def save(self, data: dict[str, Any], output_path: str | Path) -> Path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        logger.info("Saved JSON: %s", path)
        return path


class ExcelWriter:
    """Write extracted data to Excel files."""

    def __init__(self, fields_mapping: dict[str, str] | None = None):
        """Initialize with an optional mapping from data keys to human-readable headers."""
        self.fields_mapping = fields_mapping

    def save(self, data: dict[str, Any], output_path: str | Path) -> Path:
        import openpyxl

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        mapping = self.fields_mapping or {k: k for k in data.keys()}
        # Add metadata keys if not present
        for meta_key in ["_source_file", "_page", "_document_type", "_timestamp"]:
            if meta_key in data and meta_key not in mapping:
                # E.g. "_source_file" -> "Source File"
                mapping[meta_key] = meta_key.replace("_", " ").title().strip()

        if path.exists():
            wb = openpyxl.load_workbook(path)
            ws = wb.active
        else:
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = "Contracts"
            # Write header row
            headers = list(mapping.values())
            for col, header in enumerate(headers, 1):
                ws.cell(row=1, column=col, value=header)

        # Find next empty row
        next_row = ws.max_row + 1
        if next_row == 2 and ws.cell(row=1, column=1).value is None:
            # File was just created, headers are in row 1
            pass

        # Write data row matching existing header order
        existing_headers = [ws.cell(row=1, column=col).value for col in range(1, ws.max_column + 1)]
        reverse_mapping = {v: k for k, v in mapping.items()}

        for col, header in enumerate(existing_headers, 1):
            key = reverse_mapping.get(header, header)
            value = data.get(key, "")
            ws.cell(row=next_row, column=col, value=str(value) if value is not None else "")

        wb.save(path)
        logger.info("Saved Excel: %s (row %d)", path, next_row)
        return path


class CSVWriter:
    """Write extracted data to CSV files."""

    def __init__(self, fields_mapping: dict[str, str] | None = None):
        """Initialize with an optional mapping from data keys to human-readable headers."""
        self.fields_mapping = fields_mapping

    def save(self, data: dict[str, Any], output_path: str | Path) -> Path:
        import csv

        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        mapping = self.fields_mapping or {k: k for k in data.keys()}
        # Add metadata keys if not present
        for meta_key in ["_source_file", "_page", "_document_type", "_timestamp"]:
            if meta_key in data and meta_key not in mapping:
                mapping[meta_key] = meta_key.replace("_", " ").title().strip()

        file_exists = path.exists()

        # utf-8-sig ensures Excel can open the CSV and read Vietnamese correctly
        with open(path, "a", encoding="utf-8-sig", newline="") as f:
            headers = list(mapping.values())
            writer = csv.writer(f)

            if not file_exists:
                writer.writerow(headers)

            row = []
            for key in mapping.keys():
                value = data.get(key, "")
                row.append(str(value) if value is not None else "")
            writer.writerow(row)

        logger.info("Saved CSV: %s", path)
        return path



class GoogleSheetWriter:
    """Write extracted data to Google Sheets."""

    def __init__(self, credentials_file: str, spreadsheet_id: str):
        self.credentials_file = credentials_file
        self.spreadsheet_id = spreadsheet_id
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import gspread
            from google.oauth2.service_account import Credentials

            scopes = [
                "https://www.googleapis.com/auth/spreadsheets",
                "https://www.googleapis.com/auth/drive",
            ]
            creds = Credentials.from_service_account_file(
                self.credentials_file, scopes=scopes
            )
            self._client = gspread.authorize(creds)
        return self._client

    def save(self, data: dict[str, Any], sheet_name: str = "Sheet1") -> str:
        spreadsheet = self.client.open_by_key(self.spreadsheet_id)

        try:
            worksheet = spreadsheet.worksheet(sheet_name)
        except Exception:
            worksheet = spreadsheet.add_worksheet(title=sheet_name, rows=1000, cols=26)

        # Check if headers exist
        existing = worksheet.get_all_values()
        if not existing:
            headers = list(data.keys())
            worksheet.append_row(headers)

        # Append data row
        headers = worksheet.row_values(1)
        row = [str(data.get(h, "")) if data.get(h) is not None else "" for h in headers]
        worksheet.append_row(row)

        logger.info("Appended row to Google Sheet: %s", self.spreadsheet_id)
        return self.spreadsheet_id


class MarkdownWriter:
    """Write extracted data as a Markdown file."""

    def save(self, data: dict[str, Any], output_path: str | Path) -> Path:
        path = Path(output_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        lines = [f"# Thông tin hợp đồng", ""]
        lines.append(f"_Trích xuất lúc: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}_")
        lines.append("")

        for key, value in data.items():
            display_value = str(value) if value is not None else "_Không có thông tin_"
            lines.append(f"**{key}**: {display_value}")
            lines.append("")

        path.write_text("\n".join(lines), encoding="utf-8")
        logger.info("Saved Markdown: %s", path)
        return path


def create_writer(format_type: str, **kwargs):
    """Factory function to create output writers."""
    writers = {
        "json": JSONWriter,
        "excel": ExcelWriter,
        "csv": CSVWriter,
        "gsheet": GoogleSheetWriter,
        "markdown": MarkdownWriter,
    }
    if format_type not in writers:
        raise ValueError(f"Unknown format: {format_type}. Choose from: {list(writers.keys())}")
    return writers[format_type](**kwargs)

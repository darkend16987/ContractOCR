"""Main pipeline: Image -> OCR -> AI Agent -> Structured Output."""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image

from src.ocr.engine import BaseOCREngine, create_engine
from src.agents.gemini_agent import GeminiAgent, DEFAULT_CONTRACT_FIELDS
from src.output.writer import (
    JSONWriter, ExcelWriter, MarkdownWriter, GoogleSheetWriter
)
from src.utils.config import (
    OCR_ENGINE, VIETOCR_MODEL, GEMINI_API_KEY, GEMINI_MODEL,
    RESULTS_DIR, OUTPUT_FORMAT, GOOGLE_SHEETS_CREDENTIALS_FILE,
    GOOGLE_SHEETS_SPREADSHEET_ID,
)
from src.utils.image_processing import load_image, pdf_to_images

logger = logging.getLogger(__name__)


class ContractOCRPipeline:
    """End-to-end pipeline for contract OCR and data extraction.

    Pipeline steps:
    1. Load image/PDF
    2. OCR: extract raw Vietnamese text
    3. AI Agent (Gemini): parse text into structured fields
    4. Output: save to JSON/Excel/Google Sheet/Markdown
    """

    def __init__(
        self,
        ocr_engine: BaseOCREngine | None = None,
        gemini_agent: GeminiAgent | None = None,
        output_format: str | None = None,
        custom_fields: dict[str, str] | None = None,
    ):
        self.ocr_engine = ocr_engine or create_engine(
            OCR_ENGINE, **({"model_name": VIETOCR_MODEL} if OCR_ENGINE == "vietocr" else {})
        )
        self.gemini_agent = gemini_agent or GeminiAgent(
            api_key=GEMINI_API_KEY,
            model_name=GEMINI_MODEL,
        )
        self.output_format = output_format or OUTPUT_FORMAT
        self.custom_fields = custom_fields

    def process_image(self, image: Image.Image) -> dict[str, Any]:
        """Process a single image through the full pipeline.

        Returns dict with 'ocr_text', 'extracted_data', and 'classification'.
        """
        # Step 1: OCR
        logger.info("Step 1: Running OCR...")
        ocr_text = self.ocr_engine.recognize(image)
        logger.info("OCR extracted %d characters", len(ocr_text))

        if not ocr_text.strip():
            logger.warning("OCR produced empty text")
            return {
                "ocr_text": "",
                "extracted_data": {},
                "classification": {"loai_van_ban": "Không xác định", "do_tin_cay": "thap"},
            }

        # Step 2: AI Agent - classify and extract
        logger.info("Step 2: AI Agent extracting fields...")
        classification = self.gemini_agent.classify_document(ocr_text)
        extracted_data = self.gemini_agent.extract_fields(ocr_text, self.custom_fields)

        logger.info(
            "Extracted %d fields, document type: %s",
            len(extracted_data),
            classification.get("loai_van_ban", "N/A"),
        )

        return {
            "ocr_text": ocr_text,
            "extracted_data": extracted_data,
            "classification": classification,
        }

    def process_file(self, file_path: str | Path) -> list[dict[str, Any]]:
        """Process an image or PDF file.

        For PDFs, processes each page separately and returns a list of results.
        For images, returns a single-item list.
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        if path.suffix.lower() == ".pdf":
            logger.info("Processing PDF: %s", path.name)
            images = pdf_to_images(path)
            results = []
            for i, img in enumerate(images):
                logger.info("Processing page %d/%d", i + 1, len(images))
                result = self.process_image(img)
                result["page"] = i + 1
                results.append(result)
            return results
        else:
            image = load_image(path)
            result = self.process_image(image)
            result["page"] = 1
            return [result]

    def save_results(
        self,
        results: list[dict[str, Any]],
        source_filename: str,
        output_dir: str | Path | None = None,
    ) -> dict[str, list[Path | str]]:
        """Save pipeline results to configured output format(s).

        Returns dict mapping format names to output file paths.
        """
        output_dir = Path(output_dir or RESULTS_DIR)
        output_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base_name = Path(source_filename).stem

        formats = (
            ["json", "excel", "markdown"]
            if self.output_format == "all"
            else [self.output_format]
        )

        saved = {}

        for fmt in formats:
            saved[fmt] = []
            for result in results:
                data = {
                    **result.get("extracted_data", {}),
                    "_source_file": source_filename,
                    "_page": result.get("page", 1),
                    "_document_type": result.get("classification", {}).get("loai_van_ban", ""),
                    "_timestamp": timestamp,
                }

                if fmt == "json":
                    writer = JSONWriter()
                    suffix = f"_p{result.get('page', 1)}" if len(results) > 1 else ""
                    path = writer.save(data, output_dir / f"{base_name}{suffix}_{timestamp}.json")
                    saved[fmt].append(path)

                elif fmt == "excel":
                    writer = ExcelWriter()
                    path = writer.save(data, output_dir / f"contracts_{timestamp}.xlsx")
                    saved[fmt].append(path)

                elif fmt == "markdown":
                    writer = MarkdownWriter()
                    suffix = f"_p{result.get('page', 1)}" if len(results) > 1 else ""
                    path = writer.save(data, output_dir / f"{base_name}{suffix}_{timestamp}.md")
                    saved[fmt].append(path)

                elif fmt == "gsheet":
                    if GOOGLE_SHEETS_SPREADSHEET_ID:
                        writer = GoogleSheetWriter(
                            credentials_file=GOOGLE_SHEETS_CREDENTIALS_FILE,
                            spreadsheet_id=GOOGLE_SHEETS_SPREADSHEET_ID,
                        )
                        sheet_id = writer.save(data)
                        saved[fmt].append(sheet_id)
                    else:
                        logger.warning("Google Sheet ID not configured, skipping gsheet output")

        return saved

    def run(
        self,
        file_path: str | Path,
        output_dir: str | Path | None = None,
    ) -> dict[str, Any]:
        """Run full pipeline: file -> OCR -> AI -> save.

        Returns complete result including extracted data and output paths.
        """
        path = Path(file_path)
        logger.info("=" * 60)
        logger.info("Pipeline started for: %s", path.name)
        logger.info("=" * 60)

        results = self.process_file(path)
        saved = self.save_results(results, path.name, output_dir)

        logger.info("Pipeline completed. Saved outputs: %s", list(saved.keys()))

        return {
            "source_file": str(path),
            "pages_processed": len(results),
            "results": results,
            "saved_outputs": {k: [str(p) for p in v] for k, v in saved.items()},
        }

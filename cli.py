"""CLI entry point for Nabu PDF Pipeline."""

import argparse
import json
import logging
import sys
from pathlib import Path

from src.pipeline import ContractOCRPipeline
from src.ocr.engine import create_engine
from src.agents.gemini_agent import GeminiAgent
from src.agents.field_templates import TEMPLATES, get_template
from src.utils.config import (
    OCR_ENGINE, VIETOCR_MODEL, GEMINI_API_KEY, GEMINI_MODEL,
    OUTPUT_FORMAT, RESULTS_DIR,
)


def main():
    parser = argparse.ArgumentParser(
        description="Nabu PDF - Trích xuất thông tin hợp đồng tiếng Việt",
    )
    parser.add_argument(
        "files",
        nargs="+",
        help="Đường dẫn đến file ảnh hoặc PDF",
    )
    parser.add_argument(
        "--engine",
        choices=["auto", "hybrid", "paddleocr", "vietocr"],
        default=OCR_ENGINE,
        help="OCR engine (default: auto)",
    )
    parser.add_argument(
        "--api-key",
        default=GEMINI_API_KEY,
        help="Gemini API key (hoặc set GEMINI_API_KEY trong .env)",
    )
    parser.add_argument(
        "--model",
        default=GEMINI_MODEL,
        help="Gemini model name",
    )
    parser.add_argument(
        "--template",
        choices=list(TEMPLATES.keys()),
        default="generic",
        help="Template trường trích xuất",
    )
    parser.add_argument(
        "--output-format",
        choices=["json", "excel", "markdown", "all"],
        default=OUTPUT_FORMAT,
        help="Định dạng output",
    )
    parser.add_argument(
        "--output-dir",
        default=str(RESULTS_DIR),
        help="Thư mục lưu kết quả",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Hiển thị log chi tiết",
    )

    args = parser.parse_args()

    # Setup logging
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if not args.api_key:
        print("ERROR: Cần Gemini API Key. Set GEMINI_API_KEY trong .env hoặc dùng --api-key")
        sys.exit(1)

    # Initialize pipeline
    fields = get_template(args.template)
    ocr = create_engine(args.engine)
    agent = GeminiAgent(api_key=args.api_key, model_name=args.model, fields=fields)
    pipeline = ContractOCRPipeline(
        ocr_engine=ocr,
        gemini_agent=agent,
        output_format=args.output_format,
        custom_fields=fields,
    )

    # Process each file
    for file_path in args.files:
        path = Path(file_path)
        if not path.exists():
            print(f"WARNING: File không tồn tại: {path}")
            continue

        print(f"\n{'='*60}")
        print(f"Đang xử lý: {path.name}")
        print(f"{'='*60}")

        try:
            result = pipeline.run(path, output_dir=args.output_dir)

            for page_result in result["results"]:
                page = page_result.get("page", 1)
                classification = page_result.get("classification", {})
                extracted = page_result.get("extracted_data", {})

                if len(result["results"]) > 1:
                    print(f"\n--- Trang {page} ---")

                print(f"Loại văn bản: {classification.get('loai_van_ban', 'N/A')}")
                print(f"Độ tin cậy: {classification.get('do_tin_cay', 'N/A')}")
                print(f"\nDữ liệu trích xuất:")
                for key, value in extracted.items():
                    display = str(value) if value is not None else "—"
                    print(f"  {key}: {display}")

            saved = result.get("saved_outputs", {})
            print(f"\nĐã lưu:")
            for fmt, paths in saved.items():
                for p in paths:
                    print(f"  [{fmt}] {p}")

        except Exception as e:
            print(f"ERROR: {e}")
            if args.verbose:
                import traceback
                traceback.print_exc()

    print(f"\nHoàn thành!")


if __name__ == "__main__":
    main()

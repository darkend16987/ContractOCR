"""Streamlit Web UI for Nabu PDF Pipeline."""

import streamlit as st
import logging
import json
import tempfile
from pathlib import Path
from datetime import datetime

from src.utils.config import GEMINI_API_KEY, RESULTS_DIR
from src.ocr.engine import create_engine
from src.agents.gemini_agent import GeminiAgent, DEFAULT_CONTRACT_FIELDS
from src.agents.field_templates import TEMPLATES, get_template
from src.pipeline import ContractOCRPipeline
from src.utils.image_processing import load_image_from_bytes

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Page config
st.set_page_config(
    page_title="Nabu PDF - Trích xuất hợp đồng tiếng Việt",
    page_icon="📄",
    layout="wide",
)

st.title("Nabu PDF")
st.markdown("**Pipeline OCR + AI** để trích xuất thông tin từ hợp đồng tiếng Việt")

# Sidebar - Configuration
with st.sidebar:
    st.header("Cài đặt")

    # API Key
    api_key = st.text_input(
        "Gemini API Key",
        value=GEMINI_API_KEY,
        type="password",
        help="Lấy API key tại https://aistudio.google.com/apikey",
    )

    # OCR Engine
    ocr_engine_type = st.selectbox(
        "OCR Engine",
        options=["auto", "hybrid", "paddleocr", "vietocr"],
        help="auto: tự động chọn engine tốt nhất. hybrid: PaddleOCR detection + VietOCR recognition",
    )

    # Gemini Model
    gemini_model = st.selectbox(
        "Gemini Model",
        options=["gemini-3.1-flash-lite", "gemini-3-flash-preview", "gemini-3.1-pro-preview"],
    )

    # Field Template
    template_name = st.selectbox(
        "Loại hợp đồng (template trường)",
        options=["generic", "mua_ban", "lao_dong", "dich_vu", "custom"],
        format_func=lambda x: {
            "generic": "Chung (Generic)",
            "mua_ban": "Hợp đồng Mua bán",
            "lao_dong": "Hợp đồng Lao động",
            "dich_vu": "Hợp đồng Dịch vụ",
            "custom": "Tùy chỉnh...",
        }[x],
    )

    # Output format
    output_format = st.selectbox(
        "Định dạng output",
        options=["json", "excel", "csv", "markdown", "all"],
    )

    st.divider()
    st.markdown("**Hướng dẫn nhanh:**")
    st.markdown(
        "1. Nhập Gemini API Key\n"
        "2. Upload ảnh/PDF hợp đồng\n"
        "3. Chọn loại hợp đồng\n"
        "4. Bấm **Xử lý**"
    )

# Custom fields editor
custom_fields = None
if template_name == "custom":
    st.subheader("Tùy chỉnh trường trích xuất")
    custom_json = st.text_area(
        "Nhập JSON các trường (key: mô tả)",
        value=json.dumps(DEFAULT_CONTRACT_FIELDS, ensure_ascii=False, indent=2),
        height=300,
    )
    try:
        custom_fields = json.loads(custom_json)
    except json.JSONDecodeError:
        st.error("JSON không hợp lệ!")
        custom_fields = None
else:
    if template_name in TEMPLATES:
        custom_fields = get_template(template_name)

# Main content area
col1, col2 = st.columns([1, 1])

with col1:
    st.subheader("Upload văn bản")
    uploaded_files = st.file_uploader(
        "Chọn ảnh hoặc PDF",
        type=["png", "jpg", "jpeg", "tiff", "bmp", "pdf"],
        accept_multiple_files=True,
    )

    if uploaded_files:
        for f in uploaded_files:
            if f.type.startswith("image/"):
                st.image(f, caption=f.name, use_container_width=True)
            else:
                st.info(f"📎 {f.name} ({f.size / 1024:.1f} KB)")

# Process button
if uploaded_files and api_key:
    if st.button("🔍 Xử lý", type="primary", use_container_width=True):
        if not api_key:
            st.error("Vui lòng nhập Gemini API Key!")
        else:
            # Initialize pipeline
            ocr = create_engine(ocr_engine_type)
            agent = GeminiAgent(api_key=api_key, model_name=gemini_model, fields=custom_fields)
            pipeline = ContractOCRPipeline(
                ocr_engine=ocr,
                gemini_agent=agent,
                output_format=output_format,
                custom_fields=custom_fields,
            )

            all_results = []

            for uploaded_file in uploaded_files:
                st.divider()
                st.subheader(f"Kết quả: {uploaded_file.name}")

                with st.spinner(f"Đang xử lý {uploaded_file.name}..."):
                    # Save uploaded file temporarily
                    with tempfile.NamedTemporaryFile(
                        suffix=Path(uploaded_file.name).suffix,
                        delete=False,
                    ) as tmp:
                        tmp.write(uploaded_file.getvalue())
                        tmp_path = tmp.name

                    try:
                        result = pipeline.run(tmp_path, output_dir=RESULTS_DIR)
                        all_results.append(result)

                        # Display results
                        for page_result in result["results"]:
                            page_num = page_result.get("page", 1)
                            if len(result["results"]) > 1:
                                st.markdown(f"**Trang {page_num}**")

                            # Classification
                            classification = page_result.get("classification", {})
                            doc_type = classification.get("loai_van_ban", "N/A")
                            confidence = classification.get("do_tin_cay", "N/A")
                            st.info(f"Loại văn bản: **{doc_type}** (Độ tin cậy: {confidence})")

                            # OCR Text (collapsible)
                            with st.expander("📝 Văn bản OCR (raw)", expanded=False):
                                st.text(page_result.get("ocr_text", ""))

                            # Extracted data
                            extracted = page_result.get("extracted_data", {})
                            if extracted:
                                st.markdown("**Dữ liệu trích xuất:**")
                                # Display as table
                                table_data = [
                                    {"Trường": k, "Giá trị": str(v) if v is not None else "—"}
                                    for k, v in extracted.items()
                                ]
                                st.table(table_data)

                        # Download buttons
                        saved = result.get("saved_outputs", {})
                        for fmt, paths in saved.items():
                            for path_str in paths:
                                p = Path(path_str)
                                if p.exists():
                                    with open(p, "rb") as f:
                                        st.download_button(
                                            label=f"⬇️ Tải {p.name}",
                                            data=f.read(),
                                            file_name=p.name,
                                            key=f"dl_{p.name}",
                                        )

                    except Exception as e:
                        st.error(f"Lỗi xử lý {uploaded_file.name}: {e}")
                        logger.exception("Pipeline error")

            if all_results:
                st.success(f"Hoàn thành! Đã xử lý {len(all_results)} file(s).")

elif not api_key:
    st.warning("Vui lòng nhập Gemini API Key ở sidebar để bắt đầu.")
elif not uploaded_files:
    st.info("Upload ảnh hoặc PDF hợp đồng để bắt đầu.")

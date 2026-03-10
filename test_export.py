import os
from pathlib import Path
from src.output.writer import ExcelWriter, CSVWriter
from src.agents.field_templates import HOP_DONG_MUA_BAN

def test_writers():
    data = {
        "so_hop_dong": "HD-123456",
        "ngay_ky": "10/03/2026",
        "ben_ban_ten": "Công ty TNHH A",
        "ben_mua_ten": "Công ty CP B",
        "tong_gia_tri": 15000000,
        "don_vi_tien": "VND",
        "_source_file": "hop_dong_mau.pdf",
        "_page": 1,
        "_document_type": "Hợp đồng mua bán",
        "_timestamp": "20260310_104500"
    }

    # Should only pull missing keys from the template if they are not defined,
    # but the template provides the headers.
    
    out_dir = Path("results/test")
    out_dir.mkdir(parents=True, exist_ok=True)
    
    excel_writer = ExcelWriter(fields_mapping=HOP_DONG_MUA_BAN)
    csv_writer = CSVWriter(fields_mapping=HOP_DONG_MUA_BAN)
    
    # Save once
    excel_path = out_dir / "test_contracts.xlsx"
    if excel_path.exists():
        excel_path.unlink()
    excel_writer.save(data, excel_path)
    
    csv_path = out_dir / "test_contracts.csv"
    if csv_path.exists():
        csv_path.unlink()
    csv_writer.save(data, csv_path)
    
    # Save again to check append mode
    data["so_hop_dong"] = "HD-999999"
    data["tong_gia_tri"] = 5500000
    excel_writer.save(data, excel_path)
    csv_writer.save(data, csv_path)
    
    print(f"Test complete. Output saved to {out_dir}")

if __name__ == "__main__":
    test_writers()

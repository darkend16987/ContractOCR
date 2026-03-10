"""Predefined field templates for common Vietnamese document types."""

# Hợp đồng mua bán
HOP_DONG_MUA_BAN = {
    "so_hop_dong": "Số hợp đồng",
    "ngay_ky": "Ngày ký hợp đồng",
    "ben_ban_ten": "Tên bên bán",
    "ben_ban_dia_chi": "Địa chỉ bên bán",
    "ben_ban_dai_dien": "Người đại diện bên bán",
    "ben_ban_mst": "Mã số thuế bên bán",
    "ben_mua_ten": "Tên bên mua",
    "ben_mua_dia_chi": "Địa chỉ bên mua",
    "ben_mua_dai_dien": "Người đại diện bên mua",
    "ben_mua_mst": "Mã số thuế bên mua",
    "hang_hoa": "Mô tả hàng hóa/sản phẩm",
    "so_luong": "Số lượng",
    "don_gia": "Đơn giá",
    "tong_gia_tri": "Tổng giá trị hợp đồng",
    "don_vi_tien": "Đơn vị tiền tệ",
    "phuong_thuc_thanh_toan": "Phương thức thanh toán",
    "thoi_han_giao_hang": "Thời hạn giao hàng",
    "dia_diem_giao_hang": "Địa điểm giao hàng",
    "bao_hanh": "Điều khoản bảo hành",
}

# Hợp đồng lao động
HOP_DONG_LAO_DONG = {
    "so_hop_dong": "Số hợp đồng",
    "ngay_ky": "Ngày ký",
    "nguoi_su_dung_lao_dong": "Tên công ty/người sử dụng lao động",
    "dia_chi_cty": "Địa chỉ công ty",
    "dai_dien_cty": "Người đại diện công ty",
    "chuc_vu_dai_dien": "Chức vụ người đại diện",
    "ho_ten_nld": "Họ tên người lao động",
    "ngay_sinh": "Ngày sinh",
    "cmnd_cccd": "Số CMND/CCCD",
    "dia_chi_nld": "Địa chỉ người lao động",
    "vi_tri_cong_viec": "Vị trí/chức danh công việc",
    "dia_diem_lam_viec": "Địa điểm làm việc",
    "loai_hop_dong": "Loại hợp đồng (thử việc/xác định thời hạn/không xác định)",
    "thoi_han": "Thời hạn hợp đồng",
    "luong_co_ban": "Mức lương cơ bản",
    "phu_cap": "Phụ cấp",
    "thoi_gian_lam_viec": "Thời gian làm việc",
    "bao_hiem": "Bảo hiểm xã hội",
}

# Hợp đồng dịch vụ
HOP_DONG_DICH_VU = {
    "so_hop_dong": "Số hợp đồng",
    "ngay_ky": "Ngày ký",
    "ben_a_ten": "Tên bên A (bên thuê dịch vụ)",
    "ben_a_dia_chi": "Địa chỉ bên A",
    "ben_a_dai_dien": "Người đại diện bên A",
    "ben_a_mst": "MST bên A",
    "ben_b_ten": "Tên bên B (bên cung cấp dịch vụ)",
    "ben_b_dia_chi": "Địa chỉ bên B",
    "ben_b_dai_dien": "Người đại diện bên B",
    "ben_b_mst": "MST bên B",
    "noi_dung_dich_vu": "Nội dung dịch vụ",
    "pham_vi_cong_viec": "Phạm vi công việc",
    "thoi_gian_thuc_hien": "Thời gian thực hiện",
    "gia_tri_hop_dong": "Giá trị hợp đồng",
    "phuong_thuc_thanh_toan": "Phương thức thanh toán",
    "dieu_khoan_phat": "Điều khoản phạt vi phạm",
}

# Generic - dùng khi chưa xác định loại
GENERIC = {
    "so_hop_dong": "Số hợp đồng/văn bản",
    "ngay_ky": "Ngày ký",
    "ben_a_ten": "Tên bên A",
    "ben_a_dia_chi": "Địa chỉ bên A",
    "ben_a_dai_dien": "Người đại diện bên A",
    "ben_b_ten": "Tên bên B",
    "ben_b_dia_chi": "Địa chỉ bên B",
    "ben_b_dai_dien": "Người đại diện bên B",
    "noi_dung": "Nội dung chính (tóm tắt)",
    "gia_tri": "Giá trị",
    "thoi_han": "Thời hạn",
    "ghi_chu": "Ghi chú đặc biệt",
}

TEMPLATES = {
    "mua_ban": HOP_DONG_MUA_BAN,
    "lao_dong": HOP_DONG_LAO_DONG,
    "dich_vu": HOP_DONG_DICH_VU,
    "generic": GENERIC,
}


def get_template(name: str) -> dict[str, str]:
    """Get a field template by name."""
    if name not in TEMPLATES:
        raise ValueError(f"Unknown template: {name}. Available: {list(TEMPLATES.keys())}")
    return TEMPLATES[name]

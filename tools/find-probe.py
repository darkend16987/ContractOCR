"""Đo xem /text-find bỏ sót từ khoá ở đâu, và vì sao — trên chính tệp PDF của bạn.

TẠI SAO CÓ FILE NÀY. "Tìm không ra từ dù từ có ở trang 2" có ít nhất sáu nguyên nhân
khả dĩ, và đoán sai một cái là sửa nhầm chỗ. Script này chạy ĐÚNG luật khớp chuỗi mà
endpoint dùng, trên đúng tệp, rồi đặt kết quả cạnh "sự thật thô" (page.get_text()).
Chỗ hai con số lệch nhau chính là thủ phạm, và cột nào lệch sẽ nói luôn là thủ phạm nào.

KHÔNG SAO CHÉP LUẬT KHỚP. `_find_occurrences` / `_is_word_char` được NHẤC THẲNG từ
api.py bằng ast — không import api.py (nó kéo theo cả OCR engine, nặng và chậm), cũng
không chép lại (một bản chép sẽ trôi khỏi bản gốc và khi đó phép đo thành vô nghĩa).
Đổi tên hai hàm đó ở api.py ⇒ script này dừng ngay với thông báo rõ, chứ không âm thầm
đo sai.

Cách chạy (từ thư mục gốc repo):

    python tools/find-probe.py "D:\\duong\\dan\\file.pdf" "2026"
    python tools/find-probe.py file.pdf "2026" --pages 1-10        # chỉ 10 trang đầu
    python tools/find-probe.py file.pdf "Hợp đồng" --word --case

Đọc bảng kết quả:

    raw   — số lần từ khoá xuất hiện trong page.get_text() thô          (sự thật)
    tìm   — số hit vòng lặp /text-find tạo ra                            (thực tế)
    kophách — số lần khớp sau khi BỎ HẾT khoảng trắng ở cả hai vế        (chẩn đoán)

    raw > tìm   ⇒ vòng lặp đánh rơi hit  → xem cột "vì sao" của trang đó
    kophách > raw ⇒ từ khoá bị cắt qua khoảng trắng/xuống dòng (nguyên nhân B hoặc C)
    tìm = raw = 0 nhưng kophách > 0 ⇒ chữ bị tách span/dòng giữa từ (vấn đề "202"+"6")
"""

from __future__ import annotations

import argparse
import ast
import pathlib
import sys
import time

# Vietnamese in a Windows console dies on cp1252 without this.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _lift(py_path: pathlib.Path, names: set[str]) -> dict:
    """Compile ONLY the named top-level defs/assignments out of a source file.

    Lets the probe borrow api.py's matching rule without paying for api.py's imports,
    and without owning a second copy of it.
    """
    src = py_path.read_text(encoding="utf-8")
    picked: list[ast.stmt] = []
    found: set[str] = set()
    for node in ast.parse(src).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            picked.append(node)
            found.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in names:
                    picked.append(node)
                    found.add(t.id)
    missing = names - found
    if missing:
        raise SystemExit(
            f"LỖI: không tìm thấy {sorted(missing)} trong {py_path}.\n"
            "Nếu chúng vừa được đổi tên, sửa danh sách ở đầu find-probe.py — "
            "đừng chép lại thân hàm vào đây."
        )
    ns: dict = {}
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(py_path), "exec"), ns)
    return ns


_API = _lift(ROOT / "api.py", {"_is_word_char", "_find_occurrences"})
_UTIL = _lift(ROOT / "src" / "pdf" / "util.py", {"_MAX_PDF_B64"})
_find_occurrences = _API["_find_occurrences"]
MAX_B64 = _UTIL["_MAX_PDF_B64"]


def parse_pages(spec: str, total: int) -> list[int]:
    """"1-10" / "2,3" / "" → 0-based page indices."""
    if not spec:
        return list(range(total))
    out: list[int] = []
    for tok in spec.replace(" ", "").split(","):
        if not tok:
            continue
        if "-" in tok:
            a_s, b_s = tok.split("-", 1)
            a, b = int(a_s), int(b_s)
        else:
            a = b = int(tok)
        if a > b:
            a, b = b, a
        for n in range(max(1, a), min(b, total) + 1):
            out.append(n - 1)
    return sorted(set(out))


def strip_ws(s: str) -> str:
    return "".join(ch for ch in s if not ch.isspace())


def scan_page(page, query: str, match_case: bool, whole_word: bool) -> dict:
    """Replicate /text-find's per-page loop, counting only (geometry is irrelevant here).

    Mirrors api.py's text_find() line for line in the parts that can DROP a match:
    the whitespace-only filter, the degenerate-box filter, the per-span pass and the
    per-line joined pass. Anything it counts, the endpoint counts.
    """
    data = page.get_text("dict")
    n_in_span = 0
    n_cross = 0
    dropped_ws = 0
    dropped_degen = 0
    n_join_nospace = 0
    culprit_lines: list[list[str]] = []

    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            raw = []
            for sp in line.get("spans", []):
                txt = sp.get("text", "")
                if not txt.strip():
                    dropped_ws += 1
                    continue
                x0, y0, x1, y1 = sp["bbox"]
                if (x1 - x0) < 0.5 or (y1 - y0) < 0.5:
                    dropped_degen += 1
                    continue
                raw.append((sp, txt))
            if not raw:
                continue

            joined = "".join(t for _, t in raw)
            offsets = []
            acc = 0
            for _, t in raw:
                offsets.append(acc)
                acc += len(t)

            taken: set[tuple[int, int]] = set()
            line_in_span = 0
            for si, (_sp, txt) in enumerate(raw):
                base = offsets[si]
                for s, e in _find_occurrences(txt, query, match_case, whole_word):
                    line_in_span += 1
                    taken.add((base + s, base + e))
            n_in_span += line_in_span

            line_cross = 0
            for s, e in _find_occurrences(joined, query, match_case, whole_word):
                if (s, e) in taken:
                    continue
                line_cross += 1
            n_cross += line_cross

            # Chẩn đoán: khớp được sau khi bỏ khoảng trắng nhưng vòng lặp không ra hit
            # ⇒ từ khoá bị chia qua khoảng trắng (spacing) hoặc qua ranh giới span.
            ns = len(_find_occurrences(strip_ws(joined), strip_ws(query), match_case, False))
            n_join_nospace += ns
            if ns and not (line_in_span + line_cross) and len(culprit_lines) < 3:
                culprit_lines.append([t for _, t in raw])

    text = page.get_text("text")
    n_raw = len(_find_occurrences(text, query, match_case, whole_word))
    n_raw_nospace = len(_find_occurrences(strip_ws(text), strip_ws(query), match_case, False))

    return {
        "raw": n_raw,
        "found": n_in_span + n_cross,
        "in_span": n_in_span,
        "cross": n_cross,
        "nospace": max(n_join_nospace, n_raw_nospace),
        "dropped_ws": dropped_ws,
        "dropped_degen": dropped_degen,
        "culprits": culprit_lines,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Đo /text-find trên một tệp PDF thật.")
    ap.add_argument("pdf")
    ap.add_argument("query")
    ap.add_argument("--case", action="store_true", help="phân biệt hoa/thường")
    ap.add_argument("--word", action="store_true", help="đúng nguyên từ")
    ap.add_argument("--pages", default="", help='giới hạn trang, VD "1-10" hoặc "2,3"')
    ap.add_argument("--max-hits", type=int, default=5000, help="giống max_hits của endpoint")
    args = ap.parse_args()

    path = pathlib.Path(args.pdf)
    if not path.exists():
        print(f"Không thấy tệp: {path}")
        return 2

    size = path.stat().st_size
    b64_len = -(-size // 3) * 4  # độ dài base64 renderer sẽ gửi đi
    print(f"Tệp      : {path.name}")
    print(f"Dung lượng: {size/1e6:.1f} MB  →  base64 {b64_len/1e6:.1f} MB")
    if b64_len > MAX_B64:
        print(
            f"  ⛔ VƯỢT TRẦN của sidecar ({MAX_B64/1e6:.0f} MB base64 ≈ {MAX_B64*3/4/1e6:.0f} MB tệp).\n"
            "     /text-find sẽ trả 400 'PDF quá lớn' — KHÔNG hit nào cả, bất kể từ khoá.\n"
            "     Đây là nguyên nhân F. Script vẫn chạy tiếp để đo phần logic."
        )
    else:
        print(f"  ✔ Dưới trần {MAX_B64/1e6:.0f} MB base64 — endpoint sẽ nhận tệp.")

    try:
        import fitz
    except ImportError:
        print("Chưa cài PyMuPDF: pip install pymupdf")
        return 2

    t0 = time.time()
    doc = fitz.open(str(path))
    pages = parse_pages(args.pages, doc.page_count)
    print(f"Số trang : {doc.page_count} (quét {len(pages)})")
    print(f'Từ khoá  : "{args.query}"  case={args.case}  word={args.word}\n')

    print("trang |  raw |  tìm | trong-span | qua-span | kophách | span bỏ | ms")
    print("------+------+------+------------+----------+---------+---------+-----")

    tot = {"raw": 0, "found": 0, "in_span": 0, "cross": 0, "nospace": 0}
    misses: list[tuple[int, dict]] = []
    truncated_at = None

    for pno in pages:
        t1 = time.time()
        r = scan_page(doc[pno], args.query, args.case, args.word)
        ms = (time.time() - t1) * 1000
        for k in tot:
            tot[k] += r[k]
        flag = ""
        if r["raw"] > r["found"] or (r["nospace"] > r["found"]):
            flag = "  ← LỆCH"
            misses.append((pno, r))
        if r["raw"] or r["found"] or r["nospace"]:
            print(
                f"{pno+1:5d} | {r['raw']:4d} | {r['found']:4d} | {r['in_span']:10d} |"
                f" {r['cross']:8d} | {r['nospace']:7d} | {r['dropped_ws']+r['dropped_degen']:7d} |"
                f" {ms:4.0f}{flag}"
            )
        if truncated_at is None and tot["found"] >= args.max_hits:
            truncated_at = pno + 1

    dt = time.time() - t0
    print(
        f"\nTổNG: raw={tot['raw']}  tìm={tot['found']}"
        f"  (trong-span={tot['in_span']}, qua-span={tot['cross']})  kophách={tot['nospace']}"
    )
    print(f"Thời gian quét: {dt:.1f}s cho {len(pages)} trang ({dt/max(1,len(pages))*1000:.0f} ms/trang)")

    if truncated_at:
        print(
            f"\n⚠ Chạm trần max_hits={args.max_hits} ở khoảng trang {truncated_at} — "
            "endpoint sẽ DỪNG quét từ đó (nguyên nhân E)."
        )

    if not misses:
        print("\n✔ Không trang nào lệch: vòng lặp tìm ra đúng mọi chỗ text thô có.")
    else:
        print(f"\n⚠ {len(misses)} trang lệch. Chi tiết vài trang đầu:")
        for pno, r in misses[:5]:
            print(f"\n  — Trang {pno+1}: raw={r['raw']} tìm={r['found']} kophách={r['nospace']}")
            if r["nospace"] > r["found"]:
                print("    → từ khoá bị cắt qua khoảng trắng hoặc qua ranh giới span/dòng.")
            for spans in r["culprits"]:
                shown = " | ".join(repr(s) for s in spans[:12])
                print(f"    span của dòng: {shown}")

    doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

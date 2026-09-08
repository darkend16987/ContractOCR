"use strict";

// Regression net for the page-bitmap raster budget (renderer/raster-cap.js, BI-78).
//
// Two jobs, and the first one is the reason this file exists at all:
//
//   1. PROVE THE HOIST WAS A PURE MOVE. `viewRasterDpr` lived inline in app.js
//      until 2026-09-08, when the read-only split-view pane needed the same cap.
//      `REFERENCE` below is a verbatim copy of the app.js version as it stood at
//      v0.2.68 (commit 9717b10). Every case is checked against BOTH, so a "tidy-up"
//      during the move shows up as a diff instead of as a blank A0 sheet months later.
//   2. Guard the two cliffs themselves: the 268 MP area cliff (Chromium paints
//      NOTHING and throws no error) and Skia's 16384 px texture limit.
//
// Run:  node desktop/test/raster-cap.test.js      (or: npm run test:raster)

const path = require("path");
const Cap = require(path.join(__dirname, "..", "renderer", "raster-cap.js"));

// ---- verbatim copy of app.js@9717b10:795-811 -------------------------------
const REF_MP = 32;
const REF_SIDE = 12000;
function REFERENCE(cw, ch, dpr) {
  if (!(cw > 0) || !(ch > 0)) return dpr;
  return Math.min(dpr, Math.sqrt((REF_MP * 1e6) / (cw * ch)), REF_SIDE / Math.max(cw, ch));
}

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       got      ${a}\n       expected ${e}`);
  }
}
function ok(name, cond) {
  check(name, !!cond, true);
}

const f = Cap.viewRasterDpr;

// ---- 1. hằng số không được đổi trong lúc bê đi ------------------------------
check("MAX_VIEW_MEGAPIXELS giữ nguyên 32", Cap.MAX_VIEW_MEGAPIXELS, REF_MP);
check("MAX_VIEW_SIDE_PX giữ nguyên 12000", Cap.MAX_VIEW_SIDE_PX, REF_SIDE);

// ---- 2. bê đi là bê NGUYÊN: quét lưới, so từng ca với bản cũ ---------------
// Khổ giấy ở 72dpi (scale 1), đúng các khổ app thật gặp.
const SHEETS = {
  A4: [595, 842],
  A3: [842, 1191],
  A2: [1191, 1684],
  A1: [1684, 2384],
  A0: [2384, 3370],
  "A0 ngang": [3370, 2384],
  "dải dài": [200, 30000], // tỷ lệ cực đoan: lọt trần diện tích, vướng trần cạnh
};
const SCALES = [0.2, 0.5, 1, 1.5, 2, 3, 4, 5]; // đúng dải zoom 20–500% của v0.2.68
const DPRS = [1, 1.25, 1.5, 2, 3];

let grid = 0;
let drift = 0;
for (const [name, [w1, h1]] of Object.entries(SHEETS)) {
  for (const s of SCALES) {
    for (const dpr of DPRS) {
      const cw = w1 * s;
      const ch = h1 * s;
      grid++;
      if (f(cw, ch, dpr) !== REFERENCE(cw, ch, dpr)) {
        drift++;
        if (drift <= 5) console.log(`       lệch: ${name} scale=${s} dpr=${dpr}`);
      }
    }
  }
}
check(`bê nguyên: ${grid} ca lưới khổ×zoom×dpr khớp bản app.js cũ`, drift, 0);

// ---- 3. rác vào thì trả lại dpr, không bao giờ NaN/0/âm --------------------
for (const [cw, ch] of [[0, 100], [100, 0], [-5, 100], [NaN, 100], [100, NaN], [undefined, 100]]) {
  check(`rác (${cw}, ${ch}) -> trả nguyên dpr`, f(cw, ch, 1.5), 1.5);
}

// ---- 4. KHÔNG BAO GIỜ nâng quá dpr thật ------------------------------------
// Trang nhỏ tí thì hai trần đều rộng thênh thang — kết quả vẫn phải là dpr.
check("trang nhỏ, dpr 1 -> vẫn 1 (không nâng)", f(100, 100, 1), 1);
check("trang nhỏ, dpr 3 -> vẫn 3 (không nâng)", f(100, 100, 3), 3);

// ---- 5. hai vách, mỗi vách một ca chứng minh ------------------------------
// A4 ở 500%, dpr 1.5 = 28,2 MP: DƯỚI trần -> không đụng tới (câu này chính là
// lời hứa "trang thường không đổi gì" trong BI-78).
check("A4 @500% dpr1.5 nằm dưới trần -> giữ 1.5", f(595 * 5, 842 * 5, 1.5), 1.5);
ok("A4 @500% dpr1.5 thật sự < 32 MP", (595 * 5 * 1.5 * 842 * 5 * 1.5) / 1e6 < 32);

// A3 ở 500%, dpr 1.5 = 56,4 MP: VƯỢT trần diện tích -> phải hạ.
const a3 = f(842 * 5, 1191 * 5, 1.5);
ok("A3 @500% dpr1.5 bị hạ xuống dưới 1.5", a3 < 1.5);
ok("A3 sau khi hạ nằm trong ngân sách 32 MP", (842 * 5 * a3 * 1191 * 5 * a3) / 1e6 <= 32 + 1e-6);

// A0 ở 300%, dpr 1.5 = 163 MP: lỗ đã có từ TRƯỚC khi nới trần zoom lên 500%.
const a0 = f(2384 * 3, 3370 * 3, 1.5);
ok("A0 @300% dpr1.5 bị hạ", a0 < 1.5);
ok("A0 sau khi hạ nằm trong ngân sách 32 MP", (2384 * 3 * a0 * 3370 * 3 * a0) / 1e6 <= 32 + 1e-6);

// Dải dài: lọt trần diện tích nhưng cạnh dài vượt 16384 của Skia -> trần CẠNH
// phải là cái ra tay, không phải trần diện tích.
const strip = f(200, 30000, 1);
ok("dải dài bị trần CẠNH chặn", strip < 1);
ok("cạnh dài sau khi hạ <= 12000", 30000 * strip <= REF_SIDE + 1e-6);
ok("dải dài KHÔNG phải do trần diện tích", (200 * 30000) / 1e6 < REF_MP);

// ---- 6. mọi ca đều phải ở dưới CẢ HAI vách thật của Chromium ---------------
// 268 MP (2^28) là chỗ Chromium im lặng trả trang trắng; 16384 là trần texture Skia.
let worstArea = 0;
let worstSide = 0;
for (const [w1, h1] of Object.values(SHEETS)) {
  for (const s of SCALES) {
    for (const dpr of DPRS) {
      const cw = w1 * s, ch = h1 * s;
      const r = f(cw, ch, dpr);
      worstArea = Math.max(worstArea, (cw * r * ch * r) / 1e6);
      worstSide = Math.max(worstSide, Math.max(cw, ch) * r);
    }
  }
}
ok(`diện tích lớn nhất trong lưới (${worstArea.toFixed(1)} MP) <= 32`, worstArea <= REF_MP + 1e-6);
ok(`cạnh lớn nhất trong lưới (${Math.round(worstSide)} px) <= 12000`, worstSide <= REF_SIDE + 1e-6);
ok("và vì thế cách vách 268 MP của Chromium rất xa", worstArea < 268);
ok("và vách 16384 px của Skia rất xa", worstSide < 16384);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

"use strict";

// Regression net for split-view geometry (src/tabs.js `splitRects`).
//
// This is the arithmetic that decides where three native views sit inside one
// window. It gets its own grid for the same reason page-range.js does: the failure
// modes are silent and geometric, not exceptions.
//   · a 1px gap between two WebContentsViews is a flickering line of desktop
//     showing through — nothing throws;
//   · a 1px overlap hides a strip of the pane underneath;
//   · a pane below its floor is a renderer the user can see but cannot work in
//     (measured: at 380px the main renderer's own page starts scrolling sideways);
//   · a NEGATIVE width is `setBounds` with junk, i.e. an invisible renderer holding
//     a whole document with no way to reach it.
// Every case below is a plain number check, so this runs under node with no GUI.
//
// Run:  node desktop/test/split-layout.test.js      (or: npm run test:split)

const path = require("path");
const Module = require("module");

// tabs.js only touches Electron inside the TabbedWindow constructor; splitRects is
// pure. Same stub the tab-logic grid uses.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      BaseWindow: class {},
      WebContentsView: class {},
      screen: {
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};

const T = require(path.join(__dirname, "..", "src", "tabs.js"));
const { splitRects, SPLIT_GUTTER, MAIN_MIN_W, MAIN_HARD_MIN_W, VIEW_MIN_W, VIEW_HARD_MIN_W } = T;
const STRIP = T.TAB_STRIP_H;

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

const panesOf = (r) => [r.main].concat(r.views);

// The four properties that must hold for EVERY layout this function can produce.
// Asserted as a helper, then swept over a wide grid at the bottom: a case-by-case
// grid proves the cases someone thought of, the sweep proves the rest.
function invariants(label, r, W, H, stripH, n) {
  const panes = panesOf(r);
  ok(`${label}: đúng ${n + 1} khung`, panes.length === n + 1);
  ok(`${label}: không khung nào bề rộng ÂM`, panes.every((p) => p.width >= 0));
  ok(`${label}: mọi khung cùng dải dọc`, panes.every((p) => p.y === Math.min(stripH, H) && p.height === Math.max(0, H - Math.min(stripH, H))));
  ok(`${label}: khung đầu bám mép trái`, panes[0].x === 0);
  // Kề khít: mép phải khung i + rãnh = mép trái khung i+1. Không hở, không chồng.
  let seam = true;
  for (let i = 0; i < panes.length - 1; i++) {
    if (panes[i].x + panes[i].width + SPLIT_GUTTER !== panes[i + 1].x) seam = false;
  }
  ok(`${label}: kề khít rãnh, không hở/chồng 1px`, seam);
  ok(`${label}: phủ hết bề rộng cửa sổ`, panes[panes.length - 1].x + panes[panes.length - 1].width === W);
  ok(`${label}: số rãnh = ${n}`, r.gutters.length === n);
  ok(
    `${label}: rãnh nằm đúng giữa hai khung`,
    r.gutters.every((g, i) => g.x === panes[i].x + panes[i].width && g.width === SPLIT_GUTTER)
  );
}

// ---- 1. không chia khung: y hệt hành vi trước khi có tính năng -------------
{
  const r = splitRects(1360, 880, { stripH: STRIP, panes: 0 });
  check("1 khung: chrome vẫn là dải 40px", r.chrome, { x: 0, y: 0, width: 1360, height: STRIP });
  check("1 khung: tài liệu chiếm hết phần còn lại", r.main, { x: 0, y: STRIP, width: 1360, height: 840 });
  check("1 khung: không có khung xem", r.views, []);
  check("1 khung: không có rãnh", r.gutters, []);
}

// ---- 2. chrome PHỦ HẾT cửa sổ ngay khi có khung xem ------------------------
// Đây là điều kiện để nó nhận được chuột ở rãnh (probe P-A). Sai chỗ này thì rãnh
// không kéo được, và không có lỗi nào được ném ra.
{
  const r1 = splitRects(1360, 880, { stripH: STRIP, panes: 1 });
  check("2 khung: chrome cao HẾT cửa sổ", r1.chrome, { x: 0, y: 0, width: 1360, height: 880 });
  const r0 = splitRects(1360, 880, { stripH: STRIP, panes: 0 });
  ok("1 khung: chrome KHÔNG cao hết cửa sổ", r0.chrome.height === STRIP);
}

// ---- 3. tỷ lệ mặc định --------------------------------------------------
{
  const r = splitRects(1360, 880, { stripH: STRIP, panes: 1 });
  invariants("1360/1 khung xem", r, 1360, 880, STRIP, 1);
  const usable = 1360 - SPLIT_GUTTER;
  check("mặc định 60/40 cho 1 khung xem", [r.main.width, r.views[0].width], [Math.round(usable * 0.6), usable - Math.round(usable * 0.6)]);
  ok("khung chính trên ngưỡng đo được 620px", r.main.width >= MAIN_MIN_W);
}
{
  const r = splitRects(1920, 1040, { stripH: STRIP, panes: 2 });
  invariants("1920/2 khung xem", r, 1920, 1040, STRIP, 2);
  ok("1920: khung chính thoải mái (>=700px, chrome 30%)", r.main.width >= 700);
  ok("1920: hai khung xem bằng nhau", r.views[0].width === r.views[1].width);
}

// ---- 4. bề rộng LẺ: chỗ 1px hay lọt ra -----------------------------------
for (const W of [1361, 1363, 1921, 1367, 999, 1001]) {
  for (const n of [1, 2]) {
    invariants(`lẻ ${W}/${n}`, splitRects(W, 900, { stripH: STRIP, panes: n }), W, 900, STRIP, n);
  }
}

// ---- 5. cửa sổ hẹp dần: ba bậc sàn --------------------------------------
{
  // 884 = vùng nội dung ở minWidth 900 của app thật. 620+6+260 = 886 -> thiếu 2px,
  // nên bậc "sàn ưu tiên" KHÔNG vừa và phải rơi xuống bậc sàn cứng.
  const r = splitRects(884, 900, { stripH: STRIP, panes: 1 });
  invariants("884/1 khung xem", r, 884, 900, STRIP, 1);
  ok("884: khung chính vẫn trên sàn CỨNG 420px", r.main.width >= MAIN_HARD_MIN_W);
  ok("884: khung xem vẫn trên sàn cứng 180px", r.views[0].width >= VIEW_HARD_MIN_W);
}
{
  // 1152 = 620+6+260+6+260: vừa đúng bậc sàn ưu tiên cho 3 khung.
  const r = splitRects(1152, 900, { stripH: STRIP, panes: 2 });
  invariants("1152/2 khung xem", r, 1152, 900, STRIP, 2);
  check("1152: đúng các mức tối thiểu ưu tiên", [r.main.width, r.views[0].width, r.views[1].width], [MAIN_MIN_W, VIEW_MIN_W, VIEW_MIN_W]);
}
{
  const r = splitRects(1151, 900, { stripH: STRIP, panes: 2 });
  invariants("1151/2 khung xem (thiếu 1px)", r, 1151, 900, STRIP, 2);
  ok("1151: rơi xuống bậc sàn cứng, không khung nào âm", panesOf(r).every((p) => p.width > 0));
}
{
  // Nhỏ hơn cả tổng sàn CỨNG (420+180+180+12 = 792) -> chia theo tỷ lệ, vẫn phải
  // ra một layout vẽ được. Đây là ca "người dùng kéo cửa sổ bé xíu", không phải ca
  // để từ chối: từ chối là việc của UI, không phải của hình học.
  const r = splitRects(600, 900, { stripH: STRIP, panes: 2 });
  invariants("600/2 khung xem (dưới mọi sàn)", r, 600, 900, STRIP, 2);
  ok("600: không khung nào âm", panesOf(r).every((p) => p.width >= 0));
}

// ---- 6. tỷ lệ do người dùng kéo -----------------------------------------
{
  const r = splitRects(1920, 1040, { stripH: STRIP, panes: 1, ratios: [0.8, 0.2] });
  invariants("tỷ lệ 80/20", r, 1920, 1040, STRIP, 1);
  const usable = 1920 - SPLIT_GUTTER;
  ok("80/20 được tôn trọng khi còn trên sàn", Math.abs(r.main.width - usable * 0.8) <= 1);
}
{
  // Kéo tới mức khung xem thủng sàn -> phải KẸP, không được cho nó bé hơn.
  const r = splitRects(1360, 880, { stripH: STRIP, panes: 1, ratios: [0.98, 0.02] });
  invariants("kéo hết cỡ sang phải", r, 1360, 880, STRIP, 1);
  check("khung xem bị kẹp về đúng sàn 260px", r.views[0].width, VIEW_MIN_W);
}
{
  const r = splitRects(1360, 880, { stripH: STRIP, panes: 1, ratios: [0.02, 0.98] });
  invariants("kéo hết cỡ sang trái", r, 1360, 880, STRIP, 1);
  check("khung chính bị kẹp về đúng sàn 620px", r.main.width, MAIN_MIN_W);
}

// ---- 7. tỷ lệ RÁC -> tỷ lệ mặc định, không bao giờ khung 0px -------------
const JUNK = [null, undefined, [], [1], [0.5, 0.5, 0.5], [NaN, 1], [-3, 4], [0, 1], ["a", "b"], [Infinity, 1]];
for (const j of JUNK) {
  const r = splitRects(1360, 880, { stripH: STRIP, panes: 1, ratios: j });
  const label = `rác ${JSON.stringify(j)}`;
  invariants(label, r, 1360, 880, STRIP, 1);
  ok(`${label}: không khung nào rộng 0`, panesOf(r).every((p) => p.width > 0));
}

// ---- 8. toàn màn hình: stripH = 0 ---------------------------------------
{
  const r = splitRects(1920, 1080, { stripH: 0, panes: 2 });
  invariants("toàn màn hình/2 khung xem", r, 1920, 1080, 0, 2);
  ok("toàn màn hình: khung cao hết cửa sổ", r.main.y === 0 && r.main.height === 1080);
  ok("toàn màn hình: chrome vẫn phủ hết (để giữ rãnh)", r.chrome.height === 1080);
}

// ---- 9. đầu vào thoái hoá ------------------------------------------------
for (const [W, H] of [[0, 0], [0, 900], [1360, 0], [-100, 900], [NaN, NaN]]) {
  for (const n of [0, 1, 2]) {
    const r = splitRects(W, H, { stripH: STRIP, panes: n });
    ok(`thoái hoá (${W}×${H}, ${n} khung xem): không có số âm`, panesOf(r).every((p) => p.width >= 0 && p.height >= 0 && p.x >= 0 && p.y >= 0));
  }
}
check("panes rác -> coi như không chia", splitRects(1360, 880, { stripH: STRIP, panes: "hai" }).views, []);
check("panes quá số cho phép -> kẹp về 2", splitRects(1920, 1040, { stripH: STRIP, panes: 9 }).views.length, 2);
check("panes âm -> coi như không chia", splitRects(1360, 880, { stripH: STRIP, panes: -1 }).views, []);
check("không truyền tuỳ chọn -> không chia", splitRects(1360, 880).views, []);

// ---- 10. quét rộng: mọi bề rộng thật đều giữ đủ bất biến ------------------
{
  let bad = 0;
  let firstBad = null;
  for (let W = 300; W <= 3840; W += 7) {
    for (const n of [1, 2]) {
      for (const ratios of [undefined, [0.5, 0.5], [0.75, 0.25], [0.34, 0.33, 0.33], [0.9, 0.05, 0.05]]) {
        const r = splitRects(W, 900, { stripH: STRIP, panes: n, ratios });
        const panes = panesOf(r);
        let good = panes.length === n + 1 && panes[0].x === 0 && panes.every((p) => p.width >= 0);
        for (let i = 0; i < panes.length - 1 && good; i++) {
          if (panes[i].x + panes[i].width + SPLIT_GUTTER !== panes[i + 1].x) good = false;
        }
        if (good && panes[panes.length - 1].x + panes[panes.length - 1].width !== W) good = false;
        if (!good) {
          bad++;
          if (!firstBad) firstBad = { W, n, ratios, panes };
        }
      }
    }
  }
  if (firstBad) console.log("       ca hỏng đầu tiên: " + JSON.stringify(firstBad));
  check("quét 300..3840px × {1,2} khung × 5 bộ tỷ lệ: 0 ca hỏng", bad, 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

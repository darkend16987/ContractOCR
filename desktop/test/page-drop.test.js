"use strict";

// Regression net for the pure logic behind "kéo trang từ tài liệu A sang tài liệu B"
// (docs/SPEC-page-drag.md): where a dropped page goes, and which pages a grab acts on.
//
// Run:  node desktop/test/page-drop.test.js      (or: npm run test:pagedrop)
//
// Why these two functions and not more: the drag GESTURE cannot be exercised by a
// machine (docs/TABS-2B-DESIGN.md §2.2 — Chromium ignores synthesised input inside a
// drag-and-drop session), so the only defence for the arithmetic underneath it is to
// keep that arithmetic DOM-free and pin it here. Everything else in this feature is
// covered by the manual grid in SPEC-page-drag.md §7.1.
//
// `electron` is stubbed exactly as tabs-logic.test.js does it: the classifiers never
// touch it, and the constructor is not run.

const path = require("path");
const Module = require("module");

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

const Tabs = require(path.join(__dirname, "..", "src", "tabs.js"));
const PageRange = require(path.join(__dirname, "..", "renderer", "page-range.js"));
const P = Tabs.TabbedWindow.prototype;

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

// ---------------------------------------------------------------------------
console.log("\n-- classifyPageDrop (thả trang ở đâu thì làm gì) --");

// Two windows side by side, no overlap. Document views only — the 40px tab strip
// is already excluded, which is what docViewScreenRect does.
//   A: x 0..800,    y 40..1000
//   B: x 900..1700, y 40..1000
const RECTS = [
  { key: "A", rect: { x: 0, y: 40, width: 800, height: 960 }, z: 2 },
  { key: "B", rect: { x: 900, y: 40, width: 800, height: 960 }, z: 1 },
];
const drop = (x, y, src = "A", rects = RECTS) => Tabs.classifyPageDrop({ x, y }, src, rects);

// Rule 1 — the source window always wins its own hit. This is the shipped in-column
// reorder (v0.2.41) and the cross-document path must never intercept it (BI-54).
check("thả trong cột trang của chính mình → self", drop(400, 500), { action: "self", key: "A" });
check("thả ở góc trên-trái của chính mình → self", drop(0, 40), { action: "self", key: "A" });
check("thả ở góc dưới-phải của chính mình → self", drop(800, 1000), { action: "self", key: "A" });

// Rule 2 — inside another window ⇒ send it there.
check("thả vào cửa sổ khác → send", drop(1200, 500), { action: "send", key: "B" });
check("thả sát mép trái cửa sổ khác → send", drop(900, 500), { action: "send", key: "B" });
check("kéo từ B sang A → send A", drop(400, 500, "B"), { action: "send", key: "A" });

// Rule 3 — nowhere ⇒ nothing. A page has no "tear out into a new window" meaning,
// so there is deliberately no buffer zone around a window (P7).
check("thả vào khoảng trống giữa 2 cửa sổ → none", drop(850, 500), { action: "none", key: null });
check("thả 1px trên mép cửa sổ khác → none (không có vùng đệm)", drop(1200, 39), {
  action: "none",
  key: null,
});
check("thả dưới đáy mọi cửa sổ → none", drop(400, 1001, "B"), { action: "none", key: null });

// Rule 3 also covers a drop over the tab strip band: docViewScreenRect starts BELOW
// the strip, so y=20 is inside no document view.
check("thả lên dải tab của cửa sổ khác → none", drop(1200, 20), { action: "none", key: null });

// Junk in ⇒ the harmless answer, never a guess. Same contract as classifyDrop.
check("không có toạ độ con trỏ → none", Tabs.classifyPageDrop(null, "A", RECTS), {
  action: "none",
  key: null,
});
check("toạ độ NaN → none", Tabs.classifyPageDrop({ x: NaN, y: 500 }, "A", RECTS), {
  action: "none",
  key: null,
});
check("danh sách đích không phải mảng → none", Tabs.classifyPageDrop({ x: 400, y: 500 }, "A", null), {
  action: "none",
  key: null,
});
check("phần tử đích rác bị lọc", Tabs.classifyPageDrop({ x: 1200, y: 500 }, "A", [null, {}, RECTS[1]]), {
  action: "send",
  key: "B",
});
check("cửa sổ nguồn không có trong danh sách (vừa đóng) → vẫn gửi được", drop(1200, 500, "GONE"), {
  action: "send",
  key: "B",
});

// Overlap — the case a plain "first hit wins" scan gets WRONG. B and C both cover
// the drop point; C was focused more recently, so C is what the user sees there.
console.log("\n-- classifyPageDrop: cửa sổ chồng nhau (luật z) --");
const OVERLAP = [
  { key: "A", rect: { x: 0, y: 40, width: 500, height: 960 }, z: 3 },
  { key: "B", rect: { x: 600, y: 40, width: 800, height: 960 }, z: 1 },
  { key: "C", rect: { x: 700, y: 40, width: 800, height: 960 }, z: 2 },
];
check("2 cửa sổ chồng nhau → cửa sổ được focus gần nhất thắng", drop(1000, 500, "A", OVERLAP), {
  action: "send",
  key: "C",
});
// Same set, but now B is the recent one — the answer must follow z, not list order.
const OVERLAP2 = OVERLAP.map((t) => (t.key === "B" ? { ...t, z: 9 } : t));
check("đổi thứ tự focus → đích đổi theo", drop(1000, 500, "A", OVERLAP2), { action: "send", key: "B" });
check("chỉ chồng lên 1 cửa sổ → không cần z", drop(650, 500, "A", OVERLAP), { action: "send", key: "B" });
// Source overlapped by another window still wins: the reorder gesture is sacred.
const SRC_UNDER = [
  { key: "A", rect: { x: 0, y: 40, width: 800, height: 960 }, z: 1 },
  { key: "B", rect: { x: 0, y: 40, width: 800, height: 960 }, z: 99 },
];
check("cửa sổ nguồn bị cửa sổ khác chồng lên → VẪN là self (BI-54)", drop(400, 500, "A", SRC_UNDER), {
  action: "self",
  key: "A",
});
// Missing z must not throw or win by accident.
const NO_Z = [
  { key: "B", rect: { x: 900, y: 40, width: 800, height: 960 } },
  { key: "C", rect: { x: 900, y: 40, width: 800, height: 960 }, z: 1 },
];
check("thiếu z → coi như 0, không thắng cửa sổ có z", drop(1200, 500, "A", NO_Z), {
  action: "send",
  key: "C",
});

// ---------------------------------------------------------------------------
console.log("\n-- docViewScreenRect (vùng thả = đúng vùng _layout vẽ) --");

// Real prototype, plain-object window: the strip band must be excluded exactly as
// _layout excludes it, or the cue and the hit test disagree by 40px.
function mkWin({ x = 100, y = 200, width = 1000, height = 800, presenting = false } = {}) {
  const w = Object.create(P);
  w._presenting = presenting;
  w.base = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x, y, width, height }),
  };
  return w;
}
check("trừ đúng dải tab 40px", mkWin().docViewScreenRect(), {
  x: 100,
  y: 240,
  width: 1000,
  height: 760,
});
check("chế độ đọc toàn màn hình: dải tab nhường hết chỗ", mkWin({ presenting: true }).docViewScreenRect(), {
  x: 100,
  y: 200,
  width: 1000,
  height: 800,
});
check("cửa sổ thấp hơn dải tab → không có vùng thả", mkWin({ height: 40 }).docViewScreenRect(), null);
check("cửa sổ không có chiều rộng → không có vùng thả", mkWin({ width: 0 }).docViewScreenRect(), null);
const dead = mkWin();
dead.base.isDestroyed = () => true;
check("cửa sổ đã bị huỷ → null", dead.docViewScreenRect(), null);

// ---------------------------------------------------------------------------
console.log("\n-- docViewLocalPoint (toạ độ màn hình → toạ độ trong view) --");

const R = { x: 100, y: 240, width: 1000, height: 760 };
check("điểm giữa view", Tabs.docViewLocalPoint(R, { x: 600, y: 500 }), { x: 500, y: 260 });
check("gốc view = (0,0)", Tabs.docViewLocalPoint(R, { x: 100, y: 240 }), { x: 0, y: 0 });
check("làm tròn về số nguyên (DIP lẻ)", Tabs.docViewLocalPoint(R, { x: 600.6, y: 500.4 }), {
  x: 501,
  y: 260,
});
check("không có rect → null", Tabs.docViewLocalPoint(null, { x: 1, y: 1 }), null);
check("không có điểm → null", Tabs.docViewLocalPoint(R, null), null);
check("điểm NaN → null", Tabs.docViewLocalPoint(R, { x: NaN, y: 1 }), null);

// ---------------------------------------------------------------------------
console.log("\n-- actionSet (kéo 1 trang hay cả tập đã tick) --");

const set = (...v) => new Set(v);
// Đã chốt §9.3: trang đang kéo nằm trong tập đã tick → lấy cả tập; ngoài tập → chỉ nó.
check("kéo trang NGOÀI vùng tick → chỉ trang đó", PageRange.actionSet(5, set(1, 2, 3)), [5]);
check("kéo trang TRONG vùng tick → cả tập", PageRange.actionSet(2, set(1, 2, 3)), [1, 2, 3]);
check("tập trả về đã sắp xếp", PageRange.actionSet(2, set(7, 2, 0)), [0, 2, 7]);
check("không tick gì → chỉ trang đang kéo", PageRange.actionSet(4, set()), [4]);
check("trang 0 trong tập", PageRange.actionSet(0, set(0, 1)), [0, 1]);
check("trang 0 ngoài tập", PageRange.actionSet(0, set(3)), [0]);
check("nhận mảng thay cho Set", PageRange.actionSet(2, [1, 2, 3]), [1, 2, 3]);
check("bỏ trùng lặp", PageRange.actionSet(2, [2, 2, 1]), [1, 2]);
check("lọc phần tử rác trong tập", PageRange.actionSet(2, [2, -1, 1.5, null, "x", 4]), [2, 4]);
// Chỉ số rác vào → không trang nào ra. Người gọi thấy [] thì dừng, chứ không "đoán trang 0".
check("chỉ số âm → rỗng", PageRange.actionSet(-1, set(0)), []);
check("chỉ số không phải số → rỗng", PageRange.actionSet("x", set(0)), []);
check("chỉ số undefined → rỗng", PageRange.actionSet(undefined, set(0)), []);
check("tập rác + chỉ số hợp lệ → vẫn là trang đang kéo", PageRange.actionSet(3, null), [3]);

// ---------------------------------------------------------------------------
console.log("\n-- page-move.js: hợp đồng với scope dùng chung --");

// page-move.js reads a dozen names straight out of app.js's shared script scope,
// exactly as capture.js and find-replace.js do. That contract is invisible to any
// tool: rename insertBuffersAt in app.js and NOTHING complains until a user drags a
// page and the renderer throws. So it is asserted on the source here — the same
// device find-replace.test.js uses for its DOM half (REGRESSION-GUARD §1).
const fs = require("fs");
const RENDERER = path.join(__dirname, "..", "renderer");
const appSrc = fs.readFileSync(path.join(RENDERER, "app.js"), "utf8");
const moveSrc = fs.readFileSync(path.join(RENDERER, "page-move.js"), "utf8");

const SHARED = [
  "toU8",
  "licBlocked",
  "insertBuffersAt",
  "deletePages",
  "thumbGapAt",
  "showThumbGapCue",
  "clearThumbCues",
  "toggleSidebar",
  "showOverlay",
  "hideOverlay",
  "gateProFeature",
  "toast",
];
for (const name of SHARED) {
  const declared = new RegExp(`^(?:async )?function ${name}\\(|^const ${name} = `, "m").test(appSrc);
  const used = new RegExp(`\\b${name}\\s*\\(`).test(moveSrc);
  check(`app.js còn định nghĩa ${name} (page-move.js gọi bằng tên trần)`, declared && used, true);
}

// The three hooks app.js calls back into. A guard that silently stops matching means
// the feature quietly disappears from the UI instead of failing loudly.
check("app.js gọi PageMove.dragStart ở dragstart", /window\.PageMove\.dragStart\(/.test(appSrc), true);
check("app.js gọi PageMove.dragEnd ở dragend", /window\.PageMove\.dragEnd\(/.test(appSrc), true);
check(
  "menu chuột phải có mục chuyển trang",
  /window\.PageMove\.openSendMenu\(/.test(appSrc),
  true
);
// BI-53: the source may only delete after a confirmed insert. Pin the ordering in
// source, because getting it backwards loses a user's pages and no unit test on pure
// numbers can see it.
check(
  "MOVE chỉ xoá sau khi đích xác nhận (ok && unchanged)",
  /const moved = !!shift && res\.ok && unchanged\(fp\);[\s\S]{0,80}if \(moved\) await deletePages\(indices\);/.test(
    moveSrc
  ),
  true
);
// BI-52: a renderer must never be handed another renderer's webContents.
const tabsSrc = fs.readFileSync(path.join(__dirname, "..", "src", "tabs.js"), "utf8");
check(
  "pageTargetTabs vẫn cảnh báo không chuyển `wc` cho renderer",
  /wc` is here for main to talk to and MUST NOT be forwarded/.test(tabsSrc),
  true
);

// The file must load even with no preload bridge at all (a stripped/secured build,
// or simply a load-order slip): it registers nothing and exports its surface, rather
// than throwing and taking the rest of the renderer down with it (BI-14).
console.log("\n-- page-move.js: nạp được khi thiếu bridge --");
const prevWindow = global.window;
global.window = {};
let loadErr = null;
try {
  delete require.cache[require.resolve(path.join(RENDERER, "page-move.js"))];
  require(path.join(RENDERER, "page-move.js"));
} catch (err) {
  loadErr = err;
}
check("nạp không ném lỗi khi window.desktop không có", loadErr ? loadErr.message : null, null);
check("vẫn công bố đủ API", Object.keys((global.window && global.window.PageMove) || {}).sort(), [
  "dragEnd",
  "dragStart",
  "gapAt",
  "openSendMenu",
]);
global.window = prevWindow;

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

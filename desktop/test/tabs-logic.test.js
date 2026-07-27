"use strict";

// Regression net for the tab layer's pure logic (src/tabs.js): tab reordering and
// the keyboard router. These are the parts that can be verified WITHOUT a GUI, and
// the parts where a silent off-by-one would lose a user's document.
//
// Run:  node desktop/test/tabs-logic.test.js      (or: npm run test:tabs)
//
// `electron` is stubbed: tabs.js only touches BaseWindow/WebContentsView inside the
// constructor, and these tests drive the prototype methods against plain objects.

const path = require("path");
const Module = require("module");

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") {
    return {
      BaseWindow: class {},
      WebContentsView: class {},
      // One 1920x1040 display at the origin. placeTornWindow also needs a real
      // window to act on, so the tests below cover the decisions taken before it.
      screen: {
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
      },
    };
  }
  return origLoad.call(this, request, ...rest);
};

const Tabs = require(path.join(__dirname, "..", "src", "tabs.js"));
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

// Real prototype chain (so handleTabKey → cycleTab → activateTab resolves exactly
// as in the app), with only the two side-effecting methods stubbed.
function mk(ids, activeId) {
  const w = Object.create(P);
  w.tabs = ids.map((id) => ({ id }));
  w.activeId = activeId === undefined ? ids[0] : activeId;
  w._emit = () => {};
  w.activateTab = function (id) {
    this.activeId = id;
  };
  return w;
}
const order = (w) => w.tabs.map((t) => t.id);

console.log("\n-- reorderTabs (kéo sắp xếp tab) --");
let w = mk([1, 2, 3]);
w.reorderTabs([3, 1, 2]);
check("hoán vị hợp lệ", order(w), [3, 1, 2]);

w = mk([1, 2, 3]);
w.reorderTabs([2, 1]); // stale: a tab closed mid-drag
check("danh sách thiếu tab → giữ nguyên", order(w), [1, 2, 3]);

w = mk([1, 2, 3]);
w.reorderTabs([1, 2, 99]);
check("id lạ → giữ nguyên (không mất tab)", order(w), [1, 2, 3]);

w = mk([1, 2, 3]);
w.reorderTabs([1, 1, 2]);
check("id lặp → giữ nguyên", order(w), [1, 2, 3]);

w = mk([1, 2, 3]);
w.reorderTabs(null);
w.reorderTabs([]);
w.reorderTabs("rác");
check("đầu vào rác → giữ nguyên", order(w), [1, 2, 3]);

w = mk([1, 2, 3], 2);
w.reorderTabs([3, 2, 1]);
check("tab đang xem không đổi sau khi sắp lại", w.activeId, 2);

console.log("\n-- cycleTab (Ctrl+Tab) --");
w = mk([1, 2, 3], 1);
w.cycleTab(1);
check("1 → 2", w.activeId, 2);
w = mk([1, 2, 3], 3);
w.cycleTab(1);
check("tab cuối → quay vòng về đầu", w.activeId, 1);
w = mk([1, 2, 3], 1);
w.cycleTab(-1);
check("tab đầu, lùi → về cuối", w.activeId, 3);
w = mk([7], 7);
w.cycleTab(1);
check("một tab duy nhất → không đổi", w.activeId, 7);

console.log("\n-- handleTabKey (bộ định tuyến phím) --");
// On win32/linux the modifier is control; on darwin it is meta.
const MOD = process.platform === "darwin" ? "meta" : "control";
const mod = (over) =>
  Object.assign({ type: "keyDown", control: false, meta: false, shift: false, alt: false, [MOD]: true }, over);

w = mk([10, 20, 30, 40], 10);
check("Mod+2 → tab thứ 2", [w.handleTabKey(mod({ key: "2" })), w.activeId], [true, 20]);
w = mk([10, 20, 30, 40], 10);
check("Mod+9 → tab CUỐI", [w.handleTabKey(mod({ key: "9" })), w.activeId], [true, 40]);
w = mk([10, 20, 30], 10);
check("Mod+7 khi không có tab 7 → nuốt phím, không đổi", [w.handleTabKey(mod({ key: "7" })), w.activeId], [true, 10]);
w = mk([10, 20, 30], 10);
check("Mod+Tab", [w.handleTabKey(mod({ key: "Tab" })), w.activeId], [true, 20]);
w = mk([10, 20, 30], 10);
check("Mod+Shift+Tab", [w.handleTabKey(mod({ key: "Tab", shift: true })), w.activeId], [true, 30]);

// Everything below must be IGNORED so the renderer keeps owning those keys.
w = mk([10, 20, 30], 10);
check("phím '2' trần → bỏ qua", w.handleTabKey({ type: "keyDown", control: false, meta: false, shift: false, alt: false, key: "2" }), false);
w = mk([10, 20, 30], 10);
check("Mod+Alt+2 → bỏ qua", w.handleTabKey(mod({ key: "2", alt: true })), false);
w = mk([10, 20, 30], 10);
check("keyUp → bỏ qua (không xử lý hai lần)", w.handleTabKey(mod({ key: "2", type: "keyUp" })), false);
w = mk([10, 20, 30], 10);
check("Mod+Shift+2 → bỏ qua", w.handleTabKey(mod({ key: "2", shift: true })), false);
w = mk([10, 20, 30], 10);
check("Mod+S → bỏ qua (nhường menu Lưu)", w.handleTabKey(mod({ key: "s" })), false);
w = mk([10, 20, 30], 10);
check("Mod+0 → bỏ qua (nhường zoom reset)", w.handleTabKey(mod({ key: "0" })), false);

// ---------------------------------------------------------------------------
// Lớp 2b — tách tab thành cửa sổ riêng.
// ---------------------------------------------------------------------------

console.log("\n-- classifyDrop (thả tab ở đâu thì làm gì) --");
// One 1000x40 strip at the origin (window A) and another at x=1200 (window B).
const A = { x: 0, y: 0, width: 1000, height: 40 };
const B = { x: 1200, y: 0, width: 1000, height: 40 };
const RECTS = [
  { key: "A", rect: A },
  { key: "B", rect: B },
];
const drop = (x, y, src = "A", rects = RECTS, pad) => Tabs.classifyDrop({ x, y }, src, rects, pad);

check("thả trong thanh tab của chính nó → sắp xếp", drop(500, 20), { action: "reorder", key: "A" });
check("thả vào thanh tab cửa sổ khác → chuyển", drop(1500, 20), { action: "move", key: "B" });
check("thả sâu trong vùng tài liệu → tách", drop(500, 400), { action: "tear", key: null });
check("thả lệch xuống 30px → vẫn là sắp xếp (vùng đệm)", drop(500, 70), { action: "reorder", key: "A" });
check("thả lệch xuống 120px → tách", drop(500, 120), { action: "tear", key: null });
check("thả lệch ngang 20px → vẫn là sắp xếp", drop(1015, 20), { action: "reorder", key: "A" });
check("thả xa hẳn sang phải, ngoài mọi cửa sổ → tách", drop(1150, 300), { action: "tear", key: null });
check("không có toạ độ con trỏ → sắp xếp (không làm gì nguy hiểm)", Tabs.classifyDrop(null, "A", RECTS), {
  action: "reorder",
  key: "A",
});
check("toạ độ rác (NaN) → sắp xếp", Tabs.classifyDrop({ x: NaN, y: 10 }, "A", RECTS), { action: "reorder", key: "A" });
// Two windows stacked on top of each other: the one being dragged from must win,
// otherwise a plain reorder would fling the tab into the window underneath.
check(
  "thanh tab chồng nhau → cửa sổ nguồn thắng",
  drop(500, 20, "A", [
    { key: "B", rect: A },
    { key: "A", rect: A },
  ]),
  { action: "reorder", key: "A" }
);
check("chỉ có một cửa sổ, thả ra ngoài → tách", drop(500, 500, "A", [{ key: "A", rect: A }]), { action: "tear", key: null });
check("vùng đệm tuỳ chỉnh nới rộng → không tách", drop(500, 300, "A", RECTS, { x: 0, y: 400 }), { action: "reorder", key: "A" });

console.log("\n-- detachTab (gỡ tab KHÔNG giết renderer) --");
// Fuller fake: the move-house methods touch the view tree and the pending-close
// map. Every stand-in records what was done to it so the tests can assert that
// a detach never closes a webContents (BI-15).
function mkWin(ids, activeId) {
  const w = mk(ids, activeId);
  w.wcClosed = [];
  w.removed = [];
  w.closed = false;
  w.tabs = ids.map((id) => ({
    id,
    title: "doc" + id,
    dirty: false,
    view: { webContents: { isDestroyed: () => false, close: () => w.wcClosed.push(id) } },
  }));
  w._pendingClose = new Map();
  w.base = {
    isDestroyed: () => false,
    isMinimized: () => false,
    close: () => {
      w.closed = true;
    },
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    contentView: { removeChildView: (v) => w.removed.push(v), addChildView: () => {} },
  };
  return w;
}

w = mkWin([1, 2, 3], 1);
let got = w.detachTab(2);
check("gỡ tab không active", [order(w), got && got.id, w.activeId], [[1, 3], 2, 1]);
check("gỡ tab KHÔNG đóng webContents (BI-15)", w.wcClosed, []);
check("gỡ tab có gỡ khỏi cây view", w.removed.length, 1);

w = mkWin([1, 2, 3], 2);
w.detachTab(2);
check("gỡ tab đang xem → tab kế bên lên thay", [order(w), w.activeId], [[1, 3], 3]);

w = mkWin([1, 2, 3], 3);
w.detachTab(3);
check("gỡ tab cuối đang xem → lùi về tab trước", [order(w), w.activeId], [[1, 2], 2]);

w = mkWin([1, 2, 3], 1);
check("gỡ id không tồn tại → null", w.detachTab(99), null);
check("… và không đụng gì", [order(w), w.removed.length], [[1, 2, 3], 0]);

w = mkWin([1, 2, 3], 1);
w._pendingClose.set(2, {});
check("đang chờ quyết định đóng → từ chối gỡ", w.detachTab(2), null);
check("… tab vẫn còn nguyên", order(w), [1, 2, 3]);

w = mkWin([5], 5);
w.detachTab(5);
check("gỡ tab duy nhất → cửa sổ rỗng, chưa tự đóng", [order(w), w.activeId, w.closed], [[], null, false]);

console.log("\n-- adoptTab / moveTabTo (nhận nuôi & chuyển cửa sổ) --");
let src = mkWin([1, 2], 1);
let dst = mkWin([9], 9);
const moved = src.tabs[0];
src.detachTab(1);
dst.adoptTab(moved);
check("nhận nuôi → nối vào cuối và được kích hoạt", [order(dst), dst.activeId], [[9, 1], 1]);

dst = mkWin([9], 9);
check("nhận nuôi rác → null", dst.adoptTab(null), null);
check("nhận nuôi view đã chết → null", dst.adoptTab({ id: 4, view: { webContents: { isDestroyed: () => true } } }), null);
check("… danh sách tab không đổi", order(dst), [9]);

src = mkWin([1, 2], 1);
dst = mkWin([9], 9);
dst.focus = () => {};
check("chuyển tab sang cửa sổ khác", [src.moveTabTo(1, dst), order(src), order(dst)], [true, [2], [9, 1]]);
check("cửa sổ nguồn còn tab → không đóng", src.closed, false);

src = mkWin([1], 1);
dst = mkWin([9], 9);
dst.focus = () => {};
src.moveTabTo(1, dst);
check("chuyển nốt tab cuối → cửa sổ nguồn tự đóng", [order(src), src.closed, order(dst)], [[], true, [9, 1]]);
check("… và tự đóng KHÔNG giết tab đã chuyển", src.wcClosed, []);

src = mkWin([1, 2], 1);
check("chuyển sang chính nó → từ chối", src.moveTabTo(1, src), false);
check("chuyển sang cửa sổ đã huỷ → từ chối", src.moveTabTo(1, { base: { isDestroyed: () => true } }), false);
check("… tab vẫn nguyên vẹn", order(src), [1, 2]);

console.log("\n-- tearOutTab (chặn tách tab duy nhất) --");
w = mkWin([7], 7);
check("cửa sổ chỉ có 1 tab → không tách", w.tearOutTab(7, { x: 10, y: 10 }), null);
check("… tab đứng yên", [order(w), w.removed.length], [[7], 0]);

// ---------------------------------------------------------------------------
// Khôi phục phiên — phần chụp trạng thái (src/tabs.js) và luật ghi (src/session.js).
// ---------------------------------------------------------------------------

console.log("\n-- sanitizeBounds (đừng khôi phục cửa sổ ra ngoài màn hình) --");
// The electron stub reports a single 1920x1040 work area at the origin.
check("vị trí hợp lệ → giữ nguyên", Tabs.sanitizeBounds({ x: 100, y: 80, width: 900, height: 600 }), {
  x: 100,
  y: 80,
  width: 900,
  height: 600,
});
check("làm tròn số lẻ", Tabs.sanitizeBounds({ x: 10.6, y: 20.2, width: 800.4, height: 600.5 }), {
  x: 11,
  y: 20,
  width: 800,
  height: 601,
});
check("không có bounds → để Electron tự đặt", Tabs.sanitizeBounds(null), undefined);
check("bounds rác → bỏ", Tabs.sanitizeBounds({ x: "a", y: 0, width: 800, height: 600 }), undefined);
check("kích thước 0 → bỏ", Tabs.sanitizeBounds({ x: 0, y: 0, width: 0, height: 600 }), undefined);
// Monitors get unplugged between sessions; a window restored onto one that is
// gone would be invisible and unrecoverable without knowing the shortcut.
check("nằm hẳn ngoài vùng làm việc (màn hình đã rút) → bỏ", Tabs.sanitizeBounds({ x: 5000, y: 200, width: 900, height: 600 }), undefined);
check("thò vào chỉ 50px → coi như ngoài màn hình", Tabs.sanitizeBounds({ x: 1870, y: 100, width: 900, height: 600 }), undefined);
check("thò vào 300px → chấp nhận", Tabs.sanitizeBounds({ x: 1620, y: 100, width: 900, height: 600 }), {
  x: 1620,
  y: 100,
  width: 900,
  height: 600,
});

console.log("\n-- snapshotSession (chụp cái gì, bỏ cái gì) --");
// snapshotSession walks the module's private window set, so drive it through a
// real TabbedWindow whose Electron bits are stubbed.
function fakeWin(tabs, activeId, opts = {}) {
  const w = Object.create(P);
  w.tabs = tabs;
  w.activeId = activeId;
  w._closing = !!opts.closing;
  w.base = {
    isDestroyed: () => !!opts.destroyed,
    isMaximized: () => !!opts.maximized,
    getNormalBounds: () => opts.bounds || { x: 1, y: 2, width: 3, height: 4 },
  };
  return w;
}
const tab = (id, p) => ({ id, path: p || null });

// snapshotSession normally walks the module's private window set; it accepts an
// explicit list so the shape it produces can be checked without a real window.
const snapWith = (windows) => Tabs.snapshotSession(windows);

check(
  "chụp đường dẫn + tab đang xem",
  snapWith([fakeWin([tab(1, "a.pdf"), tab(2, "b.pdf")], 2, { bounds: { x: 10, y: 20, width: 800, height: 600 } })]),
  { windows: [{ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: false, active: 1, tabs: ["a.pdf", "b.pdf"] }] }
);
// A tab holding a brand-new or never-saved document has no path to point at —
// its content is crash recovery's job, not the session's.
check(
  "tab chưa có file → bỏ qua, chỉ số tab đang xem vẫn đúng",
  snapWith([fakeWin([tab(1), tab(2, "b.pdf"), tab(3, "c.pdf")], 3)]).windows[0],
  { bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: false, active: 1, tabs: ["b.pdf", "c.pdf"] }
);
check("cửa sổ không có tab nào lưu được → không ghi", snapWith([fakeWin([tab(1), tab(2)], 1)]), { windows: [] });
check("cửa sổ đang đóng dở → không ghi (trạng thái tạm)", snapWith([fakeWin([tab(1, "a.pdf")], 1, { closing: true })]), {
  windows: [],
});
check("cửa sổ đã huỷ → không ghi", snapWith([fakeWin([tab(1, "a.pdf")], 1, { destroyed: true })]), { windows: [] });
check("cửa sổ phóng to → nhớ cờ maximized", snapWith([fakeWin([tab(1, "a.pdf")], 1, { maximized: true })]).windows[0].maximized, true);
check(
  "nhiều cửa sổ",
  snapWith([fakeWin([tab(1, "a.pdf")], 1), fakeWin([tab(2, "b.pdf"), tab(3, "c.pdf")], 3)]).windows.map((w) => w.tabs),
  [["a.pdf"], ["b.pdf", "c.pdf"]]
);

console.log("\n-- session.js (luật ghi ra đĩa) --");
const os = require("os");
const fsx = require("fs");
const Session = require(path.join(__dirname, "..", "src", "session.js"));
const tmpFile = path.join(fsx.mkdtempSync(path.join(os.tmpdir(), "nabu-sess-")), "session.json");

let live = { windows: [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: false, active: 0, tabs: ["a.pdf"] }] };
let closing = false;
Session.configure({ file: tmpFile, snapshot: () => live, anyClosing: () => closing });

check("chưa có file → mặc định BẬT", Session.isEnabled(), true);
check("chưa có file → không có phiên cũ", Session.previousWindows(), []);

Session.saveNow();
const onDisk = () => JSON.parse(fsx.readFileSync(tmpFile, "utf8"));
check("ghi được", [onDisk().v, onDisk().restore, onDisk().windows.length], [1, true, 1]);

// Mid-teardown the tab list is a lie in progress; writing it would record a
// half-closed app as the thing to restore.
closing = true;
live = { windows: [] };
Session.saveNow();
check("đang đóng dở → KHÔNG ghi đè", onDisk().windows.length, 1);
Session.cancel();
closing = false;

Session.setEnabled(false);
check("tắt công tắc → ghi ngay vào file", onDisk().restore, false);
check("… và đọc lại đúng", Session.isEnabled(), false);
Session.setEnabled(true);

// A corrupt or future-version file must never take the app down at launch.
fsx.writeFileSync(tmpFile, "{ not json");
Session.configure({ file: tmpFile, snapshot: () => live, anyClosing: () => false });
check("file hỏng → coi như chưa có, không ném lỗi", [Session.isEnabled(), Session.previousWindows()], [true, []]);
fsx.writeFileSync(tmpFile, JSON.stringify({ v: 99, windows: [{ tabs: ["x.pdf"] }] }));
Session.configure({ file: tmpFile, snapshot: () => live, anyClosing: () => false });
check("file phiên bản lạ → bỏ qua", Session.previousWindows(), []);

try {
  fsx.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
} catch (_) {
  /* temp dir cleanup is best-effort */
}

// ---------------------------------------------------------------------------
console.log("\n-- chế độ toàn màn hình (đọc) --");
// The half of reading mode that lives in main: the tab strip gives up its band so
// the document view really covers the screen, and every tab is told, because
// switching tabs inside the mode must not land on a renderer that still thinks it
// has a toolbar.

// NB: not `mkWin` — that name is already taken above, and a second function
// declaration would hoist over it and quietly break the detach tests.
function mkPresentWin(ids, { presenting = false, fullScreen = false } = {}) {
  const w = Object.create(P);
  w.tabs = ids.map((id) => ({ id, view: { setBounds: (b) => (w._bounds[id] = b), webContents: { isDestroyed: () => false, send: (ch, v) => w._sent.push([id, ch, v]) } } }));
  w.activeId = ids[0];
  w._presenting = presenting;
  w._bounds = {};
  w._sent = [];
  w._stripBounds = null;
  w._fullScreen = fullScreen;
  w.strip = { setBounds: (b) => (w._stripBounds = b) };
  w.base = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isFullScreen: () => w._fullScreen,
    setFullScreen: (v) => {
      w._fullScreen = v;
    },
  };
  return w;
}

let pw = mkPresentWin([1, 2]);
pw._layout();
check("bình thường: strip chiếm 40px", [pw._stripBounds.height, pw._bounds[1].y, pw._bounds[1].height], [40, 40, 760]);

pw = mkPresentWin([1, 2], { presenting: true });
pw._layout();
check("toàn màn hình: strip 0px, tài liệu full", [pw._stripBounds.height, pw._bounds[1].y, pw._bounds[1].height], [0, 0, 800]);

pw = mkPresentWin([1, 2, 3]);
pw._applyPresentation(true);
check("bật → mọi tab được báo", pw._sent.map((s) => [s[0], s[2]]), [[1, true], [2, true], [3, true]]);
check("bật → strip thu về 0", pw._stripBounds.height, 0);

pw._sent.length = 0;
pw._applyPresentation(true); // already on
check("bật lại khi đang bật → không phát lại", pw._sent, []);

pw._applyPresentation(false);
check("tắt → mọi tab được báo", pw._sent.map((s) => [s[0], s[2]]), [[1, false], [2, false], [3, false]]);
check("tắt → strip lấy lại 40px", pw._stripBounds.height, 40);

pw = mkPresentWin([1]);
pw.setPresentation(true);
check("setPresentation bật cửa sổ + cờ nội bộ", [pw._fullScreen, pw._presenting], [true, true]);
pw.setPresentation(false);
check("setPresentation tắt cả hai", [pw._fullScreen, pw._presenting], [false, false]);

// The OS can leave full screen on its own (window controls); the window's own
// event drives _applyPresentation, so the renderers follow without a round trip.
pw = mkPresentWin([1], { presenting: true, fullScreen: true });
pw._applyPresentation(false);
check("OS thoát toàn màn hình → renderer được báo", [pw._presenting, pw._sent[0][2]], [false, false]);

// ---------------------------------------------------------------------------
console.log("\n-- prefs.js (tuỳ chọn phía main) --");
// The "Mở file mới trong" setting has to be readable before any renderer exists
// (Explorer "Open with" arrives with no window), so it lives on disk in main.

const Prefs = require(path.join(__dirname, "..", "src", "prefs.js"));
const prefsFile = path.join(fsx.mkdtempSync(path.join(os.tmpdir(), "nabu-prefs-")), "prefs.json");

Prefs.configure({ file: prefsFile });
check("chưa có file → mặc định 'tab' (hành vi cũ)", Prefs.getOpenIn(), "tab");

check("đặt 'window' trả về đúng giá trị đã lưu", Prefs.setOpenIn("window"), "window");
check("… và ghi ra đĩa", JSON.parse(fsx.readFileSync(prefsFile, "utf8")), { v: 1, openIn: "window" });
Prefs.configure({ file: prefsFile });
check("… đọc lại sau khi khởi động lại", Prefs.getOpenIn(), "window");

// The value crosses an IPC boundary from the renderer, so it is untrusted input:
// anything outside the whitelist must land on the default, not in window routing.
check("giá trị lạ → về mặc định", Prefs.setOpenIn("popup"), "tab");
check("null → về mặc định", Prefs.setOpenIn(null), "tab");
check("object → về mặc định", Prefs.setOpenIn({ openIn: "window" }), "tab");

fsx.writeFileSync(prefsFile, "{ not json");
Prefs.configure({ file: prefsFile });
check("file hỏng → mặc định, không ném lỗi", Prefs.getOpenIn(), "tab");
fsx.writeFileSync(prefsFile, JSON.stringify({ v: 99, openIn: "window" }));
Prefs.configure({ file: prefsFile });
check("file phiên bản lạ → bỏ qua", Prefs.getOpenIn(), "tab");
fsx.writeFileSync(prefsFile, JSON.stringify({ v: 1, openIn: "elsewhere" }));
Prefs.configure({ file: prefsFile });
check("giá trị hỏng trên đĩa → bỏ qua", Prefs.getOpenIn(), "tab");

try {
  fsx.rmSync(path.dirname(prefsFile), { recursive: true, force: true });
} catch (_) {
  /* temp dir cleanup is best-effort */
}

// ---------------------------------------------------------------------------
console.log("\n-- planOpen (mở file vào đâu) --");
// BI-8 lives here: no route may ever drop a document on top of one already open.
// Every case below is checked for that as well as for the requested placement.

const plan = (paths, opts) => Tabs.planOpen(paths, opts);
const PA = "a.pdf";
const PB = "b.pdf";

check("mặc định: 1 file → tab mới ở cửa sổ này", plan([PA], { openIn: "tab" }), {
  fill: null,
  sameWindow: [PA],
  newWindow: [],
});
check("tuỳ chọn cửa sổ: 1 file → cửa sổ mới", plan([PA], { openIn: "window" }), {
  fill: null,
  sameWindow: [],
  newWindow: [PA],
});
check("tuỳ chọn cửa sổ: nhiều file → MỘT cửa sổ mới, không phải mỗi file một cửa sổ", plan([PA, PB], { openIn: "window" }), {
  fill: null,
  sameWindow: [],
  newWindow: [PA, PB],
});
// An empty tab is the user filling THIS window; the preference is about adding a
// document *alongside* one, so it stands down — otherwise the blank window they
// are looking at stays blank and a second one appears.
check("tab đang trống → nạp vào chính tab đó, kể cả khi chọn 'cửa sổ mới'", plan([PA], { fillCurrent: true, openIn: "window" }), {
  fill: PA,
  sameWindow: [],
  newWindow: [],
});
check("tab trống + nhiều file → file đầu vào tab này, phần còn lại là tab ở cùng cửa sổ", plan([PA, PB], { fillCurrent: true, openIn: "window" }), {
  fill: PA,
  sameWindow: [PB],
  newWindow: [],
});
check("tab trống + mặc định", plan([PA, PB], { fillCurrent: true, openIn: "tab" }), {
  fill: PA,
  sameWindow: [PB],
  newWindow: [],
});
// BI-8: the asking tab only ever receives a document when it was declared empty.
check("KHÔNG bao giờ đè lên tab đang có tài liệu (mặc định)", plan([PA, PB], { openIn: "tab" }).fill, null);
check("KHÔNG bao giờ đè lên tab đang có tài liệu (cửa sổ mới)", plan([PA, PB], { openIn: "window" }).fill, null);
// Junk in, nothing out — an empty batch must not create an empty window.
check("danh sách rỗng", plan([], { openIn: "window" }), { fill: null, sameWindow: [], newWindow: [] });
check("không phải mảng", plan(null, { openIn: "window" }), { fill: null, sameWindow: [], newWindow: [] });
check("lọc phần tử rác", plan([PA, "", null, 7, PB], { openIn: "tab" }).sameWindow, [PA, PB]);
check("tab trống nhưng danh sách rỗng → không nạp gì", plan([], { fillCurrent: true }), {
  fill: null,
  sameWindow: [],
  newWindow: [],
});
// An unreadable preference must degrade to the behaviour that existed before the
// setting did, never to "scatter the user's documents across new windows".
check("thiếu tuỳ chọn → coi như 'tab'", plan([PA]), { fill: null, sameWindow: [PA], newWindow: [] });
check("tuỳ chọn rác → coi như 'tab'", plan([PA], { openIn: "nonsense" }), { fill: null, sameWindow: [PA], newWindow: [] });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

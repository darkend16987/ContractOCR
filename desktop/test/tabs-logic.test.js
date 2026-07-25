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
  if (request === "electron") return { BaseWindow: class {}, WebContentsView: class {} };
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

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

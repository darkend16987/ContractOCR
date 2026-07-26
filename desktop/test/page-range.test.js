"use strict";

// Regression net for page-range arithmetic (renderer/page-range.js) — the maths
// behind "Xoá nhiều trang theo khoảng" and the page-spec fields. A silent
// off-by-one here deletes the wrong page of a real document, so this is the one
// piece of the new page-ops work that gets an automated grid.
//
// Run:  node desktop/test/page-range.test.js      (or: npm run test:pages)

const PR = require("../renderer/page-range.js");

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

const spec = (s, n) => [...PR.parseSpec(s, n)].sort((x, y) => x - y);

// ---- parseSpec -----------------------------------------------------------

check("bare number → 0-based", spec("5", 10), [4]);
check("simple range", spec("2-4", 10), [1, 2, 3]);
check("mixed list", spec("1-3,5,8-10", 10), [0, 1, 2, 4, 7, 8, 9]);
check("spaces tolerated", spec(" 1 - 3 , 5 ", 10), [0, 1, 2, 4]);
check("semicolon separator", spec("1;3", 10), [0, 2]);
check("reversed pair swaps", spec("7-3", 10), [2, 3, 4, 5, 6]);
check("clamped above page count", spec("8-99", 10), [7, 8, 9]);
check("clamped below 1", spec("0", 10), [0]);
check("duplicates collapse", spec("2,2,1-2", 10), [0, 1]);
check("en dash accepted", spec("2–4", 10), [1, 2, 3]);
check("junk token skipped", spec("abc,3", 10), [2]);
check("leading dash is junk, not negative", spec("-3,5", 10), [4]);
check("empty spec → empty", spec("", 10), []);
check("null spec → empty", spec(null, 10), []);
check("zero pages → empty", spec("1-5", 0), []);

// ---- computeRange --------------------------------------------------------

check("plain range", PR.computeRange(2, 5, "", 10).indices, [1, 2, 3, 4]);
check("range minus one page", PR.computeRange(2, 5, "3", 10).indices, [1, 3, 4]);
check("range minus a sub-range", PR.computeRange(1, 10, "3-8", 10).indices, [0, 1, 8, 9]);
check(
  "exceptions outside the range are ignored",
  PR.computeRange(2, 4, "9", 10).indices,
  [1, 2, 3]
);
check("single page", PR.computeRange(7, 7, "", 10).indices, [6]);
check("reversed from/to swaps", PR.computeRange(5, 2, "", 10).indices, [1, 2, 3, 4]);
check("out-of-range clamps", PR.computeRange(0, 999, "1-9", 10).indices, [9]);
check("kept counts the survivors", PR.computeRange(1, 4, "2", 10).kept, 7);

// Refusals — each must be reported, never silently "fixed".
check("everything excluded → empty", PR.computeRange(2, 4, "2-4", 10).error, "empty");
check("whole document → all", PR.computeRange(1, 10, "", 10).error, "all");
check("whole doc via clamping → all", PR.computeRange(1, 500, "", 10).error, "all");
check("no document → no-doc", PR.computeRange(1, 5, "", 0).error, "no-doc");
check("valid request has no error", PR.computeRange(1, 9, "", 10).error, null);
// Guard case: leaving exactly one page is legal, taking that last one is not.
check("leaving 1 page is allowed", PR.computeRange(1, 9, "", 10).indices.length, 9);

// ---- formatList ----------------------------------------------------------

check("empty list", PR.formatList([]), "");
check("single page is 1-based", PR.formatList([0]), "1");
check("consecutive pages collapse", PR.formatList([0, 1, 2]), "1–3");
check("mixed groups", PR.formatList([0, 2, 3, 4, 8]), "1, 3–5, 9");
check("unsorted input is sorted", PR.formatList([8, 0, 3, 2, 4]), "1, 3–5, 9");
check("pairs stay explicit", PR.formatList([0, 1]), "1–2");
check(
  "long lists are truncated",
  PR.formatList([0, 2, 4, 6, 8, 10, 12, 14, 16, 18], 3),
  "1, 3, 5…"
);

// ---- extractFileName -----------------------------------------------------

const fn = (n, base = "HopDong") => PR.extractFileName(base, [...Array(n).keys()]);

// Small selections keep the friendly explicit form (unchanged behaviour).
check("single page", PR.extractFileName("HopDong", [0]), "HopDong-trang-1.pdf");
check("a few pages listed", PR.extractFileName("HopDong", [0, 2, 4]), "HopDong-trang-1_3_5.pdf");
check("50 pages still explicit", fn(50).startsWith("HopDong-trang-1_2_3_"), true);
check("no pages → base only", PR.extractFileName("HopDong", []), "HopDong.pdf");
check("empty base falls back", PR.extractFileName("", [0]), "document-trang-1.pdf");

// The regression: an unbounded name used to reach the Windows save dialog.
check("200 pages fits the budget", fn(200).length <= 200, true);
check("200 pages collapses to a range", fn(200), "HopDong-trang-1-200.pdf");
check("2000 pages fits the budget", fn(2000).length <= 200, true);
check(
  "scattered big selection is summarised and bounded",
  PR.extractFileName("HopDong", [...Array(300).keys()].filter((i) => i % 2 === 0)).length <= 200,
  true
);
check(
  "scattered summary uses filename-safe separators",
  /^[^\\/:*?"<>|]+$/.test(
    PR.extractFileName("HopDong", [...Array(300).keys()].filter((i) => i % 2 === 0))
  ),
  true
);
// An oversized base name must be trimmed, never the page part.
const longBase = "x".repeat(400);
const longName = PR.extractFileName(longBase, [0, 1, 2]);
check("oversized base is trimmed", longName.length <= 200, true);
// The page part collapses first (it's the cheaper cut), then the base is trimmed —
// so the pages survive in summary form, which is what makes the file identifiable.
check("oversized base keeps the page part", longName.endsWith("-trang-1-3.pdf"), true);
check("oversized base is what got cut", longName.startsWith("xxxx"), true);
// Guard case: prove the OLD naming really did overflow, so this test can't pass
// vacuously if the budget check is ever removed.
check(
  "guard — naming every page overflows 255",
  `HopDong-trang-${[...Array(200).keys()].map((i) => i + 1).join("_")}.pdf`.length > 255,
  true
);

console.log(`\npage-range: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

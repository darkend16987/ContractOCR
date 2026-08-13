"use strict";

/**
 * Grid for Explorer's "Gộp bằng Nabu PDF" verb — src/shell-combine.js plus the
 * installer script that has to agree with it.
 *
 * Three things are being defended:
 *
 *  1. combinePathFromArgv() must answer ONLY for a combine invocation. It shares an
 *     argv shape with "Open with", and main.js asks it BEFORE pdfPathFromArgv — so a
 *     false positive turns double-clicking one PDF into "open the merge dialog", and a
 *     false negative turns the menu item into a plain file-open. Both are silent.
 *
 *  2. planCombineBatch() decides what the user sees in the dialog. Explorer gives us
 *     no ordering and can hand the same file twice, so dedupe + a stable natural order
 *     are the behaviour, not an implementation detail.
 *
 *  3. The FLAG and the REGISTRY SUBKEY exist in two files — src/shell-combine.js and
 *     build/installer.nsh — and nothing at build time checks they match. If they drift,
 *     the installed menu item launches the app without the flag, the app treats it as
 *     "Open with", and the merge dialog simply never appears. Only a user would find
 *     that. So it is asserted here.
 *
 *   node test/shell-combine.test.js      (npm run test:combine)
 */

const fs = require("fs");
const path = require("path");
const SC = require("../src/shell-combine");

const NSH = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");

let pass = 0;
let fail = 0;

function group(name) {
  console.log("\n— " + name);
}
function check(what, ok, extra) {
  if (ok) {
    pass++;
    console.log("  ok   " + what);
  } else {
    fail++;
    console.log("  FAIL " + what + (extra === undefined ? "" : "  → " + extra));
  }
}
const EXE = "C:\\Program Files\\Nabu PDF\\Nabu PDF.exe";

// ---- 1. combinePathFromArgv ------------------------------------------------

group("combinePathFromArgv() answers only for a combine invocation");
check(
  "the shape the installer writes",
  SC.combinePathFromArgv([EXE, "--nabu-combine", "C:\\docs\\a.pdf"]) === "C:\\docs\\a.pdf"
);
check(
  "the = form, for a hand-edited registry command",
  SC.combinePathFromArgv([EXE, "--nabu-combine=C:\\docs\\a.pdf"]) === "C:\\docs\\a.pdf"
);
check(
  "a Chromium switch between the flag and the path is stepped over",
  SC.combinePathFromArgv([EXE, "--nabu-combine", "--allow-file-access", "C:\\a.pdf"]) === "C:\\a.pdf"
);
check("uppercase .PDF is still a PDF", SC.combinePathFromArgv([EXE, "--nabu-combine", "C:\\A.PDF"]) === "C:\\A.PDF");
check(
  "a path with spaces and Vietnamese diacritics survives",
  SC.combinePathFromArgv([EXE, "--nabu-combine", "D:\\Hợp đồng 2026\\phụ lục.pdf"]) === "D:\\Hợp đồng 2026\\phụ lục.pdf"
);
check("a UNC path survives", SC.combinePathFromArgv([EXE, "--nabu-combine", "\\\\srv\\share\\a.pdf"]) === "\\\\srv\\share\\a.pdf");

group("combinePathFromArgv() returns null for everything else");
// THE canh-gác case: this is the ordinary "Open with" argv. If this ever returns a
// path, double-clicking a single PDF opens the merge dialog instead of the document.
check('plain "Open with" argv → null', SC.combinePathFromArgv([EXE, "C:\\docs\\a.pdf"]) === null);
check("bare launch → null", SC.combinePathFromArgv([EXE]) === null);
check("flag with no path after it → null", SC.combinePathFromArgv([EXE, "--nabu-combine"]) === null);
check(
  "flag followed only by switches → null",
  SC.combinePathFromArgv([EXE, "--nabu-combine", "--foo", "--bar"]) === null
);
check("flag but the path is not a PDF → null", SC.combinePathFromArgv([EXE, "--nabu-combine", "C:\\a.docx"]) === null);
check('a file literally named ".pdf" → null', SC.combinePathFromArgv([EXE, "--nabu-combine", ".pdf"]) === null);
check("a similar-looking flag is not ours", SC.combinePathFromArgv([EXE, "--nabu-combine-x", "C:\\a.pdf"]) === null);
check("not an array → null", SC.combinePathFromArgv(null) === null);
check("non-string entries are skipped, not crashed on", SC.combinePathFromArgv([EXE, 7, "--nabu-combine", "C:\\a.pdf"]) === "C:\\a.pdf");

// ---- 2. planCombineBatch --------------------------------------------------

group("planCombineBatch() dedupes the ways Windows names one file twice");
{
  const { list } = SC.planCombineBatch(["C:\\d\\a.pdf", "C:\\D\\A.pdf"]);
  check("case-insensitive: one entry, not two", list.length === 1, JSON.stringify(list));
}
{
  const { list } = SC.planCombineBatch(["C:/d/a.pdf", "C:\\d\\a.pdf"]);
  check("forward and back slashes are the same file", list.length === 1, JSON.stringify(list));
}
{
  const { list } = SC.planCombineBatch(["C:\\d\\a.pdf", "C:\\d\\b.pdf", "C:\\d\\a.pdf"]);
  check("a repeat in the middle is dropped", list.length === 2, JSON.stringify(list));
}
{
  const { list } = SC.planCombineBatch(["C:\\d\\a.pdf", "C:\\other\\a.pdf"]);
  check("same NAME in different folders are two files", list.length === 2, JSON.stringify(list));
}

group("planCombineBatch() orders by filename, numerically");
{
  // The whole point: a plain string sort puts 10 before 2, which silently merges a
  // 12-part contract in the wrong order.
  const { list } = SC.planCombineBatch(["C:\\d\\10.pdf", "C:\\d\\2.pdf", "C:\\d\\1.pdf"]);
  check("1, 2, 10 — not 1, 10, 2", list.join("|") === "C:\\d\\1.pdf|C:\\d\\2.pdf|C:\\d\\10.pdf", list.join("|"));
}
{
  const { list } = SC.planCombineBatch(["C:\\d\\phu-luc-2.pdf", "C:\\d\\phu-luc-10.pdf"]);
  check("numeric ordering works mid-name", list[0].endsWith("2.pdf"), list.join("|"));
}
{
  // Order must depend on the FILENAME, not the folder it happens to sit in.
  const { list } = SC.planCombineBatch(["C:\\zzz\\a.pdf", "C:\\aaa\\b.pdf"]);
  check("sorted by basename, not by full path", list[0].endsWith("a.pdf"), list.join("|"));
}
{
  const a = SC.planCombineBatch(["C:\\x\\same.pdf", "C:\\a\\same.pdf"]).list;
  const b = SC.planCombineBatch(["C:\\a\\same.pdf", "C:\\x\\same.pdf"]).list;
  check("identical basenames still give a total, input-order-independent order", a.join("|") === b.join("|"), a.join("|") + " vs " + b.join("|"));
}

group("planCombineBatch() reports what the cap removed");
{
  const many = Array.from({ length: 8 }, (_, i) => `C:\\d\\f${i}.pdf`);
  const { list, dropped } = SC.planCombineBatch(many, { max: 3 });
  check("list is capped", list.length === 3, String(list.length));
  check("dropped counts the rest — nothing is trimmed in silence", dropped === 5, String(dropped));
}
{
  const { list, dropped } = SC.planCombineBatch(["C:\\d\\a.pdf"], { max: 3 });
  check("under the cap drops nothing", list.length === 1 && dropped === 0);
}
{
  // Dedupe happens BEFORE the cap, or five copies of one file would push four real
  // ones out of the batch.
  const { list, dropped } = SC.planCombineBatch(
    ["C:\\d\\a.pdf", "C:\\d\\a.pdf", "C:\\d\\a.pdf", "C:\\d\\b.pdf"],
    { max: 2 }
  );
  check("dedupe runs before the cap", list.length === 2 && dropped === 0, JSON.stringify(list));
}
check("empty input is not an error", SC.planCombineBatch([]).list.length === 0);
check("not an array is not an error", SC.planCombineBatch(undefined).list.length === 0);
check("non-PDF entries never reach the list", SC.planCombineBatch(["C:\\d\\a.txt", "C:\\d\\b.pdf"]).list.length === 1);
check("max of 0 still yields at least one file rather than an empty dialog", SC.planCombineBatch(["C:\\d\\a.pdf"], { max: 0 }).list.length === 1);
check("the default cap is MAX_BATCH", SC.planCombineBatch(Array.from({ length: SC.MAX_BATCH + 5 }, (_, i) => `C:\\d\\f${i}.pdf`)).dropped === 5);

// ---- createCombineBucket (defined here, RUN LAST — it is async) ------------
//
// This is the accumulation policy the shell forces on us: N processes, one path
// each, reassembled into ONE dialog. It used to live in main.js, where nothing can
// test it — that is the whole reason it is a factory with injected side effects.
//
// Timers are real but the window is set to a few ms per case, so the group takes
// well under a second. Its output appears after the synchronous groups below.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bucketCases() {
  group("createCombineBucket() reassembles the drip into ONE batch");
  {
    const seen = [];
    const b = SC.createCombineBucket({ windowMs: 20, onBatch: (l, d) => seen.push({ l, d }) });
    b.add("C:\\d\\1.pdf");
    b.add("C:\\d\\10.pdf");
    b.add("C:\\d\\2.pdf");
    check("nothing opens while files are still arriving", seen.length === 0);
    check("three paths are pending", b.pending === 3, String(b.pending));
    await sleep(60);
    check("exactly ONE batch is opened", seen.length === 1, String(seen.length));
    check(
      "and it is in natural order",
      seen[0] && seen[0].l.join("|") === "C:\\d\\1.pdf|C:\\d\\2.pdf|C:\\d\\10.pdf",
      seen[0] && seen[0].l.join("|")
    );
    check("the bucket is empty afterwards", b.pending === 0 && b.armed === false);
  }

  group("createCombineBucket() waits for the LAST arrival, not the first");
  {
    // The failure this prevents: a slow tail (Explorer still launching processes)
    // being cut off into a second dialog with the remaining files.
    const seen = [];
    const b = SC.createCombineBucket({ windowMs: 40, onBatch: (l) => seen.push(l) });
    b.add("C:\\d\\a.pdf");
    await sleep(25);
    b.add("C:\\d\\b.pdf"); // arrives before the window closes → must restart it
    await sleep(25);
    check("still nothing at 50ms, because the window restarted", seen.length === 0);
    b.add("C:\\d\\c.pdf");
    await sleep(80);
    check("one batch with all three", seen.length === 1 && seen[0].length === 3, JSON.stringify(seen));
  }

  group("createCombineBucket() holds off until the app can open a window");
  {
    // A cold-start selection's tail can arrive through second-instance before
    // Tabs/Prefs are configured. Opening then would dereference a null `deps`.
    const seen = [];
    let ready = false;
    const b = SC.createCombineBucket({ windowMs: 15, isReady: () => ready, onBatch: (l) => seen.push(l) });
    b.add("C:\\d\\a.pdf");
    await sleep(60);
    check("nothing opened while the app was still booting", seen.length === 0);
    check("the batch was NOT dropped — it is still pending", b.pending === 1, String(b.pending));
    check("and the timer re-armed rather than giving up", b.armed === true);
    ready = true;
    await sleep(60);
    check("it opens once the app is ready", seen.length === 1 && seen[0].length === 1, JSON.stringify(seen));
  }

  group("createCombineBucket() filters on the way in");
  {
    const seen = [];
    const b = SC.createCombineBucket({
      windowMs: 15,
      exists: (p) => !p.includes("gone"),
      onBatch: (l) => seen.push(l),
    });
    check("an existing file is accepted", b.add("C:\\d\\a.pdf") === true);
    check("a vanished file is refused", b.add("C:\\d\\gone.pdf") === false);
    check("a refused file does not count as pending", b.pending === 1, String(b.pending));
    await sleep(50);
    check("only the real file reaches the batch", seen.length === 1 && seen[0].length === 1, JSON.stringify(seen));
  }
  {
    const seen = [];
    const b = SC.createCombineBucket({
      windowMs: 15,
      resolvePath: (p) => (p.startsWith("C:") ? p : "C:\\base\\" + p),
      onBatch: (l) => seen.push(l),
    });
    // Resolve must happen BEFORE dedupe, or the same file named two ways becomes two
    // rows in the dialog.
    b.add("a.pdf");
    b.add("C:\\base\\a.pdf");
    await sleep(50);
    check("relative and absolute names of one file collapse to one row", seen[0].length === 1, JSON.stringify(seen));
  }
  {
    const b = SC.createCombineBucket({
      windowMs: 15,
      resolvePath: () => {
        throw new Error("bad path");
      },
    });
    check("a path that cannot be resolved is refused, not thrown", b.add("???") === false);
  }

  group("createCombineBucket() is reusable and never fires empty");
  {
    const seen = [];
    const b = SC.createCombineBucket({ windowMs: 15, onBatch: (l) => seen.push(l) });
    b.add("C:\\d\\a.pdf");
    await sleep(50);
    b.add("C:\\d\\b.pdf"); // a second right-click, later
    await sleep(50);
    check("two separate drips give two separate batches", seen.length === 2, String(seen.length));
    check("and the second does not carry the first's files", seen[1].length === 1, JSON.stringify(seen[1]));
  }
  {
    let calls = 0;
    const b = SC.createCombineBucket({ windowMs: 15, onBatch: () => calls++ });
    b.flush(); // nothing pending
    await sleep(40);
    check("flushing an empty bucket opens nothing", calls === 0, String(calls));
  }
  {
    const seen = [];
    const b = SC.createCombineBucket({ windowMs: 15, max: 2, onBatch: (l, d) => seen.push({ l, d }) });
    ["a", "b", "c", "d"].forEach((n) => b.add(`C:\\d\\${n}.pdf`));
    await sleep(50);
    check("the cap is applied", seen[0].l.length === 2, String(seen[0].l.length));
    check("and what it removed is reported, not hidden", seen[0].d === 2, String(seen[0].d));
  }
  check("BUCKET_MS leaves headroom over Explorer's launch gap", SC.BUCKET_MS >= 500 && SC.BUCKET_MS <= 2000, String(SC.BUCKET_MS));
}

// ---- 3. combineCommand ----------------------------------------------------

group("combineCommand()");
check(
  "the exe is quoted, so a Program Files path does not split into two args",
  SC.combineCommand(EXE) === `"${EXE}" --nabu-combine "%1"`,
  SC.combineCommand(EXE)
);
check('"%1" is quoted too — filenames contain spaces', SC.combineCommand(EXE).endsWith('"%1"'));
check("an empty exe path is refused", (() => { try { SC.combineCommand(""); return false; } catch (_) { return true; } })());
check(
  "an exe path containing a quote is refused rather than emitted",
  (() => { try { SC.combineCommand('C:\\a"b.exe'); return false; } catch (_) { return true; } })()
);

// ---- 4. the installer script agrees with this module ----------------------
//
// Nothing at build time cross-checks these. Drift = an installed menu item that
// launches the app WITHOUT the flag, so the app opens the file instead of the merge
// dialog and the feature is silently gone.

group("build/installer.nsh agrees with src/shell-combine.js");
check(`the .nsh passes ${SC.COMBINE_FLAG}`, NSH.includes(SC.COMBINE_FLAG), "flag missing from the installer command");
check("the .nsh registers the subkey this module names", NSH.includes(SC.REG_SUBKEY), SC.REG_SUBKEY);
check(
  'MultiSelectModel is "Player" — without it Explorer hides the item above 15 files',
  /"MultiSelectModel"\s+"Player"/.test(NSH)
);
check('the command passes "%1"', NSH.includes('"%1"'));
check("the verb is removed on uninstall, not left pointing at a deleted exe", /!macro customUnInstall[\s\S]*DeleteRegKey[\s\S]*!macroend/.test(NSH));
check("customInstall macro is defined", /!macro customInstall[\s\S]*!macroend/.test(NSH));
check(
  "the exe is referenced through electron-builder's variable, not a hard-coded name",
  NSH.includes("${APP_EXECUTABLE_FILENAME}") && !/Nabu PDF\.exe/.test(NSH),
  "a hard-coded exe name breaks the moment productName changes"
);
check(
  "SHCTX is used so a per-machine install does not register for the wrong user",
  NSH.includes("SHCTX") && !/HKCU\\|HKLM\\/.test(NSH)
);
{
  // NSIS 3 needs the BOM to read a UTF-8 script; without it the Vietnamese verb label
  // reaches the registry as mojibake and the menu item looks corrupt.
  const raw = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"));
  check(
    "the .nsh starts with a UTF-8 BOM (the verb label is Vietnamese)",
    raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
    `${raw[0]} ${raw[1]} ${raw[2]}`
  );
}
{
  // electron-builder only runs the file it is pointed at.
  const yml = fs.readFileSync(path.join(__dirname, "..", "electron-builder.yml"), "utf8");
  check("electron-builder.yml includes build/installer.nsh", /include:\s*build\/installer\.nsh/.test(yml));
}

// ---- 5. main.js asks in the order that matters ---------------------------
//
// combinePathFromArgv must be consulted BEFORE pdfPathFromArgv on BOTH argv routes
// (cold start and second-instance). Reversed, a combine invocation opens the file.
// An assertion on the source is the only grid available for this — main.js needs a
// running Electron.

group("main.js consults the combine branch first");
{
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const firstCombine = MAIN.indexOf("ShellCombine.combinePathFromArgv");
  const firstPdfCall = MAIN.indexOf("pdfPathFromArgv(argv)");
  check("both routes exist in main.js", firstCombine > 0 && firstPdfCall > 0);
  check(
    "second-instance asks ShellCombine before pdfPathFromArgv",
    firstCombine < firstPdfCall,
    `combine at ${firstCombine}, pdfPathFromArgv at ${firstPdfCall}`
  );
  const launchCombine = MAIN.indexOf("const launchCombine");
  const launchFile = MAIN.indexOf("const launchFile");
  check("the launch path asks ShellCombine before deciding launchFile", launchCombine > 0 && launchCombine < launchFile);
  check(
    "launchFile stands down when this is a combine launch",
    /const launchFile = launchCombine \? null :/.test(MAIN),
    "otherwise a combine launch also opens the first file as a document"
  );
  // The wait-for-boot policy itself is covered by the bucket group below; what main.js
  // must not get wrong is WIRING it, and flipping the flag only once opening a window
  // is actually safe.
  check(
    "main.js wires the bucket's readiness gate to combineReady",
    /isReady:\s*\(\)\s*=>\s*combineReady/.test(MAIN),
    "without this a cold-start flush can fire before Tabs.configure()"
  );
  const readyAt = MAIN.indexOf("combineReady = true");
  check("combineReady is set during boot", readyAt > 0);
  check(
    "it is set only AFTER Prefs/Tabs are configured",
    readyAt > MAIN.indexOf("Prefs.configure(") && readyAt > MAIN.indexOf("Tabs.configure("),
    "flipping it earlier defeats the guard entirely"
  );
  check(
    "and BEFORE the launch path can seed the bucket",
    readyAt < launchCombine,
    "otherwise the first batch waits a needless extra window"
  );
}

// The bucket group is async (real timers), so it runs after everything above and
// the summary waits for it.
bucketCases().then(
  () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  },
  (err) => {
    console.log("  FAIL bucket group threw → " + (err && err.stack));
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  }
);

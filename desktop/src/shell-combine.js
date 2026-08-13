"use strict";

// ---------------------------------------------------------------------------
// Explorer "Gộp bằng Nabu PDF" — the pure half.
//
// WHAT THE SHELL ACTUALLY DOES, because the design only makes sense once this is
// stated plainly: a registry verb with a `command` line is invoked ONCE PER
// SELECTED FILE. Select five PDFs and Windows starts five processes, each with a
// single path in `%1`. `MultiSelectModel` does NOT change that — it only decides
// whether the menu item is offered at all:
//
//     verb kind              Document      Player
//     legacy (command line)  15 items      100 items
//     COM (DropTarget)       15 items      no limit
//
// So `Player` is mandatory (without it the item vanishes at 16 files) and 100 is
// a hard ceiling we do not control. Receiving the whole selection in ONE process
// would need an IDropTarget COM server, which an Electron app cannot provide
// without a native helper — deliberately not done.
//
// THE ACCUMULATOR the shell forces on us is already in the app: main.js takes
// `app.requestSingleInstanceLock()`, so processes 2..N hand their argv to the
// first one through `second-instance` and exit. Other apps ship a whole extra
// binary just for this (SingleInstanceAccumulator, Svistunov's singleinstance);
// Nabu gets it free. main.js drips each arriving path into a bucket on a short
// timer and opens ONE dialog when the drip stops.
//
// WHY THIS FILE IS SEPARATE: everything here is a string decision — parse argv,
// dedupe, order, cap. No Electron, no fs, no clock. So it is `require()`-able
// from node and has a grid (`npm run test:combine`), which is the same reason
// page-range.js and planOpen() live where they do. Keep it that way: the moment
// this file touches fs the grid stops being able to run it.
//
// ORDER IS NOT KNOWABLE FROM THE SHELL. `%1` carries no index and the N
// processes arrive in whatever order the OS schedules them, so "the order I
// clicked them in" does not survive the trip. We sort by filename NATURALLY
// (so 2.pdf precedes 10.pdf) and then let the user reorder in the dialog that
// already exists. Merging silently in an arbitrary order would produce a wrong
// document that nobody notices, so it is never done.
// ---------------------------------------------------------------------------

// The flag the verb passes. Long and namespaced on purpose:
//   · it can never collide with an Electron/Chromium switch;
//   · main.js's pdfPathFromArgv() skips any arg starting with "-", so adding it
//     cannot disturb the "Open with" path (which shares the same argv).
const COMBINE_FLAG = "--nabu-combine";

// Where the installer registers the verb, WITHOUT a root key: build/installer.nsh
// writes it under NSIS's SHCTX, which is HKCU for a per-user install and HKLM for
// an elevated per-machine one. Under SystemFileAssociations rather than Nabu's own
// ProgID so the verb shows for every .pdf regardless of which app owns the
// extension — the ask was "right-click some PDFs", not "right-click PDFs that
// already open in Nabu".
//
// Mirrored from the .nsh on purpose: `npm run test:combine` asserts the two agree,
// because a subkey or flag that drifts between them turns the menu item into a
// silent no-op that only a user would ever discover.
const REG_SUBKEY = "Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\NabuCombine";

// Ceiling on one batch. Not a shell limit — a memory one: every file in the
// batch is read and shipped to the renderer as bytes, and a 60-file batch of
// scans is already hundreds of MB. Whatever is dropped is REPORTED, never
// silently trimmed (see planCombineBatch's `dropped`).
const MAX_BATCH = 60;

// Filenames, not paths, and numeric so "2" sorts before "10". Locale pinned to
// "vi" rather than left to the machine: an unpinned collator makes the grid's
// expected order depend on whoever runs it.
const COLLATOR = new Intl.Collator("vi", { numeric: true, sensitivity: "base" });

// The path this process was asked to contribute to a combine batch, or null if
// this argv is not a combine invocation at all.
//
// Returning null for an ordinary "Open with" argv is the load-bearing case: if
// this ever answered for one, double-clicking a single PDF would open the merge
// dialog instead of the document.
function combinePathFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    // `--nabu-combine=C:\x.pdf` — not the form the installer writes, but cheap
    // to honour so a hand-edited registry command still works.
    if (a.startsWith(COMBINE_FLAG + "=")) {
      const v = a.slice(COMBINE_FLAG.length + 1).trim();
      return isPdfPath(v) ? v : null;
    }
    if (a !== COMBINE_FLAG) continue;
    // `--nabu-combine "C:\x.pdf"` — take the first following arg that is not
    // itself a switch, so an injected Chromium switch cannot hide the path.
    for (let j = i + 1; j < argv.length; j++) {
      const v = argv[j];
      if (typeof v !== "string" || v.startsWith("-")) continue;
      return isPdfPath(v) ? v : null;
    }
    return null; // flag present but no path followed it
  }
  return null;
}

function isPdfPath(p) {
  return typeof p === "string" && p.length > 4 && /\.pdf$/i.test(p);
}

// Compare key for "the same file twice". Windows paths are case-insensitive and
// both separators reach us (a hand-typed command, a UNC path, a shortcut), so
// neither may split one file into two list entries.
function dedupeKey(p) {
  return String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function baseName(p) {
  const s = String(p).replace(/\//g, "\\");
  const at = s.lastIndexOf("\\");
  return at < 0 ? s : s.slice(at + 1);
}

// Turn the raw drip of paths into the list the dialog should show.
//
// Callers hand in paths they have ALREADY checked exist and are files — this
// stays free of fs so the grid can run it. Returns:
//   list     deduped, naturally ordered, capped
//   dropped  how many the cap removed (reported to the user, never hidden)
function planCombineBatch(paths, { max = MAX_BATCH } = {}) {
  const seen = new Set();
  const uniq = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!isPdfPath(p)) continue;
    const k = dedupeKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(String(p));
  }
  uniq.sort((a, b) => {
    const byName = COLLATOR.compare(baseName(a), baseName(b));
    // Same filename in two folders: fall back to the full path so the order is
    // total and stable rather than dependent on the sort's implementation.
    return byName !== 0 ? byName : COLLATOR.compare(a, b);
  });
  const cap = Math.max(1, max | 0);
  return { list: uniq.slice(0, cap), dropped: Math.max(0, uniq.length - cap) };
}

// The `command` value the installer writes. Defined here — not only in the .nsh —
// so the grid can assert the two agree; a flag that drifts between them makes the
// menu item launch a plain "Open with" and nobody finds out until a user tries it.
function combineCommand(exePath) {
  if (typeof exePath !== "string" || !exePath) throw new Error("combineCommand: exePath required");
  // A Windows path cannot contain a double quote, so one here means the caller
  // built this string from something untrusted. Refuse rather than emit a
  // command line that would break out of its own quoting.
  if (exePath.includes('"')) throw new Error("combineCommand: exePath must not contain a quote");
  return `"${exePath}" ${COMBINE_FLAG} "%1"`;
}

// How long to wait for the rest of the selection after the last arrival.
//
// Measured against two failures, not picked for looks: too short and a 20-file
// selection opens two dialogs because the shell had not finished launching the
// tail of it; too long and the user stares at nothing after clicking. Explorer
// launches these back-to-back, so arrivals are tens of ms apart — 900 leaves an
// order of magnitude of headroom.
const BUCKET_MS = 900;

// The accumulator. Explorer hands us one path per process, so something has to
// hold them until the drip stops — this is it.
//
// A FACTORY with its side effects injected (`exists`, `resolvePath`, `isReady`,
// `onBatch`) rather than code sitting in main.js, for one reason: main.js needs a
// running Electron, so anything living there has no grid at all. Everything about
// WHEN a batch opens and WHAT is in it is decided here and covered by
// `npm run test:combine`; main.js is left holding only fs and window calls.
//
//   isReady   false while the app is still booting. The tail of a cold-start
//             selection can arrive through second-instance before Tabs/Prefs are
//             configured, and opening a window then would dereference a null
//             `deps`. The timer re-arms instead of dropping the batch.
//   onBatch   (list, dropped) — called at most once per drip, never with an
//             empty list.
function createCombineBucket({
  windowMs = BUCKET_MS,
  max = MAX_BATCH,
  isReady = () => true,
  exists = () => true,
  resolvePath = (p) => p,
  onBatch = () => {},
} = {}) {
  let paths = [];
  let timer = null;

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, windowMs);
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!isReady()) {
      arm(); // still booting — wait another window rather than crash or drop
      return;
    }
    const raw = paths;
    paths = [];
    if (!raw.length) return;
    const { list, dropped } = planCombineBatch(raw, { max });
    if (list.length) onBatch(list, dropped);
  }

  return {
    // Every arrival RESTARTS the window, so the batch closes a fixed time after the
    // LAST file rather than the first — otherwise a slow tail is cut off.
    add(p) {
      let abs;
      try {
        // Resolve before anything else: the same file reached by a relative and an
        // absolute path must not become two rows in the dialog.
        abs = resolvePath(p);
        if (!exists(abs)) return false;
      } catch (_) {
        return false;
      }
      paths.push(abs);
      arm();
      return true;
    },
    flush,
    // Test/diagnostic view only — nothing in the app branches on these.
    get pending() {
      return paths.length;
    },
    get armed() {
      return timer !== null;
    },
  };
}

module.exports = {
  COMBINE_FLAG,
  REG_SUBKEY,
  MAX_BATCH,
  BUCKET_MS,
  createCombineBucket,
  combinePathFromArgv,
  isPdfPath,
  planCombineBatch,
  combineCommand,
};

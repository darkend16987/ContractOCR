"use strict";
/**
 * Nabu PDF — lưới cho vòng đời sidecar (desktop/src/sidecar.js).
 *
 * WHAT THIS GUARDS. A sidecar that dies on its own used to be completely invisible:
 * `child.on("exit")` only wrote to the console, and `sidecarState` in main.js was
 * written exactly once, from startSidecar's promise. So after a crash the badge still
 * read "OCR: sẵn sàng", every engine button stayed enabled, and each click failed with
 * a bare fetch error — with no way back except restarting the app. The ceilings raised
 * in v0.2.55/v0.2.56 (1 GB binary payloads, 3000-page compressions, whole-document
 * span indexes) make an OOM kill a reachable event rather than a theoretical one.
 *
 * TWO HALVES, AND THE SECOND IS THE FRAGILE ONE. Reporting a crash is easy; NOT
 * reporting a deliberate shutdown is where this breaks. `stopSidecar` runs on app
 * quit and on "restart engine", and an old child's exit event arrives asynchronously —
 * after the replacement may already be up. Firing the callback there would paint
 * "Engine đã dừng đột ngột" over a perfectly healthy new sidecar. Hence the `stopping`
 * flag, and hence the second half of this file.
 *
 * WHY IT DRIVES THE REAL SIDECAR. The whole bug lived in the seam between spawn(),
 * the exit event and the stopping flag; stubbing child_process would test a model of
 * that seam rather than the seam. `electron` IS stubbed — sidecar.js wants exactly one
 * field from it (`app.isPackaged`) and the module refuses to load outside Electron.
 *
 * Skips itself (exit 0, loudly) when the dev venv is absent — see SETUP.md.
 *
 * Chạy:  cd desktop ; npm run test:sidecar
 */

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const venvPy =
  process.platform === "win32"
    ? path.join(REPO, ".venv", "Scripts", "python.exe")
    : path.join(REPO, ".venv", "bin", "python");

if (!fs.existsSync(venvPy)) {
  console.log("SKIP sidecar-lifecycle: no dev venv at " + venvPy);
  console.log("     (this grid boots the real Python sidecar — see SETUP.md)");
  process.exit(0);
}

// sidecar.js needs `app.isPackaged`; seed the cache before requiring it.
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: { isPackaged: false } },
};

const { startSidecar, stopSidecar } = require(path.join(__dirname, "..", "src", "sidecar.js"));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// waitForHealth inside sidecar.js allows 180s for a cold model load. A broken
// environment should fail this grid in a minute, not hang a release for three.
function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not come up in ${ms / 1000}s`)), ms)),
  ]);
}

(async () => {
  // ---- 1. dying on its own must be reported ------------------------------
  let fired = null;
  let h1;
  h1 = await withDeadline(
    startSidecar("test-token", (code, handle) => {
      fired = { code, sameHandle: handle === h1 };
    }),
    60000,
    "sidecar #1"
  );

  // Kill it the way the OS does on an OOM — deliberately NOT through stopSidecar.
  process.kill(h1.child.pid);
  await wait(2000);

  check("a crash fires onExit", fired !== null, true);
  check("…identifying the handle that died", fired && fired.sameHandle, true);
  check("…and the handle was never marked stopping", h1.stopping, false);

  // ---- 2. a shutdown WE asked for must stay silent ------------------------
  let fired2 = false;
  const h2 = await withDeadline(
    startSidecar("test-token", () => {
      fired2 = true;
    }),
    60000,
    "sidecar #2"
  );
  check("a fresh handle starts not-stopping", h2.stopping, false);

  stopSidecar(h2);
  check("stopSidecar marks the handle first", h2.stopping, true);
  await wait(3000);
  check("…so a deliberate stop reports nothing", fired2, false);

  // stopSidecar must survive being handed nothing (app quit before boot finished).
  let threw = false;
  try {
    stopSidecar(null);
    stopSidecar(undefined);
  } catch (_) {
    threw = true;
  }
  check("stopSidecar tolerates a missing handle", threw, false);

  console.log(`\nsidecar-lifecycle: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.log(`\nsidecar-lifecycle: ERROR ${err && err.message}`);
  process.exit(1);
});

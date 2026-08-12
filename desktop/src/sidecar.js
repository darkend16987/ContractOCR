"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");
const { app } = require("electron");

// Find a free TCP port on localhost so two instances never collide.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Resolve how to launch the sidecar: frozen binary in production, python in dev.
function sidecarCommand(port) {
  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "sidecar.exe" : "sidecar";
    const bin = path.join(process.resourcesPath, "sidecar", exe);
    return { command: bin, args: ["--port", String(port)], cwd: path.dirname(bin) };
  }
  // Dev: run the Python entry from the repo root (one level above desktop/).
  // Prefer the project venv (.venv, Python 3.12) over whatever `python` is on PATH —
  // the OCR deps are installed there, and the global python may be an incompatible version.
  const repoRoot = path.join(__dirname, "..", "..");
  const venvPy =
    process.platform === "win32"
      ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
      : path.join(repoRoot, ".venv", "bin", "python");
  const py = fs.existsSync(venvPy)
    ? venvPy
    : process.platform === "win32"
    ? "python"
    : "python3";
  return {
    command: py,
    args: [path.join(repoRoot, "sidecar.py"), "--port", String(port)],
    cwd: repoRoot,
  };
}

// Poll GET /health until the FastAPI app is up (models loaded) or we time out.
function waitForHealth(port, timeoutMs = 180000, intervalMs = 600) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("Sidecar không phản hồi /health trong thời gian chờ (model có thể chưa tải xong)."));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 3000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        }
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    tick();
  });
}

// `onExit(code, handle)` fires when the sidecar dies on its OWN — not when we killed
// it. Without it a crash is completely invisible: the process is gone, but
// `sidecarState` in main.js was only ever written from this function's promise, so it
// stays "ready", every engine button stays enabled, and each click fails with a bare
// fetch error. The only cure the user has is restarting the app, and nothing on
// screen suggests that. A big compress or a several-hundred-page index is exactly the
// kind of job that can end in an OOM kill, so this path is reachable.
async function startSidecar(token, onExit) {
  const port = await findFreePort();
  const { command, args, cwd } = sidecarCommand(port);

  // Pass the per-launch token via env so the sidecar can reject any request that
  // doesn't carry it (other local processes / browser pages on 127.0.0.1).
  const env = { ...process.env };
  if (token) env.SIDECAR_TOKEN = token;

  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  // The handle is built BEFORE the exit listener so `stopping` — set by stopSidecar —
  // is readable from inside it. A deliberate shutdown (app quit, "restart engine")
  // must not report itself as a crash, least of all on top of a replacement sidecar
  // that is already up.
  const handle = { child, port, stopping: false };
  child.stdout.on("data", (d) => process.stdout.write(`[sidecar] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
  child.on("exit", (code) => {
    console.log(`[sidecar] exited with code ${code}`);
    if (!handle.stopping && typeof onExit === "function") onExit(code, handle);
  });

  await waitForHealth(port);
  return handle;
}

function stopSidecar(sidecar) {
  if (sidecar) sidecar.stopping = true; // this exit is ours; don't report it as a crash
  const child = sidecar && sidecar.child;
  if (!child || child.killed) return;
  // On Windows a plain SIGTERM to the launcher can orphan the real server
  // process (PyInstaller onedir spawns a child) → a stray sidecar.exe keeps the
  // resources/sidecar files locked (EBUSY on the next rebuild). taskkill /T kills
  // the whole process tree. Elsewhere SIGTERM is enough.
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      /* fall through to kill() */
    }
  }
  child.kill();
}

module.exports = { startSidecar, stopSidecar };

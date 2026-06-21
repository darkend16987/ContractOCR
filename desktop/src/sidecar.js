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

async function startSidecar(token) {
  const port = await findFreePort();
  const { command, args, cwd } = sidecarCommand(port);

  // Pass the per-launch token via env so the sidecar can reject any request that
  // doesn't carry it (other local processes / browser pages on 127.0.0.1).
  const env = { ...process.env };
  if (token) env.SIDECAR_TOKEN = token;

  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[sidecar] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
  child.on("exit", (code) => console.log(`[sidecar] exited with code ${code}`));

  await waitForHealth(port);
  return { child, port };
}

function stopSidecar(sidecar) {
  if (sidecar && sidecar.child && !sidecar.child.killed) {
    sidecar.child.kill();
  }
}

module.exports = { startSidecar, stopSidecar };

"""Single entry point for the project's test suite.

The venv has no pytest, so tests are plain scripts that run their own checks
under `if __name__ == "__main__"` and exit non-zero on failure (same style as
test_export.py). This runner discovers every ``test_*.py`` at the repo root and
runs each in its own subprocess — isolating side effects (files written under
results/, module-level state) and matching exactly how /deploy invokes them.

Usage:
    .venv\\Scripts\\python run_tests.py            # run all
    .venv\\Scripts\\python run_tests.py test_split  # run a subset (substring match)

Exit code is 0 only if every selected test file exits 0.
"""

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _discover(selectors: list[str]) -> list[Path]:
    files = sorted(p for p in ROOT.glob("test_*.py") if p.is_file())
    if selectors:
        files = [p for p in files if any(s in p.name for s in selectors)]
    return files


def main() -> int:
    selectors = sys.argv[1:]
    files = _discover(selectors)
    if not files:
        print("No test files matched.", file=sys.stderr)
        return 1

    results: list[tuple[str, bool, float]] = []
    for path in files:
        print(f"\n{'=' * 60}\nRUN {path.name}\n{'=' * 60}", flush=True)
        start = time.perf_counter()
        proc = subprocess.run(
            [sys.executable, str(path)],
            cwd=str(ROOT),
        )
        elapsed = time.perf_counter() - start
        ok = proc.returncode == 0
        results.append((path.name, ok, elapsed))

    print(f"\n{'=' * 60}\nSUMMARY\n{'=' * 60}")
    passed = 0
    for name, ok, elapsed in results:
        tag = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        print(f"  {tag}  {name}  ({elapsed:.1f}s)")
    total = len(results)
    print(f"\n{passed}/{total} test files passed.")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())

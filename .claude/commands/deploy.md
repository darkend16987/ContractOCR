---
description: Release pipeline for Nabu PDF desktop — test, sidecar freshness, rebuild, README check, commit/push, publish a new GitHub release and remove the previous one. Optional arg = new version (e.g. /deploy 0.2.13); omit to bump patch.
---

# /deploy — Nabu PDF release pipeline

Run the full release for the Electron desktop app **carefully and in order**. Stop
and report at the first failure — never push or publish on top of a broken step.
All paths are repo-root relative. Shell is PowerShell on Windows; the Bash tool is
also available for POSIX one-liners.

Arg `$ARGUMENTS` = the target version (e.g. `0.2.13`). If empty, bump the **patch**
of the current `desktop/package.json` version.

> Destructive/outward-facing steps (push, `gh release create`, `gh release delete`).
> The user invoking `/deploy` is the authorization to perform them. Still: show the
> plan (new version, what will be deleted) and the test result before the push, and
> abort if anything earlier failed.

## 0. Pre-flight

1. Read current version from [desktop/package.json](desktop/package.json). Compute
   the new version from `$ARGUMENTS` or patch-bump.
2. `git status --porcelain` — note the working tree. Confirm the new version is
   **greater** than every published tag (`gh release list`); OTA only upgrades when
   `version` is higher.
3. Confirm `gh auth status` is logged in. Capture a token for electron-builder:
   in PowerShell `$env:GH_TOKEN = (gh auth token)`.

## 1. Tests

- Run the Python tests (expect the closing line of each, no traceback):
  - `.venv\Scripts\python test_export.py` → `Test complete...`
  - `.venv\Scripts\python test_compare_drawings.py` → `All drawing-compare tests passed.`
  - `.venv\Scripts\python test_translate_layout.py` → `All translate-layout tests passed.`
- Quick static check of the renderer (no test runner there):
  `node --check desktop/renderer/app.js`, `editor.js`, `text-edit.js`.
- **Any failure → stop and report.** Do not continue.

## 2. Sidecar freshness

The bundled Python sidecar (`dist/sidecar/`) must match the source, or OTA ships a
stale binary (see [memory] sidecar-stale-build-guard).

- If `dist/sidecar/sidecar.exe` or `dist/sidecar/SIDECAR_BUILD.json` is missing → rebuild.
- Else compare: any tracked `*.py` / `sidecar.spec` changed since the marker commit,
  OR any uncommitted `*.py` / `sidecar.spec` edits → rebuild.
  (This is exactly what [desktop/scripts/check-sidecar-fresh.js](desktop/scripts/check-sidecar-fresh.js)
  enforces during `prebuild`; you can dry-run that logic with `git diff --name-only <marker-commit> HEAD -- "*.py" sidecar.spec` and `git status --porcelain -- "*.py" sidecar.spec`.)
- **Rebuild** (only if needed): `cd desktop ; npm run build:sidecar`
  (runs PyInstaller via `.venv` then re-stamps the marker). This is slow (minutes).
- If the rebuild produced a new `dist/sidecar`, that folder is gitignored — nothing
  to commit there, but the marker now points at the **current** HEAD, so commit your
  source first if the marker would otherwise lag. Re-run the freshness logic until clean.

## 3. Version bump

- Set `"version"` in [desktop/package.json](desktop/package.json) to the new version.

## 4. README / docs check

- Skim [README.md](README.md), [HANDOFF.md](HANDOFF.md), [ROADMAP.md](ROADMAP.md),
  [HUONG-DAN-SU-DUNG.md](HUONG-DAN-SU-DUNG.md) for anything the release changes
  (new features, version strings, feature lists).
- Add a short dated `vX.Y.Z` note at the top of HANDOFF.md describing what shipped.
- Update README feature bullets if user-facing features were added.
- Keep edits minimal and accurate — do not invent changes.

## 5. Commit & push

- Stage the real changes (renderer/src/docs/package.json). Do **not** commit
  `dist/`, `dist-app/`, `node_modules/`.
- Commit message: Conventional Commits, end with the Co-Authored-By trailer.
  Example subject: `release: vX.Y.Z — <one-line summary>`.
- Push the current branch: `git push`.
- (After the commit, re-confirm sidecar freshness logic passes against the new HEAD.)

## 6. Build the installer

- `cd desktop ; npm run build`  (runs the `prebuild` sidecar check, then
  electron-builder → `desktop/dist-app/`). Produces:
  - `NabuPDF-<ver>-x64.exe` + `.blockmap` (NSIS, self-updating)
  - `NabuPDF-<ver>-portable.exe`
  - `latest.yml` (electron-updater manifest — **required** for OTA)
- `npm run checksums`  → `desktop/dist-app/SHA256SUMS.txt`.
- Verify all expected files exist before releasing.

## 7. Publish the new release, delete the old one

1. Create the release with all OTA assets attached:
   ```
   gh release create v<ver> \
     --title "Nabu PDF v<ver> — <summary>" \
     --notes "<changelog>" \
     desktop/dist-app/NabuPDF-<ver>-x64.exe \
     desktop/dist-app/NabuPDF-<ver>-x64.exe.blockmap \
     desktop/dist-app/NabuPDF-<ver>-portable.exe \
     desktop/dist-app/latest.yml \
     desktop/dist-app/SHA256SUMS.txt
   ```
   `latest.yml` + the NSIS `.exe` + `.blockmap` **must** be present or OTA breaks.
2. Delete the **previous** release (the version that was Latest before this run):
   `gh release delete v<prev> --yes`. Leave its git tag unless the user asked to
   remove it (`--cleanup-tag` also deletes the tag). Only delete the single prior
   release by default — do not wipe older history unless asked.
3. Confirm: `gh release list` shows v<ver> as Latest with the 5 assets.

## 8. Report

Summarize: version shipped, test result, whether the sidecar was rebuilt, files
attached, which release was deleted, and the release URL.

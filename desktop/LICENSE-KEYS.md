# License keys (offline Ed25519)

Nabu PDF verifies license keys **offline** with an Ed25519 signature — no server.
The app ships the public key; you keep the private key. Keys can be **floating**
(any machine) or **machine-bound** (HWID). One CLI handles everything and keeps a
ledger so you never copy keys into a doc by hand.

## One-time setup

```bash
cd desktop
npm run license -- keygen
```

- `src/license-public-key.pem` — **commit it**. Bundled in the app (verify only).
- `scripts/.keys/license-private-key.pem` — **secret, git-ignored**. Back it up.
  Anyone with it can mint valid keys. Rotating (`keygen --force`) invalidates
  every key already issued.

## Day-to-day (issue + manage)

```bash
# Issue a FLOATING key (runs on any machine) — signs + records in ledger, prints key:
npm run license -- issue --name "Nguyen Van A" --email a@x.com --plan pro --days 365 --note "mua qua FB"
#   --days 0 (or omit) = perpetual.

# Issue a MACHINE-BOUND key — only runs on that one device:
npm run license -- issue --name "Nguyen Van A" --email a@x.com --plan pro --hwid 3f9a1c2b7e4d8a06
#   Get the HWID from the customer: app → ⚙ Cài đặt → Bản quyền → "Mã máy (HWID)" → Copy.

npm run license -- list                 # active licenses (table; MACHINE column shows floating/HWID)
npm run license -- list --all           # include revoked/expired
npm run license -- show a@x.com         # find a customer's key(s) by email/name
npm run license -- reissue NB-0001      # re-print an existing key
npm run license -- revoke NB-0001       # mark revoked in the ledger (see note)
npm run license -- export licenses.csv  # dump the whole ledger to CSV
```

Send the printed `NABU1.…` string to the customer. They paste it in
**⚙ Cài đặt → Bản quyền → Kích hoạt**. It is stored per-user at
`%LOCALAPPDATA%/Nabu PDF/license.json`.

The ledger lives at `scripts/.keys/licenses.json` (git-ignored — it holds customer
PII + keys). Back it up alongside the private key.

## HWID binding (machine lock)

- A key with an `hwid` claim validates **only** on the machine whose id matches.
  HWID = sha256 of Windows `MachineGuid`, truncated to 16 hex chars (raw GUID never
  leaves the device). Changes only on OS reinstall / new machine.
- Floating key (no `--hwid`) still works everywhere — use for trials or convenience.
- **Drift:** customer reinstalls Windows or swaps PC → HWID changes → key shows
  "Sai máy". Fix: `reissue` won't help (same payload); issue a **new** key with the
  new `--hwid`. Treat as light support cost.
- **Honest limit:** binding is still client-side — a determined cracker can patch the
  HWID check out. It stops casual key-sharing, not piracy. Real anti-share (revoke +
  seat caps) needs online activation → see ROADMAP "Phase L.3 (hybrid)".

## Limits & when to graduate

- **Revocation is bookkeeping only.** Offline keys (floating or HWID-bound) can't be
  killed on a customer's machine. `revoke` just flags the ledger. Granular revocation,
  per-seat limits, or subscriptions need **online activation** (a small license server)
  — the key payload already carries `id`/`plan`/`exp`/`hwid` to build on. See ROADMAP
  Phase L.3 for the planned hybrid (activate online once → offline token).
- **Selling at volume?** Keep this CLI as the source of truth, but automate
  delivery: a storefront (Lemon Squeezy / Gumroad / Paddle) handles payment, and a
  tiny webhook (Cloudflare Worker / Vercel function holding the private key) runs
  the same signing logic to email the buyer a key on purchase. That preserves
  offline verification while removing manual issuing.

## Enforcement

**OFF since v0.2.0** (`ENFORCE = false` in `src/license.js`). The app is now fully
free and open-source (AGPL-3.0): no serial key, no machine control, every feature
unlocked. `enforce:false` propagates to the renderer, which unlocks all gated
buttons and hides the activation UI (`#lic-section`). The activation/license-server
code below is retained but dormant — re-enable only if a paid/closed edition is
reintroduced (which AGPL would then constrain; see repo-root LICENSE).

When it was ON (`ENFORCE = true`), 8 pro features were locked until a valid key was
activated: bóc tách AI, sửa chữ, chỉnh sửa, ghép, chèn, tách, searchable, nén.
Free: open/save/rotate/delete/zoom/undo/redo + Settings.

Status shape from `await window.desktop.license.get()`:
`{ state: "licensed" | "unlicensed" | "expired" | "invalid" | "machine", reason?, enforce }`
(`"machine"` = key bound to a different HWID). The renderer blocks gated actions on
three paths — button click (document capture guard), native menu, and drag-drop — and
shows a 🔒 badge on locked buttons. To disable enforcement, set `ENFORCE = false`.

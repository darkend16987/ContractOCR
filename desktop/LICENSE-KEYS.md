# License keys (offline Ed25519)

Nabu PDF verifies license keys **offline** with an Ed25519 signature — no server,
no machine/MAC/IP binding. The app ships the public key; you keep the private key.

## One-time setup

```bash
cd desktop
npm run license:keygen
```

- `src/license-public-key.pem` — **commit it**. Bundled in the app (verify only).
- `scripts/.keys/license-private-key.pem` — **secret, git-ignored**. Back it up.
  Anyone with this file can mint valid keys. Losing it means you can't issue more
  keys for this public key; rotating (`--force`) invalidates every issued key.

## Issuing a key to a customer

```bash
npm run license:sign -- --name "Nguyen Van A" --email a@example.com --plan pro --days 365
# --days 0 (or omit) = perpetual. Prints:  NABU1.<payload>.<signature>
```

Send that string to the customer. They paste it in **⚙ Cài đặt → Bản quyền → Kích hoạt**.
It is stored at `%LOCALAPPDATA%/Nabu PDF/license.json` (per-user).

## Enforcement

The crypto mechanism is always live, but feature-gating is **off by default**
(`ENFORCE = false` in `src/license.js`) so current free usage is unchanged. To
lock pro features:

1. Set `ENFORCE = true` in `src/license.js`.
2. In the renderer, gate features on `await window.desktop.license.get()` →
   `{ state: "licensed" | "unlicensed" | "expired" | "invalid", enforce }`.

Keys are portable by design (a customer can activate on multiple machines). If you
later need per-seat limits, add an online activation step — the key format already
carries `plan`/`exp` and can be extended.

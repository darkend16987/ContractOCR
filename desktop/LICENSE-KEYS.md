# License keys (offline Ed25519)

Nabu PDF verifies license keys **offline** with an Ed25519 signature — no server,
no machine/MAC/IP binding. The app ships the public key; you keep the private key.
One CLI handles everything and keeps a ledger so you never copy keys into a doc by
hand.

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
# Issue a key — signs it AND records it in the ledger, then prints the key:
npm run license -- issue --name "Nguyen Van A" --email a@x.com --plan pro --days 365 --note "mua qua FB"
#   --days 0 (or omit) = perpetual.

npm run license -- list                 # active licenses (table)
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

## Limits & when to graduate

- **Revocation is bookkeeping only.** Offline keys can't be killed on a customer's
  machine. `revoke` just flags the ledger. Granular revocation, per-seat limits, or
  subscriptions need **online activation** (a small license server) — the key
  payload already carries `id`/`plan`/`exp` to build on.
- **Selling at volume?** Keep this CLI as the source of truth, but automate
  delivery: a storefront (Lemon Squeezy / Gumroad / Paddle) handles payment, and a
  tiny webhook (Cloudflare Worker / Vercel function holding the private key) runs
  the same signing logic to email the buyer a key on purchase. That preserves
  offline verification while removing manual issuing.

## Enforcement

The crypto mechanism is always live, but feature-gating is **off by default**
(`ENFORCE = false` in `src/license.js`). To lock pro features: set `ENFORCE = true`
and gate on `await window.desktop.license.get()` →
`{ state: "licensed" | "unlicensed" | "expired" | "invalid", enforce }`.

# Nabu PDF — License Server (Supabase)

Online-activation hybrid (ROADMAP Phase L.3). Verification stays offline in the
app; the server adds what local crypto can't: **seat caps, remote revoke /
deactivate, central expiry**. Project ref: `gaqwijsudxpfydruozmd`.

## Layout

```
supabase/
  config.toml                 # project ref + per-function verify_jwt
  migrations/0001_license_core.sql
  functions/
    _shared/crypto.ts         # Ed25519 sign/verify (NABU1 keys, NABT1 tokens)
    _shared/http.ts           # CORS + json helpers
    activate/index.ts         # POST: key+hwid → seat check → 7-day token
    refresh/index.ts          # POST: token → re-check status → new token
    admin/index.ts            # POST: superadmin mutations (JWT + allowlist)
```

## Two keys (don't confuse)

- **License key** `NABU1.…` — given to the customer, recorded in `licenses`.
- **Activation token** `NABT1.…` — short-lived (7d), bound to one machine,
  verified offline by the app. Both signed by the **same** Ed25519 private key,
  whose public half ships in the desktop app (`desktop/src/license-public-key.pem`).

## Secrets

Supabase auto-injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
You only set the signing keys (the SAME pair the desktop CLI uses, so tokens
verify against the app's bundled public key):

```bash
supabase secrets set LICENSE_PRIVATE_KEY="$(cat desktop/scripts/.keys/license-private-key.pem)"
supabase secrets set LICENSE_PUBLIC_KEY="$(cat desktop/src/license-public-key.pem)"
```

> `LICENSE_PRIVATE_KEY` is the crown jewel — only ever lives as a Supabase secret
> and in your local `.keys/` (git-ignored). Never commit it, never ship it.

## Deploy (CLI)

```bash
# from repo root
supabase login
supabase link --project-ref gaqwijsudxpfydruozmd
supabase db push                       # apply migrations/0001_license_core.sql
supabase secrets set LICENSE_PRIVATE_KEY="$(cat desktop/scripts/.keys/license-private-key.pem)"
supabase secrets set LICENSE_PUBLIC_KEY="$(cat desktop/src/license-public-key.pem)"
supabase functions deploy activate
supabase functions deploy refresh
supabase functions deploy admin
```

(Or, since the repo is linked to Supabase, pushing these files can auto-deploy via
the GitHub integration — verify in the dashboard either way.)

## Wire the clients (after deploy)

Grab the project's **anon public key** (Dashboard → Settings → API) and paste it in:

1. `desktop/src/license.js` → `SERVER.anon` (enables online activation in the app).
2. `admin/config.js` → `SUPABASE_ANON_KEY` (enables the admin dashboard).

Both are public keys — safe to commit/ship.

## Endpoints

| Function | Auth | Body | Returns |
|----------|------|------|---------|
| `activate` | anon | `{key,hwid,machine_name,app_version}` | `{ok,token,…}` or `{ok:false,reason}` |
| `refresh`  | anon | `{token}` | `{ok,token}` or `{ok:false,reason}` |
| `admin`    | user JWT (admin allowlist) | `{action,…}` | per-action |

`admin` actions: `issue`, `set_status`, `set_seats`, `set_expiry`, `set_assigned`,
`deactivate_machine`, `reactivate_machine`, `add_admin`, `remove_admin`.

## Data model

- `licenses` — key_id, key, name, email, plan, **max_seats**, assigned_to, status
  (active/revoked/suspended), expires_at, note, created_by.
- `activations` — license_id, **hwid**, machine_name, app_version, status
  (active/deactivated), last_seen, token_exp. Unique (license_id, hwid).
- `audit_log` — every mutation. `admins` — superadmin email allowlist.
- View `license_overview` adds `active_seats` / `free_seats`.

## Revoke / deactivate semantics

Changing a row to `revoked`/`suspended`, or an activation to `deactivated`, makes
`/refresh` fail. The app loses access when its current token expires — at most the
token TTL (**7 days**). Shorten TTL in `activate`/`refresh` for faster propagation
at the cost of more frequent phone-home.

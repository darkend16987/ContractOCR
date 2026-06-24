// POST /refresh  { token }
//
// Re-checks license + activation status and re-issues a fresh activation token.
// This is where remote revoke / deactivate / suspend take effect: if the DB row
// is no longer active, refresh fails and the app loses access once the current
// token expires (at most TTL_DAYS later). Public endpoint (no JWT).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { signToken, verifyToken } from "../_shared/crypto.ts";
import { json, preflight } from "../_shared/http.ts";

const TTL_DAYS = 7;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, reason: "bad_json" }, 400);
  }
  const token = String(b.token || "").trim();
  if (!token) return json({ ok: false, reason: "missing" }, 400);

  // Verify signature only — an expired token may still refresh within grace.
  const p = await verifyToken(token);
  if (!p) return json({ ok: false, reason: "signature" });
  const lid = String(p.lid || "");
  const hwid = String(p.hwid || "");
  if (!lid || !hwid) return json({ ok: false, reason: "malformed" });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: lic } = await sb.from("licenses").select("*").eq("id", lid).maybeSingle();
  if (!lic) return json({ ok: false, reason: "unknown" });
  if (lic.status !== "active") return json({ ok: false, reason: lic.status });
  if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
    return json({ ok: false, reason: "expired" });
  }

  const { data: act } = await sb
    .from("activations")
    .select("*")
    .eq("license_id", lid)
    .eq("hwid", hwid)
    .maybeSingle();
  if (!act) return json({ ok: false, reason: "no_activation" });
  if (act.status !== "active") return json({ ok: false, reason: "deactivated" });

  const now = Math.floor(Date.now() / 1000);
  const tokenExp = now + TTL_DAYS * 86400;
  const fresh = await signToken({
    v: 1,
    kid: lic.key_id,
    lid: lic.id,
    hwid,
    name: lic.name,
    email: lic.email,
    plan: lic.plan,
    lic_exp: lic.expires_at ? Math.floor(new Date(lic.expires_at).getTime() / 1000) : 0,
    iat: now,
    exp: tokenExp,
  });

  await sb
    .from("activations")
    .update({ last_seen: new Date().toISOString(), token_exp: new Date(tokenExp * 1000).toISOString() })
    .eq("id", act.id);

  return json({ ok: true, token: fresh, lic_exp: lic.expires_at, token_exp: new Date(tokenExp * 1000).toISOString() });
});

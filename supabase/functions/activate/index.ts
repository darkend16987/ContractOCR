// POST /activate  { key, hwid, machine_name?, app_version? }
//
// Validates a license key, enforces the per-key seat cap, records the machine,
// and returns a short-lived offline activation token the app verifies locally.
// Public endpoint (no JWT) — called by the desktop app with the anon key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { signToken, verifyLicenseKey } from "../_shared/crypto.ts";
import { json, preflight } from "../_shared/http.ts";

const TTL_DAYS = 7; // token lifetime = max revoke/deactivate lag

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
  const key = String(b.key || "").trim();
  const hwid = String(b.hwid || "").trim();
  const machine = String(b.machine_name || "").slice(0, 120);
  const ver = String(b.app_version || "").slice(0, 40);
  if (!key || !hwid) return json({ ok: false, reason: "missing" }, 400);

  // Signature check (defense in depth; the DB row is the source of truth).
  const payload = await verifyLicenseKey(key);
  if (!payload) return json({ ok: false, reason: "signature" });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: lic } = await sb.from("licenses").select("*").eq("key", key).maybeSingle();
  if (!lic) return json({ ok: false, reason: "unknown" });
  if (lic.status !== "active") return json({ ok: false, reason: lic.status }); // revoked | suspended
  if (lic.expires_at && new Date(lic.expires_at) < new Date()) {
    return json({ ok: false, reason: "expired" });
  }

  // Existing activation for this exact machine?
  const { data: existing } = await sb
    .from("activations")
    .select("*")
    .eq("license_id", lic.id)
    .eq("hwid", hwid)
    .maybeSingle();

  let activation = existing;
  if (existing) {
    if (existing.status === "deactivated") return json({ ok: false, reason: "deactivated" });
  } else {
    // New machine — enforce the seat cap.
    const { count } = await sb
      .from("activations")
      .select("*", { count: "exact", head: true })
      .eq("license_id", lic.id)
      .eq("status", "active");
    if ((count || 0) >= lic.max_seats) {
      return json({ ok: false, reason: "seat_limit", max_seats: lic.max_seats });
    }
    const { data: created, error } = await sb
      .from("activations")
      .insert({ license_id: lic.id, hwid, machine_name: machine, app_version: ver })
      .select()
      .single();
    if (error || !created) return json({ ok: false, reason: "store" });
    activation = created;
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenExp = now + TTL_DAYS * 86400;
  const token = await signToken({
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
    .update({
      last_seen: new Date().toISOString(),
      token_exp: new Date(tokenExp * 1000).toISOString(),
      machine_name: machine || activation!.machine_name,
      app_version: ver || activation!.app_version,
      status: "active",
    })
    .eq("id", activation!.id);

  await sb.from("audit_log").insert({
    actor: "system",
    action: existing ? "reactivate" : "activate",
    license_id: lic.id,
    activation_id: activation!.id,
    detail: { hwid, machine, ver },
  });

  return json({
    ok: true,
    token,
    plan: lic.plan,
    name: lic.name,
    lic_exp: lic.expires_at,
    token_exp: new Date(tokenExp * 1000).toISOString(),
  });
});

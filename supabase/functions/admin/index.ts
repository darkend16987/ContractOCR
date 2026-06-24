// POST /admin  { action, ... }   (Authorization: Bearer <supabase user JWT>)
//
// Superadmin mutations. Reads are done directly by the admin web app via RLS
// (is_admin()); this function handles writes — especially `issue`, which needs
// the private signing key and must never run in a browser.
//
// Auth: the caller's Supabase Auth JWT is resolved to an email, which must be in
// the `admins` allowlist. All actions are recorded in audit_log.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { signLicenseKey } from "../_shared/crypto.ts";
import { json, preflight } from "../_shared/http.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

function svc() {
  return createClient(URL, SERVICE);
}

async function callerEmail(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const user = createClient(URL, ANON, { global: { headers: { Authorization: auth } } });
  const { data, error } = await user.auth.getUser();
  if (error || !data.user?.email) return null;
  return data.user.email;
}

async function nextKeyId(sb: ReturnType<typeof svc>): Promise<string> {
  // Highest existing NB-#### + 1. Low volume; unique constraint guards races.
  const { data } = await sb.from("licenses").select("key_id").order("key_id", { ascending: false }).limit(1);
  let n = 0;
  if (data && data[0]) {
    const m = String(data[0].key_id).match(/(\d+)\s*$/);
    if (m) n = parseInt(m[1], 10);
  }
  return "NB-" + String(n + 1).padStart(4, "0");
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json({ ok: false, reason: "method" }, 405);

  const email = await callerEmail(req);
  if (!email) return json({ ok: false, reason: "unauthenticated" }, 401);

  const sb = svc();
  const { data: adminRow } = await sb.from("admins").select("email").eq("email", email).maybeSingle();
  if (!adminRow) return json({ ok: false, reason: "forbidden" }, 403);

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return json({ ok: false, reason: "bad_json" }, 400);
  }
  const action = String(b.action || "");
  const audit = (action: string, license_id: unknown, detail: unknown) =>
    sb.from("audit_log").insert({ actor: email, action, license_id: license_id ?? null, detail: detail ?? {} });

  switch (action) {
    case "issue": {
      const name = String(b.name || "").slice(0, 120);
      const cemail = String(b.email || "").slice(0, 160);
      const plan = String(b.plan || "pro").slice(0, 40);
      const maxSeats = Math.max(1, parseInt(String(b.max_seats ?? "1"), 10) || 1);
      const days = parseInt(String(b.days ?? "0"), 10) || 0;
      const assigned = String(b.assigned_to || "").slice(0, 160);
      const note = String(b.note || "").slice(0, 500);
      const now = Math.floor(Date.now() / 1000);
      const exp = days > 0 ? now + days * 86400 : 0;

      const keyId = await nextKeyId(sb);
      const payload: Record<string, unknown> = { v: 1, id: keyId, name, email: cemail, plan, iat: now, exp };
      const key = await signLicenseKey(payload);

      const { data: lic, error } = await sb
        .from("licenses")
        .insert({
          key_id: keyId,
          key,
          name,
          email: cemail,
          plan,
          max_seats: maxSeats,
          assigned_to: assigned,
          expires_at: exp ? new Date(exp * 1000).toISOString() : null,
          note,
          created_by: email,
        })
        .select()
        .single();
      if (error || !lic) return json({ ok: false, reason: "store", error: error?.message });
      await audit("issue", lic.id, { key_id: keyId, max_seats: maxSeats, days });
      return json({ ok: true, license: lic, key });
    }

    case "set_status": {
      // status: active | revoked | suspended
      const id = String(b.license_id || "");
      const status = String(b.status || "");
      if (!["active", "revoked", "suspended"].includes(status)) return json({ ok: false, reason: "bad_status" }, 400);
      const { error } = await sb.from("licenses").update({ status }).eq("id", id);
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("set_status", id, { status });
      return json({ ok: true });
    }

    case "set_seats": {
      const id = String(b.license_id || "");
      const maxSeats = Math.max(1, parseInt(String(b.max_seats ?? "1"), 10) || 1);
      const { error } = await sb.from("licenses").update({ max_seats: maxSeats }).eq("id", id);
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("set_seats", id, { max_seats: maxSeats });
      return json({ ok: true });
    }

    case "set_expiry": {
      const id = String(b.license_id || "");
      const days = parseInt(String(b.days ?? "0"), 10) || 0; // 0 = perpetual
      const exp = days > 0 ? new Date(Date.now() + days * 86400 * 1000).toISOString() : null;
      const { error } = await sb.from("licenses").update({ expires_at: exp }).eq("id", id);
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("set_expiry", id, { days });
      return json({ ok: true });
    }

    case "set_assigned": {
      const id = String(b.license_id || "");
      const assigned = String(b.assigned_to || "").slice(0, 160);
      const { error } = await sb.from("licenses").update({ assigned_to: assigned }).eq("id", id);
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("set_assigned", id, { assigned_to: assigned });
      return json({ ok: true });
    }

    case "deactivate_machine": {
      // Free a seat / remote-kill one machine. Takes effect at next refresh.
      const activationId = String(b.activation_id || "");
      const { data: act, error } = await sb
        .from("activations")
        .update({ status: "deactivated" })
        .eq("id", activationId)
        .select()
        .maybeSingle();
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("deactivate_machine", act?.license_id, { activation_id: activationId });
      return json({ ok: true });
    }

    case "reactivate_machine": {
      const activationId = String(b.activation_id || "");
      const { data: act, error } = await sb
        .from("activations")
        .update({ status: "active" })
        .eq("id", activationId)
        .select()
        .maybeSingle();
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("reactivate_machine", act?.license_id, { activation_id: activationId });
      return json({ ok: true });
    }

    case "add_admin": {
      const newEmail = String(b.email || "").trim().toLowerCase();
      if (!newEmail) return json({ ok: false, reason: "missing" }, 400);
      const { error } = await sb.from("admins").upsert({ email: newEmail });
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("add_admin", null, { email: newEmail });
      return json({ ok: true });
    }

    case "remove_admin": {
      const target = String(b.email || "").trim().toLowerCase();
      if (target === email) return json({ ok: false, reason: "cannot_remove_self" }, 400);
      const { error } = await sb.from("admins").delete().eq("email", target);
      if (error) return json({ ok: false, reason: "store", error: error.message });
      await audit("remove_admin", null, { email: target });
      return json({ ok: true });
    }

    default:
      return json({ ok: false, reason: "unknown_action" }, 400);
  }
});

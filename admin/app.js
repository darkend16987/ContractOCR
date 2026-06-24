"use strict";
/* Nabu PDF — license admin dashboard (vanilla + supabase-js). Reads go straight
   to Postgres via RLS (is_admin()); writes route through the `admin` Edge
   Function (which holds the signing key + writes the audit log). */

const CFG = window.NABU_CFG;
const $ = (id) => document.getElementById(id);
let sb = null;
let ME = null;

function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + (kind || "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3500);
}

function fmtDate(s) {
  if (!s) return "—";
  return new Date(s).toLocaleString("vi-VN");
}
function fmtExpiry(s) {
  return s ? new Date(s).toLocaleDateString("vi-VN") : "vĩnh viễn";
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- admin Edge Function (signed mutations) ---------------------------------
async function adminCall(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { ok: false, reason: "no_session" };
  const res = await fetch(`${CFG.SUPABASE_URL}/functions/v1/admin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CFG.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { ok: false, reason: "bad_response" };
  }
}

// --- auth -------------------------------------------------------------------
async function sendMagicLink() {
  const email = $("login-email").value.trim();
  if (!email) return;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  $("login-msg").textContent = error
    ? "Lỗi: " + error.message
    : "Đã gửi link đăng nhập tới " + email + ". Mở email và bấm vào link.";
}

async function isAdmin() {
  const { data } = await sb.from("admins").select("email").eq("email", ME).maybeSingle();
  return !!data;
}

async function onSession(session) {
  if (!session) {
    $("login").hidden = false;
    $("topbar").hidden = $("app").hidden = true;
    return;
  }
  ME = session.user.email;
  if (!(await isAdmin())) {
    $("login").hidden = false;
    $("login-msg").textContent = `Tài khoản ${ME} chưa được cấp quyền admin.`;
    $("topbar").hidden = $("app").hidden = true;
    await sb.auth.signOut();
    return;
  }
  $("login").hidden = true;
  $("topbar").hidden = $("app").hidden = false;
  $("who").textContent = ME;
  loadLicenses();
}

// --- licenses ---------------------------------------------------------------
let LICENSES = [];
async function loadLicenses() {
  const { data, error } = await sb.from("license_overview").select("*").order("issued_at", { ascending: false });
  if (error) return toast("Tải license lỗi: " + error.message, "bad");
  LICENSES = data || [];
  renderLicenses();
}

function renderLicenses() {
  const q = $("search").value.trim().toLowerCase();
  const rows = LICENSES.filter((l) =>
    !q ||
    [l.key_id, l.name, l.email, l.assigned_to].some((v) => (v || "").toLowerCase().includes(q)));
  $("lic-empty").hidden = rows.length > 0;
  $("lic-rows").innerHTML = rows.map((l) => {
    const expired = l.expires_at && new Date(l.expires_at) < new Date();
    const state = expired ? "expired" : l.status;
    return `<tr>
      <td class="mono">${esc(l.key_id)}</td>
      <td>${esc(l.name || "—")}<div class="muted small">${esc(l.email || "")}</div></td>
      <td>${esc(l.plan)}</td>
      <td>${l.active_seats}/${l.max_seats}</td>
      <td>${fmtExpiry(l.expires_at)}</td>
      <td><span class="pill ${state}">${state}</span></td>
      <td><button class="ghost" data-detail="${l.id}">Chi tiết</button></td>
    </tr>`;
  }).join("");
  $("lic-rows").querySelectorAll("[data-detail]").forEach((b) =>
    (b.onclick = () => openDetail(b.dataset.detail)));
}

// --- issue ------------------------------------------------------------------
function openIssue() {
  $("drawer-body").innerHTML = `
    <h2>Cấp key mới</h2>
    <div class="field"><label>Tên người dùng</label><input id="i-name" placeholder="Nguyễn Văn A" /></div>
    <div class="field"><label>Email</label><input id="i-email" type="email" placeholder="a@x.com" /></div>
    <div class="field-row">
      <div class="field"><label>Gói</label><input id="i-plan" value="pro" /></div>
      <div class="field"><label>Số máy (seats)</label><input id="i-seats" type="number" min="1" value="1" /></div>
      <div class="field"><label>Số ngày (0 = vĩnh viễn)</label><input id="i-days" type="number" min="0" value="365" /></div>
    </div>
    <div class="field"><label>Giao cho (ghi chú)</label><input id="i-assigned" placeholder="bán qua FB / tên đại lý…" /></div>
    <div class="field"><label>Ghi chú</label><input id="i-note" /></div>
    <div class="drawer-actions">
      <button class="primary" id="i-submit">Cấp key</button>
      <button class="ghost" id="i-cancel">Đóng</button>
    </div>
    <div id="i-result"></div>`;
  showDrawer();
  $("i-cancel").onclick = hideDrawer;
  $("i-submit").onclick = async () => {
    $("i-submit").disabled = true;
    const r = await adminCall({
      action: "issue",
      name: $("i-name").value, email: $("i-email").value, plan: $("i-plan").value,
      max_seats: $("i-seats").value, days: $("i-days").value,
      assigned_to: $("i-assigned").value, note: $("i-note").value,
    });
    $("i-submit").disabled = false;
    if (!r.ok) return toast("Cấp key lỗi: " + (r.reason || ""), "bad");
    $("i-result").innerHTML = `<div class="sect"><label class="muted small">Key (gửi cho khách):</label>
      <div class="keybox" id="i-key">${esc(r.key)}</div>
      <button class="ghost" id="i-copy" style="margin-top:8px">Copy key</button></div>`;
    $("i-copy").onclick = () => { navigator.clipboard.writeText(r.key); toast("Đã copy key", "good"); };
    toast("Đã cấp " + r.license.key_id, "good");
    loadLicenses();
  };
}

// --- detail -----------------------------------------------------------------
async function openDetail(id) {
  const l = LICENSES.find((x) => x.id === id);
  if (!l) return;
  const { data: acts } = await sb.from("activations").select("*").eq("license_id", id).order("activated_at", { ascending: false });
  $("drawer-body").innerHTML = `
    <h2>${esc(l.key_id)} · ${esc(l.name || "—")}</h2>
    <p class="muted small">${esc(l.email || "")}</p>
    <div class="keybox">${esc(l.key)}</div>
    <button class="ghost" id="d-copy" style="margin-top:8px">Copy key</button>

    <div class="sect">
      <div class="field-row">
        <div class="field"><label>Trạng thái</label>
          <select id="d-status">
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="revoked">revoked</option>
          </select></div>
        <div class="field"><label>Số máy</label><input id="d-seats" type="number" min="1" value="${l.max_seats}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Gia hạn thêm (ngày, 0 = vĩnh viễn)</label><input id="d-days" type="number" min="0" value="0" /></div>
        <div class="field"><label>Giao cho</label><input id="d-assigned" value="${esc(l.assigned_to || "")}" /></div>
      </div>
      <div class="drawer-actions">
        <button class="primary" id="d-save">Lưu thay đổi</button>
        <button class="danger" id="d-revoke">Thu hồi key</button>
        <button class="ghost" id="d-close">Đóng</button>
      </div>
      <p class="muted small">Đang dùng ${l.active_seats}/${l.max_seats} máy · cấp ${fmtDate(l.issued_at)} · hạn ${fmtExpiry(l.expires_at)}</p>
    </div>

    <div class="sect">
      <b>Máy đã kích hoạt (${(acts || []).length})</b>
      <table class="grid"><thead><tr><th>Máy</th><th>HWID</th><th>Lần cuối</th><th>TT</th><th></th></tr></thead>
      <tbody>${(acts || []).map((a) => `<tr>
        <td>${esc(a.machine_name || "—")}<div class="muted small">${esc(a.app_version || "")}</div></td>
        <td class="mono">${esc(a.hwid)}</td>
        <td class="small">${fmtDate(a.last_seen)}</td>
        <td><span class="pill ${a.status}">${a.status}</span></td>
        <td>${a.status === "active"
          ? `<button class="danger" data-deact="${a.id}">Gỡ</button>`
          : `<button class="ghost" data-react="${a.id}">Bật lại</button>`}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">Chưa có máy nào.</td></tr>`}</tbody></table>
    </div>`;
  showDrawer();
  $("d-status").value = l.status;
  $("d-copy").onclick = () => { navigator.clipboard.writeText(l.key); toast("Đã copy", "good"); };
  $("d-close").onclick = hideDrawer;

  $("d-save").onclick = async () => {
    await adminCall({ action: "set_status", license_id: id, status: $("d-status").value });
    await adminCall({ action: "set_seats", license_id: id, max_seats: $("d-seats").value });
    await adminCall({ action: "set_assigned", license_id: id, assigned_to: $("d-assigned").value });
    const days = parseInt($("d-days").value, 10) || 0;
    if (days > 0) await adminCall({ action: "set_expiry", license_id: id, days });
    toast("Đã lưu", "good");
    await loadLicenses();
    openDetail(id);
  };
  $("d-revoke").onclick = async () => {
    if (!confirm("Thu hồi key này? Máy đang dùng sẽ mất quyền ở lần đồng bộ kế (≤7 ngày).")) return;
    await adminCall({ action: "set_status", license_id: id, status: "revoked" });
    toast("Đã thu hồi", "good");
    await loadLicenses();
    openDetail(id);
  };
  $("drawer-body").querySelectorAll("[data-deact]").forEach((b) =>
    (b.onclick = async () => { await adminCall({ action: "deactivate_machine", activation_id: b.dataset.deact }); toast("Đã gỡ máy", "good"); openDetail(id); loadLicenses(); }));
  $("drawer-body").querySelectorAll("[data-react]").forEach((b) =>
    (b.onclick = async () => { await adminCall({ action: "reactivate_machine", activation_id: b.dataset.react }); toast("Đã bật lại", "good"); openDetail(id); loadLicenses(); }));
}

// --- audit ------------------------------------------------------------------
async function loadAudit() {
  const { data } = await sb.from("audit_log").select("*").order("at", { ascending: false }).limit(200);
  $("audit-rows").innerHTML = (data || []).map((a) => `<tr>
    <td class="small">${fmtDate(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td>
    <td class="mono small">${esc(JSON.stringify(a.detail))}</td></tr>`).join("");
}

// --- admins -----------------------------------------------------------------
async function loadAdmins() {
  const { data } = await sb.from("admins").select("*").order("added_at");
  $("admin-rows").innerHTML = (data || []).map((a) => `<tr>
    <td>${esc(a.email)}</td><td class="small">${fmtDate(a.added_at)}</td>
    <td>${a.email === ME ? '<span class="muted small">bạn</span>'
      : `<button class="danger" data-rmadmin="${esc(a.email)}">Xóa</button>`}</td></tr>`).join("");
  $("admin-rows").querySelectorAll("[data-rmadmin]").forEach((b) =>
    (b.onclick = async () => { await adminCall({ action: "remove_admin", email: b.dataset.rmadmin }); toast("Đã xóa admin", "good"); loadAdmins(); }));
}

// --- drawer + tabs ----------------------------------------------------------
function showDrawer() { $("drawer").hidden = false; }
function hideDrawer() { $("drawer").hidden = true; }

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("tab-licenses").hidden = name !== "licenses";
  $("tab-audit").hidden = name !== "audit";
  $("tab-admins").hidden = name !== "admins";
  if (name === "audit") loadAudit();
  if (name === "admins") loadAdmins();
}

// --- wire -------------------------------------------------------------------
function wire() {
  $("login-send").onclick = sendMagicLink;
  $("login-email").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMagicLink(); });
  $("signout").onclick = () => sb.auth.signOut();
  $("btn-new").onclick = openIssue;
  $("refresh").onclick = loadLicenses;
  $("search").addEventListener("input", renderLicenses);
  $("drawer").onclick = (e) => { if (e.target === $("drawer")) hideDrawer(); };
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
  $("admin-add").onclick = async () => {
    const email = $("admin-email").value.trim();
    if (!email) return;
    const r = await adminCall({ action: "add_admin", email });
    if (r.ok) { $("admin-email").value = ""; toast("Đã thêm admin", "good"); loadAdmins(); }
    else toast("Lỗi: " + (r.reason || ""), "bad");
  };
}

function boot() {
  if (!CFG.SUPABASE_ANON_KEY) {
    document.body.innerHTML = '<p style="padding:24px">⚠ Chưa cấu hình SUPABASE_ANON_KEY trong <b>config.js</b>.</p>';
    return;
  }
  sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  wire();
  sb.auth.getSession().then(({ data }) => onSession(data.session));
  sb.auth.onAuthStateChange((_e, session) => onSession(session));
}

boot();

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
  try {
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
      const data = await res.json();
      // Supabase Edge Functions may return non-2xx with a JSON body that lacks `ok`
      if (typeof data.ok === "undefined" && !res.ok) {
        return { ok: false, reason: data.error || data.message || `HTTP ${res.status}` };
      }
      return data;
    } catch {
      return { ok: false, reason: `bad_response (HTTP ${res.status})` };
    }
  } catch (err) {
    return { ok: false, reason: "network_error: " + (err.message || err) };
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

async function signInWithPassword() {
  const email = $("login-email").value.trim();
  const password = $("login-pass").value;
  if (!email || !password) {
    $("login-msg").textContent = "Nhập email và mật khẩu (hoặc dùng magic link).";
    return;
  }
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) $("login-msg").textContent = "Đăng nhập thất bại: " + error.message;
  // success → onAuthStateChange fires onSession()
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
let sortCol = "issued_at";
let sortAsc = false;

async function loadLicenses() {
  const { data, error } = await sb.from("license_overview").select("*").order("issued_at", { ascending: false });
  if (error) return toast("Tải license lỗi: " + error.message, "bad");
  LICENSES = data || [];
  renderLicenses();
}

function renderLicenses() {
  const q = $("search").value.trim().toLowerCase();
  const fPlan = $("f-plan").value;
  const fSeats = $("f-seats").value;
  const fIssued = parseInt($("f-issued").value, 10) || 0;
  const fStatus = $("f-status").value;
  const now = Date.now();

  let rows = LICENSES.filter((l) => {
    if (q && ![l.key_id, l.name, l.email, l.assigned_to].some((v) => (v || "").toLowerCase().includes(q))) return false;
    if (fPlan && l.plan !== fPlan) return false;
    if (fSeats === "1-2" && l.max_seats > 2) return false;
    if (fSeats === "3-10" && (l.max_seats < 3 || l.max_seats > 10)) return false;
    if (fSeats === "11+" && l.max_seats <= 10) return false;
    if (fIssued > 0 && (now - new Date(l.issued_at).getTime()) > fIssued * 86400000) return false;
    const expired = l.expires_at && new Date(l.expires_at).getTime() < now;
    const state = expired ? "expired" : l.status;
    if (fStatus && state !== fStatus) return false;
    return true;
  });

  rows.sort((a, b) => {
    let va = a[sortCol];
    let vb = b[sortCol];
    if (sortCol === "seats") { va = a.max_seats; vb = b.max_seats; }
    if (va === vb) return 0;
    if (va == null) return sortAsc ? 1 : -1;
    if (vb == null) return sortAsc ? -1 : 1;
    return (va > vb ? 1 : -1) * (sortAsc ? 1 : -1);
  });

  document.querySelectorAll(".sortable").forEach(th => {
    const icon = th.dataset.sort === sortCol ? (sortAsc ? "↑" : "↓") : "";
    th.querySelector("span").textContent = icon;
  });

  $("lic-empty").hidden = rows.length > 0;
  $("lic-rows").innerHTML = rows.map((l) => {
    const expired = l.expires_at && new Date(l.expires_at).getTime() < now;
    const state = expired ? "expired" : l.status;
    return `<tr>
      <td class="mono">${esc(l.key_id)}</td>
      <td>${esc(l.name || "—")}<div class="muted small">${esc(l.email || "")}</div></td>
      <td>${esc(l.plan)}</td>
      <td>${l.active_seats}/${l.max_seats}</td>
      <td>${fmtDate(l.issued_at)}</td>
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
      <div class="field"><label>Gói</label>
        <select id="i-plan">
          <option value="pro">Pro (1-2 máy)</option>
          <option value="doanh nghiệp">Doanh nghiệp</option>
        </select>
      </div>
      <div class="field"><label>Số máy (seats)</label><input id="i-seats" type="number" min="1" value="1" /></div>
      <div class="field"><label>Số ngày (0 = vĩnh viễn)</label><input id="i-days" type="number" min="0" value="365" /></div>
    </div>
    <div class="field"><label>Giao cho (ghi chú)</label><input id="i-assigned" placeholder="bán qua FB / tên đại lý…" /></div>
    <div class="field"><label>Ghi chú</label><input id="i-note" /></div>
    <div class="drawer-actions">
      <button class="primary" id="i-submit">Cấp key</button>
      <button class="ghost" id="i-cancel">Đóng</button>
    </div>`;
  showDrawer();
  $("i-cancel").onclick = hideDrawer;
  $("i-submit").onclick = async () => {
    $("i-submit").disabled = true;
    try {
      const r = await adminCall({
        action: "issue",
        name: $("i-name").value, email: $("i-email").value, plan: $("i-plan").value,
        max_seats: parseInt($("i-seats").value, 10) || 1,
        days: parseInt($("i-days").value, 10) || 0,
        assigned_to: $("i-assigned").value, note: $("i-note").value,
      });
      $("i-submit").disabled = false;
      if (!r.ok) return toast("Cấp key lỗi: " + (r.reason || "không rõ"), "bad");
      
      hideDrawer();
      $("success-key").textContent = r.key;
      $("success-modal").hidden = false;
      navigator.clipboard.writeText(r.key).catch(()=>{});
      
      loadLicenses();
    } catch (err) {
      $("i-submit").disabled = false;
      toast("Cấp key lỗi: " + (err.message || err), "bad");
      console.error("Issue key error:", err);
    }
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
  $("login-pass-btn").onclick = signInWithPassword;
  $("login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") signInWithPassword(); });
  $("login-email").addEventListener("keydown", (e) => { if (e.key === "Enter") signInWithPassword(); });
  $("signout").onclick = () => sb.auth.signOut();
  $("btn-new").onclick = openIssue;
  $("refresh").onclick = loadLicenses;
  $("search").addEventListener("input", renderLicenses);
  $("f-plan").onchange = renderLicenses;
  $("f-seats").onchange = renderLicenses;
  $("f-issued").onchange = renderLicenses;
  $("f-status").onchange = renderLicenses;
  
  document.querySelectorAll(".sortable").forEach(th => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = false; }
      renderLicenses();
    };
  });
  
  $("success-close").onclick = () => { $("success-modal").hidden = true; };
  
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
  // IMPORTANT: Defer onSession so it runs outside the Supabase auth
  // navigator.lock scope. Without this, onSession → isAdmin() → getSession()
  // tries to re-acquire the same exclusive lock → deadlock → blank page.
  sb.auth.getSession().then(({ data }) => setTimeout(() => onSession(data.session), 0));
  sb.auth.onAuthStateChange((_e, session) => setTimeout(() => onSession(session), 0));
}

boot();

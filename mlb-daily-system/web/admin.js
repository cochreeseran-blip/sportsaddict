/* Slatefinder admin console. Served only on the admin host and only to
   an admin account (server verifies role on every request; this file
   never arrives on the customer host). No build step, vanilla JS, same
   relative-fetch, same-origin model as the customer app. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdds = (ml) => (ml === null || ml === undefined ? '-' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));
const fmtPct = (n, d = 1) => (n === null || n === undefined ? '-' : `${(Number(n) * 100).toFixed(d)}%`);

function todayIso() { return new Date().toISOString().slice(0, 10); }
function fmtTime(iso) {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${path} -> ${res.status}`);
  return res.json();
}
async function apiSend(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}

const state = { view: 'slate' };

// ---------------------------------------------------------------------------
// SLATE REVIEW
// Being redesigned. The publish endpoint, the one-way trigger, and the
// rest of the admin API are untouched underneath this; only the picks/
// info display here has been cleared out to rebuild.
async function renderSlate() {
  const host = $('#admin-view');
  host.innerHTML = `
    <div class="section-head"><h2 class="section-title">Slate review</h2></div>
    <div class="empty-state"><div class="es-title">Redesigning</div>This view is being rebuilt.</div>`;
}

// ---------------------------------------------------------------------------
// HOME RUNS
// The filter itself (lib/filters/windHr.js) already runs every pipeline
// cycle, it's just not wired to the ledger or surfaced anywhere yet.
// Placeholder tab until that's built out.
async function renderHomeRuns() {
  const host = $('#admin-view');
  host.innerHTML = `
    <div class="section-head"><h2 class="section-title">Home runs</h2></div>
    <div class="empty-state"><div class="es-title">Coming soon</div>Home run props aren't live yet.</div>`;
}

// ---------------------------------------------------------------------------
// RECORD (admin view of the dual public record)
function recordCard(kind, r) {
  return `
    <div class="record-card">
      <div class="record-kind">${kind === 'algorithm' ? 'Algorithm' : 'Published'}</div>
      <div class="record-label">${esc(r.label || '')}</div>
      <div class="record-wl">${r.wins}<span class="record-dash">-</span>${r.losses}${r.pushes ? `<span class="record-push">-${r.pushes}</span>` : ''}</div>
      <div class="record-rate">${r.winRate !== null && r.winRate !== undefined ? `${fmtPct(r.winRate)} win rate` : (r.graded > 0 ? 'Sample too small for a rate' : 'No graded picks yet')}</div>
      ${r.pending ? `<div class="record-pending">${r.pending} pending</div>` : ''}
      ${r.pricedGraded && r.pricedWinRate !== null && r.avgBreakeven !== null ? `<div class="record-clv"><span>Priced ${fmtPct(r.pricedWinRate)} vs. break-even ${fmtPct(r.avgBreakeven)}</span></div>` : ''}
    </div>`;
}
async function renderRecord() {
  const host = $('#admin-view');
  host.innerHTML = '<div class="section-head"><h2 class="section-title">Track record</h2></div><p class="section-sub">Loading…</p>';
  try {
    const r = await api('/api/record');
    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Track record</h2></div>
      <p class="section-sub">Both records are public on the customer site too. Win % is suppressed under 50 graded picks.</p>
      <div class="record-grid">${recordCard('algorithm', r.algorithm)}${recordCard('published', r.published)}</div>`;
  } catch (err) {
    host.innerHTML = emptyState('Record unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// USERS
function sparkline(points) {
  if (!points?.length) return '';
  const max = Math.max(1, ...points.map((p) => p.signups));
  const bars = points.map((p) => `<span class="spark-bar" style="height:${Math.round((p.signups / max) * 100)}%" title="${esc(p.day)}: ${p.signups}"></span>`).join('');
  return `<div class="spark">${bars}</div>`;
}
async function renderUsers() {
  const host = $('#admin-view');
  host.innerHTML = '<div class="section-head"><h2 class="section-title">Users</h2></div><p class="section-sub">Loading…</p>';
  try {
    const u = await api('/api/admin/users');
    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Users</h2></div>
      <div class="admin-stat-row">
        <div class="admin-stat"><div class="admin-stat-num">${u.totalUsers}</div><div class="admin-stat-lbl">Registered</div></div>
        <div class="admin-stat"><div class="admin-stat-num">${u.activeUsers7d}</div><div class="admin-stat-lbl">Active (7 days)</div></div>
      </div>
      <h2 class="board-title">Signups, last 30 days</h2>
      ${sparkline(u.signupsLast30Days)}`;
  } catch (err) {
    host.innerHTML = emptyState('Users unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// EMAIL
async function renderEmail() {
  const host = $('#admin-view');
  host.innerHTML = '<div class="section-head"><h2 class="section-title">Email</h2></div><p class="section-sub">Loading…</p>';
  try {
    const [stats, slate] = await Promise.all([
      api('/api/admin/email/stats'),
      api(`/api/admin/slate?date=${todayIso()}`),
    ]);
    // Only PUBLISHED picks are selectable, unpublished ones aren't real yet.
    const published = [
      ...(slate.picks.moneyline || []),
      ...(slate.picks.hit_streak || []),
      ...(slate.picks.strikeout || []),
    ].filter((p) => p.published);

    const options = published.length
      ? published.map((p) => `<label class="admin-pick-check"><input type="checkbox" value="${p.id}"><span>${esc(p.headline || p.description)}</span></label>`).join('')
      : '<p class="section-sub">No published picks today. Publish on the Slate review tab first, only published picks can be emailed.</p>';

    const sends = (stats.recentSends || []).map((s) =>
      `<tr><td class="mono">${esc(fmtDateTime(s.sent_at))}</td><td class="mono">#${s.admin_user_id ?? '-'}</td><td class="mono">${s.recipient_count}</td><td>${esc((s.pick_ids || []).join(', '))}</td></tr>`
    ).join('');

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Email</h2></div>
      <div class="admin-stat-row">
        <div class="admin-stat"><div class="admin-stat-num">${stats.eligibleRecipients}</div><div class="admin-stat-lbl">Verified &amp; opted in</div></div>
        <div class="admin-stat"><button class="btn ghost" id="csvBtn">Export CSV</button><div class="admin-stat-lbl">Marketing list</div></div>
      </div>

      <h2 class="board-title">Compose</h2>
      <p class="section-sub">Pick from today's published picks, write a short intro, preview, then send. Every email carries the unsubscribe link, postal address, and required disclaimers, the server refuses to send without them.</p>
      <label class="field"><span>Subject</span><input type="text" id="emSubject" placeholder="Today's published picks"></label>
      <label class="field"><span>Intro</span><textarea id="emIntro" rows="3" placeholder="A short note to go above the picks."></textarea></label>
      <div class="admin-pick-checks">${options}</div>
      <div class="admin-modal-actions" style="justify-content:flex-start">
        <button class="btn ghost" id="emPreview" ${published.length ? '' : 'disabled'}>Preview</button>
        <button class="btn primary" id="emSend" ${published.length ? '' : 'disabled'}>Send</button>
      </div>
      <div class="modal-error" id="emError" hidden></div>
      <div id="emPreviewWrap"></div>

      <h2 class="board-title">Recent sends</h2>
      ${sends ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Admin</th><th>Recipients</th><th>Pick ids</th></tr></thead><tbody>${sends}</tbody></table></div>` : '<p class="section-sub">No sends yet.</p>'}`;

    $('#csvBtn').addEventListener('click', downloadCsv);
    $('#emPreview').addEventListener('click', previewEmail);
    $('#emSend').addEventListener('click', sendEmail);
  } catch (err) {
    host.innerHTML = emptyState('Email panel unavailable', err.message);
  }
}

function selectedPickIds() {
  return [...document.querySelectorAll('.admin-pick-check input:checked')].map((c) => Number(c.value));
}

// CSV export via POST + file download: addresses never touch a URL or a
// GET response.
async function downloadCsv() {
  const res = await fetch('/api/admin/email/export', { method: 'POST' });
  if (!res.ok) { alert('Export failed.'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'slatefinder-marketing-list.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

async function previewEmail() {
  const err = $('#emError'); err.hidden = true;
  try {
    const r = await apiSend('/api/admin/email/preview', 'POST', {
      intro: $('#emIntro').value, subject: $('#emSubject').value, pickIds: selectedPickIds(),
    });
    $('#emPreviewWrap').innerHTML = `<h2 class="board-title">Preview</h2><div class="admin-email-preview"><iframe title="email preview"></iframe></div>`;
    const iframe = $('#emPreviewWrap iframe');
    iframe.srcdoc = r.html;
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
}

async function sendEmail() {
  const err = $('#emError'); err.hidden = true;
  if (!confirm('Send this email to every verified, opted-in recipient?')) return;
  $('#emSend').disabled = true;
  try {
    const r = await apiSend('/api/admin/email/send', 'POST', {
      intro: $('#emIntro').value, subject: $('#emSubject').value, pickIds: selectedPickIds(),
    });
    alert(`Sent to ${r.sent} of ${r.total} recipients.`);
    renderEmail();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    $('#emSend').disabled = false;
  }
}

// ---------------------------------------------------------------------------
function emptyState(title, msg) {
  return `<div class="empty-state"><div class="es-title">${esc(title)}</div>${esc(msg)}</div>`;
}

function showView(name) {
  state.view = name;
  document.querySelectorAll('#adminTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'slate') renderSlate();
  if (name === 'homeruns') renderHomeRuns();
  if (name === 'record') renderRecord();
  if (name === 'users') renderUsers();
  if (name === 'email') renderEmail();
}

async function init() {
  $('#adminTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });
  try {
    const me = await api('/api/auth/me');
    $('#adminWho').textContent = me.user ? `${me.user.username} · admin` : '';
  } catch { /* the page wouldn't have loaded for a non-admin anyway */ }
  showView('slate');
}

init();

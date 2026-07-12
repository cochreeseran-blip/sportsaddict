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

const state = { view: 'slate', dashDate: todayIso(), signalTab: 'strikeouts', dashData: null, liveSource: null, autoTimer: null };

// ---------------------------------------------------------------------------
// RESEARCH DASHBOARD (Phase 1 private research dashboard, slatefinder.lol)
// Bloomberg-terminal-not-ESPN: dense, functional, color-coded by whether a
// number is good or bad FOR THE PICK, not decorative. Three panels: today's
// slate overview, the three signal tabs (K props / hit props / moneyline),
// and a live monitor that only matters once games are underway.

// Simple 3-way color coder: value >= goodMin is favorable (green), value <=
// badMax is unfavorable (red), everything between is neutral (yellow-ish,
// left uncolored here since the base text color already reads as neutral).
function colorClass(value, { goodMin, badMax, invert = false } = {}) {
  if (value === null || value === undefined) return '';
  const good = invert ? value <= goodMin : value >= goodMin;
  const bad = invert ? value >= badMax : value <= badMax;
  if (good) return 'pos';
  if (bad) return 'neg';
  return '';
}

function refreshCountdownLabel(nextAt) {
  if (!nextAt) return '';
  const secs = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  return `next refresh in ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// --- Panel 1: slate overview -------------------------------------------------
function pitcherProfileCell(name, profile) {
  if (!name) return '<span class="faint">TBD</span>';
  if (!profile) return `${esc(name)}<div class="faint" style="font-size:11px">no Savant data yet</div>`;
  const era = profile.savantEra ?? profile.seasonEra;
  return `
    <div>${esc(name)}</div>
    <div class="mono" style="font-size:11px;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="${colorClass(era, { goodMin: 99, badMax: 4.5, invert: true })}">${fmtNum(era)} ERA</span>
      <span class="${colorClass(profile.kPct, { goodMin: 25, badMax: 18 })}">${fmtPct(profile.kPct ? profile.kPct / 100 : null, 0)} K</span>
      <span class="${colorClass(profile.whiffPct, { goodMin: 28, badMax: 22 })}">${fmtPct(profile.whiffPct ? profile.whiffPct / 100 : null, 0)} whiff</span>
      <span class="${colorClass(profile.hardHitPct, { goodMin: 45, badMax: 33, invert: true })}">${fmtPct(profile.hardHitPct ? profile.hardHitPct / 100 : null, 0)} hard-hit</span>
    </div>`;
}

function lineupStatusPill(confirmed, confirmedAt) {
  if (confirmed) return `<span class="pill ok"><span class="pill-dot"></span>Confirmed${confirmedAt ? ` · ${fmtTime(confirmedAt)}` : ''}</span>`;
  return '<span class="pill dim">Projected</span>';
}

function slateOverviewTable(games) {
  if (!games.length) return emptyState('No games today', 'Nothing on the MLB schedule for this date.');
  const rows = games.map((g) => `
    <tr>
      <td>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}<div class="faint" style="font-size:11px">${esc(g.venue || '')}</div></td>
      <td>${pitcherProfileCell(g.awayStarterName, g.awayStarterProfile)}</td>
      <td>${pitcherProfileCell(g.homeStarterName, g.homeStarterProfile)}</td>
      <td>${lineupStatusPill(g.awayLineupConfirmed, g.awayLineupConfirmedAt)} ${lineupStatusPill(g.homeLineupConfirmed, g.homeLineupConfirmedAt)}</td>
      <td class="mono">${g.awayMl !== null && g.awayMl !== undefined ? fmtOdds(g.awayMl) : '-'} / ${g.homeMl !== null && g.homeMl !== undefined ? fmtOdds(g.homeMl) : '-'}</td>
      <td class="mono live-cell" data-live-game="${esc(g.mlbGameId)}">-</td>
    </tr>`).join('');
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Game</th><th>Away starter</th><th>Home starter</th><th>Lineups</th><th>Away/Home ML</th><th>Live</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// --- Panel 2: signal cards ---------------------------------------------------
function strikeoutCard(p) {
  const highConf = p.strictFloorKs >= 6 && p.opposingTeamKPct !== null && p.opposingTeamKPct >= 24;
  return `
    <div class="sig-card">
      <div class="sig-head">
        <span>${esc(p.pitcherName)} <span class="faint">(${esc(p.team)} ${p.isHome ? 'vs' : '@'} ${esc(p.opponent)})</span></span>
        <span style="display:flex;align-items:center;gap:8px">${gradeBadge(p.grade)}${highConf ? '<span class="pill hot">High confidence</span>' : ''}</span>
      </div>
      <div class="sig-sub">K floor <strong>${p.strictFloorKs}</strong> (soft floor ${p.softFloorKs ?? '-'}) over his last ${p.last5StartKs.length} starts: ${p.last5StartKs.join(', ')}</div>
      <div class="sig-note">Suggested line: over ${fmtNum(p.suggestedLine, 1)}</div>
      <div class="sig-note mono">${fmtNum(p.kPerStart, 1)} K/start · opponent K rate <span class="${colorClass(p.opposingTeamKPct, { goodMin: 24, badMax: 20 })}">${fmtPct(p.opposingTeamKPct ? p.opposingTeamKPct / 100 : null, 0)}</span></div>
      <div class="faint" style="font-size:11px;margin-top:6px">${esc(p.gradeReasons.join(' · '))}</div>
    </div>`;
}

function hitPropCard(p) {
  const luck = p.xbaLuckFlag === 'buy' ? '<span class="pill ok">Buy signal</span>' : p.xbaLuckFlag === 'sell' ? '<span class="pill warn">Regression risk</span>' : '';
  return `
    <div class="sig-card">
      <div class="sig-head">
        <span>${esc(p.batterName)} <span class="faint">(${esc(p.team)}${p.battingOrderSlot ? `, batting ${p.battingOrderSlot}` : ''})</span></span>
        <span style="display:flex;align-items:center;gap:8px">${gradeBadge(p.grade)}${luck}</span>
      </div>
      <div class="sig-sub">${p.hitStreak >= 5 ? `${p.hitStreak}-game hit streak, ` : ''}batting ${fmtNum(p.trailing15Avg, 3)} over his last 15 (${p.trailing15Ab} AB)${p.xba !== null ? `, xBA ${fmtNum(p.xba, 3)}` : ''}</div>
      <div class="sig-note">vs ${esc(p.opposingStarterName || 'TBD')}${p.opposingHitsPer9 !== null ? `, allows <span class="mono ${colorClass(p.opposingHitsPer9, { goodMin: 9.5, badMax: 7.5 })}">${fmtNum(p.opposingHitsPer9, 1)}</span> H/9` : ''}</div>
      ${p.vsTeamPa >= 20 ? `<div class="sig-note mono">${fmtNum(p.vsTeamAvg, 3)} career vs this team (${p.vsTeamPa} PA)</div>` : ''}
      <div class="faint" style="font-size:11px;margin-top:6px">${esc(p.gradeReasons.join(' · '))}</div>
    </div>`;
}

function moneylineCard(p) {
  const blowout = p.awayStarterBlowoutInflated
    ? '<div class="pill warn">Blowout-inflated: ex-worst-start ERA drops under 4.50</div>' : '';
  return `
    <div class="sig-card">
      <div class="sig-head">
        <span>${esc(p.homeTeam)} ${fmtOdds(p.homeMl)} <span class="faint">vs ${esc(p.awayTeam)}</span></span>
      </div>
      <div class="sig-sub">${esc(p.awayStarterName || 'TBD')} trailing ERA <strong class="mono">${fmtNum(p.awayStarterTrailingEra)}</strong> over his last ${p.awayStarterTrailingStarts ?? '-'} start(s)</div>
      ${blowout}
      <div class="sig-note mono">Home off. ${fmtNum(p.homeRunsPerGame, 1)} R/G · Away off. ${fmtNum(p.awayRunsPerGame, 1)} R/G</div>
      <div class="faint" style="font-size:11px;margin-top:6px">
        Home: ${p.homeStarterSavant ? `${fmtNum(p.homeStarterSavant.era)} ERA, ${fmtPct(p.homeStarterSavant.kPct ? p.homeStarterSavant.kPct / 100 : null, 0)} K` : 'no Savant data'}
        &nbsp;|&nbsp; Away: ${p.awayStarterSavant ? `${fmtNum(p.awayStarterSavant.era)} ERA, ${fmtPct(p.awayStarterSavant.kPct ? p.awayStarterSavant.kPct / 100 : null, 0)} K` : 'no Savant data'}
      </div>
    </div>`;
}

function gradeBadge(grade) {
  if (!grade) return '';
  const cls = `g-${grade.toLowerCase().replace('+', 'plus')}`;
  return `<span class="grade-badge ${cls}">${esc(grade)}</span>`;
}

function signalPanel(data) {
  const tabs = [
    ['strikeouts', `K Props (${data.strikeouts.length})`],
    ['hitProps', `Hit Props (${data.hitProps.length})`],
    ['moneyline', `Moneyline (${data.moneyline.picks.length})`],
  ];
  const tabBtns = tabs.map(([key, label]) =>
    `<button class="tab ${state.signalTab === key ? 'active' : ''}" data-signal-tab="${key}">${label}</button>`).join('');

  let body;
  if (state.signalTab === 'strikeouts') {
    body = data.strikeouts.length ? `<div class="sig-cards">${data.strikeouts.map(strikeoutCard).join('')}</div>` : emptyState('No K props today', 'Nothing clears the K-floor gate.');
  } else if (state.signalTab === 'hitProps') {
    body = data.hitProps.length ? `<div class="sig-cards">${data.hitProps.map(hitPropCard).join('')}</div>` : emptyState('No hit props today', 'Nothing clears the qualification gates.');
  } else {
    const picks = data.moneyline.picks.length ? `<div class="sig-cards">${data.moneyline.picks.map(moneylineCard).join('')}</div>` : emptyState('SIT', 'No home favorite clears both gates today.');
    body = picks;
  }
  return `<nav class="tabs" style="margin:14px 0">${tabBtns}</nav>${body}`;
}

// --- Panel 3: live monitor (SSE) --------------------------------------------
function stopLiveMonitor() {
  if (state.liveSource) { state.liveSource.close(); state.liveSource = null; }
}

function applyLiveSnapshot(games) {
  for (const g of games) {
    const cell = document.querySelector(`[data-live-game="${g.mlbGameId}"]`);
    if (!cell) continue;
    if (g.error) { cell.textContent = '-'; continue; }
    if (g.inning === null || g.inning === undefined) { cell.textContent = 'Preview'; continue; }
    cell.innerHTML = `${g.awayScore ?? 0}-${g.homeScore ?? 0} <span class="faint">${esc(g.inningState || '')} ${g.inning}</span>`;
    if (g.pitcherChanged) {
      cell.innerHTML += `<div class="pill warn" style="margin-top:4px">Pitcher change: ${esc(g.newPitcherName || '')}</div>`;
    }
  }
  const alertHost = $('#liveAlerts');
  if (!alertHost) return;
  const alerts = games.filter((g) => g.pitcherChanged && g.departedStarter);
  alertHost.innerHTML = alerts.length ? alerts.map((g) => {
    const lines = Object.entries(g.departedStarter || {}).map(([side, d]) =>
      `${esc(d.pitcherId)} left with ${d.strikeouts ?? '?'} Ks${d.suggestedLine !== null ? ` (line ${d.suggestedLine}, prop ${d.kPropStatus === 'hit' ? 'HIT' : d.kPropStatus === 'dead' ? 'DEAD' : 'n/a'})` : ''}`
    ).join(' · ');
    return `<div class="sig-card" style="border-color:var(--amber)"><div class="sig-head"><span>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}</span><span class="pill hot">Pitcher change</span></div><div class="sig-sub">${lines}</div></div>`;
  }).join('') : '';
}

function startLiveMonitor(dateStr) {
  stopLiveMonitor();
  try {
    const src = new EventSource(`/api/dashboard/live?date=${encodeURIComponent(dateStr)}`);
    src.onmessage = (e) => {
      try { applyLiveSnapshot(JSON.parse(e.data)); } catch { /* ignore malformed frame */ }
    };
    src.onerror = () => { /* browser auto-reconnects; nothing to do */ };
    state.liveSource = src;
  } catch { /* SSE unsupported or blocked, live panel just stays static */ }
}

// --- assembly -----------------------------------------------------------------
function dashboardToolbar() {
  return `
    <div class="signals-toolbar">
      <input type="date" id="dashDate" value="${state.dashDate}" class="date-select">
      <button class="btn ghost small" id="dashRefresh">Refresh now</button>
      <span class="faint" id="dashUpdated" style="font-size:11px"></span>
    </div>`;
}

async function renderSlate() {
  const host = $('#admin-view');
  host.innerHTML = `<div class="section-head"><h2 class="section-title">Research</h2></div>${dashboardToolbar()}<p class="section-sub">Loading…</p>`;
  await loadDashboard(state.dashDate);
}

// Renders from already-fetched data (used both right after a fetch and on
// a signal-tab switch, which must NOT refetch or restart the live SSE
// connection just to change which card grid is visible).
function renderDashboardBody(data) {
  const host = $('#admin-view');
  host.innerHTML = `
    <div class="section-head"><h2 class="section-title">Research</h2></div>
    ${dashboardToolbar()}
    <h2 class="board-title">Today's slate${count(data.slate.length)}</h2>
    ${slateOverviewTable(data.slate)}
    <div id="liveAlerts"></div>
    <h2 class="board-title">Signals</h2>
    ${signalPanel(data)}`;
  wireDashboardControls();
}

async function loadDashboard(dateStr) {
  const host = $('#admin-view');
  try {
    const data = await api(`/api/dashboard?date=${encodeURIComponent(dateStr)}`);
    state.dashData = data;
    renderDashboardBody(data);
    startLiveMonitor(dateStr);
  } catch (err) {
    host.innerHTML = `<div class="section-head"><h2 class="section-title">Research</h2></div>${dashboardToolbar()}${emptyState('Dashboard unavailable', err.message)}`;
    wireDashboardControls();
  }
}

function count(n) { return `<span class="board-count">${n}</span>`; }

function wireDashboardControls() {
  $('#dashDate')?.addEventListener('change', (e) => {
    state.dashDate = e.target.value;
    stopLiveMonitor();
    loadDashboard(state.dashDate);
  });
  $('#dashRefresh')?.addEventListener('click', () => loadDashboard(state.dashDate));
  document.querySelectorAll('[data-signal-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.signalTab = btn.dataset.signalTab;
      // Tab switch: re-render from the cache already in hand, no refetch,
      // no live-monitor restart.
      if (state.dashData) renderDashboardBody(state.dashData);
    });
  });
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

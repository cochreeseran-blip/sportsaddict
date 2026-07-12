/* Slatefinder admin dashboard. Vanilla JS, no build step, same pattern as
   web/app.js. Every /api/admin/* call relies on the session cookie; the
   server re-checks role==='admin' on every single request (see
   lib/adminAuth.js), this file does no authorization of its own, it just
   renders what the server is willing to hand back. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdds = (ml) => (ml === null || ml === undefined ? '-' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtPct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `${path} -> ${res.status}`);
  }
  return res.json();
}
async function apiSend(path, method, body) {
  return api(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const state = { view: 'slate', slateDate: todayIso(), emailDate: todayIso() };

// ---------------------------------------------------------------------------
// SLATE REVIEW
let pendingPublishId = null;

function pickCard(p, rank) {
  const m = p.qualifyingMetrics || {};
  const isTop = rank === 1;
  const gameStarted = p.gameStarted === true;
  return `
    <div class="sig-card${p.published ? ' locked-win' : ''}" style="margin-bottom:10px">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:8px">
          ${isTop ? '<span class="rank-badge">1</span>' : `<span class="rank-badge" style="opacity:.5">${rank}</span>`}
          <strong>${esc(m.homeTeam || 'Unknown')}</strong>${m.homeMl !== null && m.homeMl !== undefined ? ` <span class="mono faint">${fmtOdds(m.homeMl)}</span>` : ''}
          ${isTop ? '<span class="pill info">Top of board — free-tier pick</span>' : ''}
        </span>
        ${p.published
          ? `<span class="pub-locked">&#10003; Published ${p.publishedAt ? new Date(p.publishedAt).toLocaleString() : ''}</span>`
          : gameStarted
            ? '<span class="pill dim">Game started — can no longer publish</span>'
            : `<button class="btn small primary" data-publish="${p.id}">Publish</button>`}
      </div>
      <div class="sig-sub">${esc(p.description)}</div>
      <div class="sig-note">
        Away starter trailing ERA <strong>${m.awayStarterTrailingEra ?? '-'}</strong> (${m.awayStarterTrailingStarts ?? 0} starts)
        &middot; season ERA edge <strong>${m.seasonEraEdge ?? '-'}</strong>
        &middot; break-even ${p.breakevenPct !== null && p.breakevenPct !== undefined ? fmtPct(p.breakevenPct) : '-'}
        &middot; result: <strong>${esc(p.result)}</strong>
      </div>
      <div class="sig-note" style="margin-top:4px">
        Lineups: home ${p.homeLineupConfirmed ? '<span style="color:var(--green)">confirmed</span>' : '<span style="color:var(--text-3)">not posted</span>'}
        &middot; away ${p.awayLineupConfirmed ? '<span style="color:var(--green)">confirmed</span>' : '<span style="color:var(--text-3)">not posted</span>'}
      </div>
      ${(p.warnings || []).map((w) => `<div class="warn-banner"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:var(--amber);margin-top:6px;flex-shrink:0"></span><div>${esc(w)}</div></div>`).join('')}
    </div>`;
}

async function renderSlate() {
  const host = $('#view-slate');
  host.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const { picks } = await api(`/api/admin/slate?date=${state.slateDate}`);
    const byType = {};
    for (const p of picks) (byType[p.signalType] ||= []).push(p);

    const ml = byType.moneyline || [];
    const mlHtml = ml.length
      ? ml.map((p, i) => pickCard(p, i + 1)).join('')
      : '<div class="empty-state"><div class="es-title">No qualifying games today</div>Nothing cleared the moneyline gate for this date yet.</div>';

    host.innerHTML = `
      <div class="top-row">
        <h2 class="board-title" style="margin:0">Slate review<span class="board-count">${picks.length}</span></h2>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn small" id="slatePrev">&larr; Yesterday</button>
          <input type="date" id="slateDatePick" value="${state.slateDate}" style="background:var(--panel-2);border:1px solid var(--border-strong);border-radius:6px;color:var(--text);padding:5px 8px;font:500 13px var(--font)">
          <button class="btn small" id="slateNext">Tomorrow &rarr;</button>
          <button class="btn small" id="slateRefresh">Refresh</button>
        </div>
      </div>
      <p class="section-sub">Every pick the pipeline generated for this date, published and unpublished. Moneyline picks are ordered by away starter's trailing ERA, worst arm first — that's the top-of-board free pick. Publishing is permanent: once a pick is public, it can't be edited or removed, only graded.</p>

      <h3 class="board-title" style="font-size:16px">Moneyline${byType.moneyline ? `<span class="board-count">${ml.length}</span>` : ''}</h3>
      ${mlHtml}`;

    $('#slateDatePick').addEventListener('change', (e) => { state.slateDate = e.target.value; renderSlate(); });
    $('#slatePrev').addEventListener('click', () => { state.slateDate = addDays(state.slateDate, -1); renderSlate(); });
    $('#slateNext').addEventListener('click', () => { state.slateDate = addDays(state.slateDate, 1); renderSlate(); });
    $('#slateRefresh').addEventListener('click', renderSlate);
    host.querySelectorAll('[data-publish]').forEach((btn) => {
      btn.addEventListener('click', () => openPublishModal(Number(btn.dataset.publish)));
    });
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="es-title">Couldn't load the slate</div>${esc(err.message)}</div>`;
  }
}

function openPublishModal(pickId) {
  pendingPublishId = pickId;
  $('#pubError').hidden = true;
  $('#publishModal').hidden = false;
}
function closePublishModal() {
  $('#publishModal').hidden = true;
  pendingPublishId = null;
}

// ---------------------------------------------------------------------------
// USERS PANEL
async function renderUsers() {
  const host = $('#view-users');
  host.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const d = await api('/api/admin/users');
    const max = Math.max(1, ...d.signupsLast30Days.map((r) => r.signups));
    const bars = d.signupsLast30Days.map((r) => `<i style="height:${Math.max(2, (r.signups / max) * 60)}px" title="${r.date}: ${r.signups}"></i>`).join('');
    host.innerHTML = `
      <h2 class="board-title" style="margin-top:0">Users</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="n">${d.totalUsers}</div><div class="lbl">Total registered</div></div>
        <div class="stat-card"><div class="n">${d.activeLast7Days}</div><div class="lbl">Active in last 7 days</div></div>
      </div>
      <div class="stat-card">
        <div class="lbl">Signups, last 30 days</div>
        <div class="spark">${bars}</div>
      </div>`;
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="es-title">Couldn't load users</div>${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// EMAIL PANEL
async function renderEmail() {
  const host = $('#view-email');
  host.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const [{ count }, { picks }] = await Promise.all([
      api('/api/admin/email/audience-count'),
      api(`/api/admin/email/published-picks?date=${state.emailDate}`),
    ]);
    host.innerHTML = `
      <h2 class="board-title" style="margin-top:0">Email</h2>
      <div class="stat-grid">
        <div class="stat-card"><div class="n">${count}</div><div class="lbl">Verified + opted-in recipients</div></div>
      </div>
      <button class="btn" id="exportCsv">Export audience CSV</button>

      <h3 class="board-title" style="font-size:16px;margin-top:28px">Compose</h3>
      <p class="section-sub">Only today's PUBLISHED picks are selectable, an unpublished pick isn't real yet.</p>
      <label class="field"><span>Date</span>
        <input type="date" id="composeDate" value="${state.emailDate}" style="background:var(--panel-2);border:1px solid var(--border-strong);border-radius:6px;color:var(--text);padding:6px 9px;font:500 13px var(--font)">
      </label>
      <div id="composePicks">
        ${picks.length
          ? picks.map((p) => `<label class="pick-check-row"><input type="checkbox" class="compose-pick-cb" value="${p.id}" checked> ${esc(p.description)}</label>`).join('')
          : '<div class="empty-state"><div class="es-title">No published picks for this date</div>Publish something on Slate review first, or send an intro-only note.</div>'}
      </div>
      <label class="field" style="margin-top:12px"><span>Subject</span>
        <input type="text" id="composeSubject" placeholder="Today's pick" style="font:400 13.5px var(--font);color:var(--text);background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:7px 10px;width:100%">
      </label>
      <label class="field"><span>Intro copy</span>
        <textarea id="composeIntro" class="compose-body" placeholder="A short note above the picks..."></textarea>
      </label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn" id="composePreview">Preview</button>
        <button class="btn primary" id="composeSend">Send to ${count} recipient(s)</button>
      </div>
      <div id="composeError" class="compliance-fail" style="display:none"></div>
      <div id="composePreviewFrame"></div>`;

    $('#composeDate').addEventListener('change', async (e) => {
      state.emailDate = e.target.value;
      await renderEmail();
    });
    $('#exportCsv').addEventListener('click', async () => {
      const res = await fetch('/api/admin/email/export', { method: 'POST' });
      if (!res.ok) { alert('Export failed.'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `slatefinder-marketing-audience-${todayIso()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('#composePreview').addEventListener('click', () => {
      const pickIds = Array.from(document.querySelectorAll('.compose-pick-cb:checked')).map((cb) => Number(cb.value));
      const intro = $('#composeIntro').value;
      const chosen = picks.filter((p) => pickIds.includes(p.id));
      const html = `<div style="font-family:sans-serif;padding:16px">
        <p style="font-weight:700">Slatefinder</p>
        ${intro ? `<p>${esc(intro)}</p>` : ''}
        ${chosen.map((p) => `<p><strong>${esc(p.description.split('.')[0])}</strong><br>${esc(p.description)}</p>`).join('') || '<p>No picks selected.</p>'}
        <hr><p style="font-size:11px;color:#888">Unsubscribe link &middot; postal address &middot; Research signals only. Not betting advice. &middot; 21+. Gambling problem? Call 1-800-GAMBLER.</p>
        </div>`;
      const frame = $('#composePreviewFrame');
      frame.innerHTML = '<div class="preview-frame"><iframe></iframe></div>';
      frame.querySelector('iframe').srcdoc = html;
    });
    $('#composeSend').addEventListener('click', async () => {
      const err = $('#composeError');
      err.style.display = 'none';
      const pickIds = Array.from(document.querySelectorAll('.compose-pick-cb:checked')).map((cb) => Number(cb.value));
      try {
        const result = await apiSend('/api/admin/email/send', 'POST', {
          gameDate: state.emailDate,
          pickIds,
          intro: $('#composeIntro').value,
          subject: $('#composeSubject').value,
        });
        alert(`Sent ${result.sent}/${result.total}.`);
      } catch (ex) {
        err.textContent = ex.message;
        err.style.display = 'block';
      }
    });
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="es-title">Couldn't load email panel</div>${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// NAV
function showView(name) {
  state.view = name;
  document.querySelectorAll('.admin-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.admin-view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'slate') renderSlate();
  if (name === 'users') renderUsers();
  if (name === 'email') renderEmail();
}

function init() {
  $('#adminTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.admin-tab');
    if (tab) showView(tab.dataset.view);
  });
  $('#pubCancel').addEventListener('click', closePublishModal);
  $('#pubConfirm').addEventListener('click', async () => {
    if (!pendingPublishId) return;
    try {
      await apiSend('/api/admin/publish', 'POST', { pickId: pendingPublishId });
      closePublishModal();
      renderSlate();
    } catch (err) {
      $('#pubError').textContent = err.message;
      $('#pubError').hidden = false;
    }
  });
  renderSlate();
}

init();

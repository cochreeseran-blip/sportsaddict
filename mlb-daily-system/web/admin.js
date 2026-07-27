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

const state = {
  view: 'slate',
  dashDate: todayIso(),
  signalTab: 'strikeouts', // one of: strikeouts | multiHit | homeRuns | moneyline
  dashData: null,
  liveSource: null,
  autoTimer: null,
  // Performance tab: which scope and window are being viewed. Defaults to
  // the algorithm scope because that's the honest number (every pick the
  // system generated), not the flattering published subset.
  perfScope: 'algorithm',
  perfWindow: null,
};

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

// Two pills per game, one per team. The team abbreviation prefix is not
// decoration: without it the column reads "Projected Confirmed" and there
// is no way to tell WHICH side's lineup is out, which is the entire
// question this column answers before a batter prop can be trusted.
function lineupStatusPill(teamLabel, confirmed, confirmedAt) {
  const label = teamLabel ? `${esc(teamLabel)} ` : '';
  if (confirmed) {
    return `<span class="pill ok"><span class="pill-dot"></span>${label}confirmed${confirmedAt ? ` · ${fmtTime(confirmedAt)}` : ''}</span>`;
  }
  return `<span class="pill dim">${label}projected</span>`;
}

// Team abbreviations come from the shared media helper (web/media.js) so
// the Finder and the public app never disagree about what to call a team.
const abbr = (teamName) => Media.teamAbbrev(teamName);

function slateOverviewTable(games) {
  if (!games.length) return emptyState('No games today', 'Nothing on the MLB schedule for this date.');
  const rows = games.map((g) => `
    <tr>
      <td>${esc(g.awayTeam)} @ ${esc(g.homeTeam)}<div class="faint" style="font-size:11px">${esc(g.venue || '')}</div></td>
      <td>${pitcherProfileCell(g.awayStarterName, g.awayStarterProfile)}</td>
      <td>${pitcherProfileCell(g.homeStarterName, g.homeStarterProfile)}</td>
      <td class="lineup-cell">${lineupStatusPill(abbr(g.awayTeam), g.awayLineupConfirmed, g.awayLineupConfirmedAt)}${lineupStatusPill(abbr(g.homeTeam), g.homeLineupConfirmed, g.homeLineupConfirmedAt)}</td>
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
    <div class="sig-card ${p.published ? 'is-published' : ''}">
      <div class="sig-head">
        <span class="sig-who">
          ${Media.headshot(p.pitcherId, p.pitcherName, 44)}
          <span>
            <span class="sig-name">${esc(p.pitcherName)}</span>
            <span class="sig-meta">${Media.teamLogo(p.team, 14)} ${esc(Media.teamAbbrev(p.team))} ${p.isHome ? 'vs' : '@'} ${esc(Media.teamAbbrev(p.opponent))}</span>
          </span>
        </span>
        <span class="sig-badges">${gradeBadge(p.grade)}${highConf ? '<span class="pill hot">High confidence</span>' : ''}</span>
      </div>
      <div class="proj-row">
        <div class="proj-main">
          <span class="proj-pct">${fmtNum(p.suggestedLine, 1)}</span>
          <span class="proj-label">line, over</span>
        </div>
        <div class="proj-side">
          <span class="mono">${fmtNum(p.kPerStart, 1)} K/start</span>
          <span class="faint">floor ${p.strictFloorKs} · soft ${p.softFloorKs ?? '-'}</span>
        </div>
      </div>
      <div class="sig-note">Last starts: <span class="mono">${p.last5StartKs.join(', ')}</span></div>
      <div class="sig-note mono">Opponent K rate <span class="${colorClass(p.opposingTeamKPct, { goodMin: 24, badMax: 20 })}">${fmtPct(p.opposingTeamKPct ? p.opposingTeamKPct / 100 : null, 0)}</span></div>
      <div class="faint sig-why">${esc(p.gradeReasons.join(' · '))}</div>
      <div class="sig-foot">${publishControl(p)}</div>
    </div>`;
}

// The headline number on a hit card is the projection for THAT tier: a 2+
// card leads with P(2+), a 1+ card with P(1+). Both come from one model
// (lib/hitProjection.js) so the two boards always agree with each other.
function hitPropCard(p, tier = 'multi') {
  const isMulti = tier !== 'single';
  const prob = isMulti ? p.pAtLeastTwo : p.pAtLeastOne;
  const luck = p.xbaLuckFlag === 'buy' ? '<span class="pill ok">Buy signal</span>' : p.xbaLuckFlag === 'sell' ? '<span class="pill warn">Regression risk</span>' : '';
  const slot = Number.isInteger(p.battingOrderSlot)
    ? `batting ${p.battingOrderSlot}`
    : '<span class="warn-text">slot TBD</span>';
  // The empirical check on the projection: how often he ACTUALLY had a
  // multi-hit game recently. Shown on 2+ cards because that's the tier it
  // corroborates.
  const actual = isMulti && p.multiHitRate !== null && p.multiHitRate !== undefined
    ? `<span class="proj-actual">actually ${fmtPct(p.multiHitRate, 0)} of his last ${p.trailing15Games ?? 15}</span>`
    : '';

  return `
    <div class="sig-card ${p.published ? 'is-published' : ''}">
      <div class="sig-head">
        <span class="sig-who">
          ${Media.headshot(p.batterId, p.batterName, 44)}
          <span>
            <span class="sig-name">${esc(p.batterName)}</span>
            <span class="sig-meta">${Media.teamLogo(p.team, 14)} ${esc(Media.teamAbbrev(p.team))} · ${slot}</span>
          </span>
        </span>
        <span class="sig-badges">${gradeBadge(p.grade)}${luck}</span>
      </div>
      <div class="proj-row">
        <div class="proj-main">
          <span class="proj-pct ${colorClass(prob, isMulti ? { goodMin: 0.40, badMax: 0.32 } : { goodMin: 0.78, badMax: 0.70 })}">${fmtPct(prob, 0)}</span>
          <span class="proj-label">to get ${isMulti ? '2+' : '1+'} hit${isMulti ? 's' : ''}</span>
        </div>
        <div class="proj-side">
          <span class="mono">${fmtNum(p.expectedHits, 2)} projected hits</span>
          <span class="faint">in ${fmtNum(p.expectedAtBats, 1)} AB</span>
        </div>
      </div>
      ${actual ? `<div class="sig-note">${actual}</div>` : ''}
      <div class="sig-sub">${p.hitStreak >= 5 ? `${p.hitStreak}-game hit streak, ` : ''}batting ${fmtNum(p.trailing15Avg, 3)} over his last 15 (${p.trailing15Ab} AB)${p.xba !== null && p.xba !== undefined ? `, xBA ${fmtNum(p.xba, 3)}` : ''}</div>
      <div class="sig-note">vs ${esc(p.opposingStarterName || 'TBD')}${p.opposingHitsPer9 !== null && p.opposingHitsPer9 !== undefined ? `, allows <span class="mono ${colorClass(p.opposingHitsPer9, { goodMin: 9.5, badMax: 7.5 })}">${fmtNum(p.opposingHitsPer9, 1)}</span> H/9` : ''}</div>
      ${p.vsTeamPa >= 20 ? `<div class="sig-note mono">${fmtNum(p.vsTeamAvg, 3)} career vs this team (${p.vsTeamPa} PA)</div>` : ''}
      <div class="faint sig-why">${esc((p.gradeReasons || []).join(' · '))}</div>
      <div class="sig-foot">${publishControl(p)}</div>
    </div>`;
}

// Home run card. Leads with barrel rate because that's what the score is
// actually built on, not the HR count, which over 15 games is mostly noise.
function homeRunCard(p) {
  const noSavant = p.barrelPct === null || p.barrelPct === undefined;
  const wind = p.windBlowingOut
    ? `<span class="pill ok">Wind out${p.windSpeedMph ? ` ${fmtNum(p.windSpeedMph, 0)} mph` : ''}</span>` : '';
  return `
    <div class="sig-card ${p.published ? 'is-published' : ''}">
      <div class="sig-head">
        <span class="sig-who">
          ${Media.headshot(p.batterId, p.batterName, 44)}
          <span>
            <span class="sig-name">${esc(p.batterName)}</span>
            <span class="sig-meta">${Media.teamLogo(p.team, 14)} ${esc(Media.teamAbbrev(p.team))}${Number.isInteger(p.battingOrderSlot) ? ` · batting ${p.battingOrderSlot}` : ''}</span>
          </span>
        </span>
        <span class="sig-badges">${gradeBadge(p.grade)}${wind}</span>
      </div>
      <div class="proj-row">
        <div class="proj-main">
          <span class="proj-pct ${colorClass(p.barrelPct, { goodMin: 12, badMax: 7 })}">${noSavant ? '-' : fmtNum(p.barrelPct, 1) + '%'}</span>
          <span class="proj-label">barrel rate</span>
        </div>
        <div class="proj-side">
          <span class="mono">${p.avgExitVelo !== null && p.avgExitVelo !== undefined ? `${fmtNum(p.avgExitVelo, 1)} mph exit velo` : 'no exit velo'}</span>
          <span class="faint">${p.xslg !== null && p.xslg !== undefined ? `${fmtNum(p.xslg, 3)} xSLG` : ''}</span>
        </div>
      </div>
      ${noSavant ? '<div class="sig-note warn-text">No Savant data on file, capped at B.</div>' : ''}
      <div class="sig-note">vs ${esc(p.opposingStarterName || 'TBD')}${p.opposingHrPer9 !== null && p.opposingHrPer9 !== undefined ? `, allows <span class="mono ${colorClass(p.opposingHrPer9, { goodMin: 1.5, badMax: 1.0 })}">${fmtNum(p.opposingHrPer9, 2)}</span> HR/9` : ''}</div>
      <div class="sig-note mono">Homered in ${fmtPct(p.trailing15HrRate, 0)} of his last ${p.trailing15Games ?? 15} · ${esc(p.venue || '')}</div>
      <div class="faint sig-why">${esc((p.gradeReasons || []).join(' · '))}</div>
      <div class="sig-foot">${publishControl(p)}</div>
    </div>`;
}

function moneylineCard(p) {
  const blowout = p.awayStarterBlowoutInflated
    ? '<div class="pill warn">Blowout-inflated: ex-worst-start ERA drops under 4.50</div>' : '';
  return `
    <div class="sig-card ${p.published ? 'is-published' : ''}">
      <div class="sig-head">
        <span class="sig-who">
          ${Media.teamLogo(p.homeTeam, 34)}
          <span>
            <span class="sig-name">${esc(p.homeTeam)} ${fmtOdds(p.homeMl)}</span>
            <span class="sig-meta">vs ${Media.teamLogo(p.awayTeam, 14)} ${esc(Media.teamAbbrev(p.awayTeam))}</span>
          </span>
        </span>
      </div>
      <div class="sig-sub">${esc(p.awayStarterName || 'TBD')} trailing ERA <strong class="mono">${fmtNum(p.awayStarterTrailingEra)}</strong> over his last ${p.awayStarterTrailingStarts ?? '-'} start(s)</div>
      ${blowout}
      <div class="sig-note mono">Home off. ${fmtNum(p.homeRunsPerGame, 1)} R/G · Away off. ${fmtNum(p.awayRunsPerGame, 1)} R/G</div>
      <div class="faint" style="font-size:11px;margin-top:6px">
        Home: ${p.homeStarterSavant ? `${fmtNum(p.homeStarterSavant.era)} ERA, ${fmtPct(p.homeStarterSavant.kPct ? p.homeStarterSavant.kPct / 100 : null, 0)} K` : 'no Savant data'}
        &nbsp;|&nbsp; Away: ${p.awayStarterSavant ? `${fmtNum(p.awayStarterSavant.era)} ERA, ${fmtPct(p.awayStarterSavant.kPct ? p.awayStarterSavant.kPct / 100 : null, 0)} K` : 'no Savant data'}
      </div>
      <div class="sig-foot">${publishControl(p)}</div>
    </div>`;
}

function gradeBadge(grade) {
  if (!grade) return '';
  const cls = `g-${grade.toLowerCase().replace('+', 'plus')}`;
  return `<span class="grade-badge ${cls}">${esc(grade)}</span>`;
}

// The publish control, rendered on every signal card.
//
// This is the only way a pick reaches slateaddict.com, so its states have
// to be unambiguous:
//   published        -> a locked stamp, no button (it is permanent)
//   not yet recorded -> explained, no button (the pipeline hasn't written
//                       a ledger row for this date, so there is nothing
//                       to publish and a button would fail silently)
//   otherwise        -> the button
function publishControl(p) {
  if (p.published) {
    return `<div class="pub-state is-published">On the record${p.publishedAt ? ` · ${esc(fmtDateTime(p.publishedAt))}` : ''}</div>`;
  }
  if (!p.ledgerId) {
    return '<div class="pub-state is-unrecorded">Not in the ledger yet, publish once the pipeline records this date.</div>';
  }
  return `<button class="btn primary small pub-btn" data-publish="${p.ledgerId}">Publish</button>`;
}

// Publishing is permanent and enforced by a database trigger, so it sits
// behind an explicit confirmation that says exactly that. There is no
// edit and no delete anywhere in this app because no such endpoint
// exists.
function confirmPublish(pickId, headline) {
  const wrap = document.createElement('div');
  wrap.className = 'admin-modal-overlay';
  wrap.innerHTML = `
    <div class="admin-modal">
      <div class="admin-modal-title">Publish this pick?</div>
      <p class="admin-modal-body">${esc(headline || '')}</p>
      <p class="admin-modal-body"><strong>This is permanent.</strong> Once published it is on the public record whether it wins or loses. It cannot be edited, un-published, or deleted by anyone, including you.</p>
      <div class="admin-modal-actions">
        <button class="btn ghost" id="pubCancel">Cancel</button>
        <button class="btn primary" id="pubConfirm">Publish permanently</button>
      </div>
      <div class="modal-error" id="pubError" hidden></div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('#pubCancel', wrap).addEventListener('click', close);
  $('#pubConfirm', wrap).addEventListener('click', async () => {
    $('#pubConfirm', wrap).disabled = true;
    try {
      await apiSend('/api/admin/publish', 'POST', { pickId });
      close();
      loadDashboard(state.dashDate); // refetch so the card flips to its locked state
    } catch (err) {
      const e = $('#pubError', wrap);
      e.textContent = err.message;
      e.hidden = false;
      $('#pubConfirm', wrap).disabled = false;
    }
  });
}

function signalPanel(data) {
  const multi = data.multiHit || [];
  const hrs = data.homeRuns || [];
  const tabs = [
    ['strikeouts', `K Props (${data.strikeouts.length})`],
    ['multiHit', `2+ Hits (${multi.length})`],
    ['homeRuns', `Home Runs (${hrs.length})`],
    ['moneyline', `Moneyline (${data.moneyline.picks.length})`],
  ];
  const tabBtns = tabs.map(([key, label]) =>
    `<button class="tab ${state.signalTab === key ? 'active' : ''}" data-signal-tab="${key}">${label}</button>`).join('');

  const cutoff = data.tierCutoffs || {};
  let body;
  if (state.signalTab === 'strikeouts') {
    body = data.strikeouts.length
      ? `<div class="sig-cards">${data.strikeouts.map(strikeoutCard).join('')}</div>`
      : emptyState('No K props today', 'Nothing clears the K-floor gate.');
  } else if (state.signalTab === 'multiHit') {
    body = multi.length
      ? `<p class="section-sub">Batters projected above ${fmtPct(cutoff.multiHit ?? 0.32, 0)} to record two or more hits, best first.</p>
         <div class="sig-cards">${multi.map((p) => hitPropCard(p, 'multi')).join('')}</div>`
      : emptyState('No 2+ hit candidates today', `Nobody projects above ${fmtPct(cutoff.multiHit ?? 0.32, 0)} for a multi-hit game.`);
  } else if (state.signalTab === 'homeRuns') {
    body = hrs.length
      ? `<p class="section-sub">Ranked on Statcast contact quality against arms that give up home runs.</p>
         <div class="sig-cards">${hrs.map(homeRunCard).join('')}</div>`
      : emptyState('No home run candidates today', 'Nothing clears the barrel-rate or HR-rate gate.');
  } else {
    body = data.moneyline.picks.length
      ? `<div class="sig-cards">${data.moneyline.picks.map(moneylineCard).join('')}</div>`
      : emptyState('SIT', 'No home favorite clears both gates today.');
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
  // Publish, delegated so it works across every board without rebinding
  // on each tab switch. The headline is passed into the confirm dialog so
  // a permanent action always names exactly what is about to be published.
  document.querySelectorAll('[data-publish]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.sig-card');
      const headline = card?.querySelector('.sig-name')?.textContent?.trim() || '';
      confirmPublish(Number(btn.dataset.publish), headline);
    });
  });
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
// PERFORMANCE
// Per-signal and per-grade hit rates off the immutable ledger. This is the
// answer to "which of these actually work" -- and, because the ledger
// cannot be edited (see the tracked_picks_guard trigger), it's also the
// evidence behind any claim the public site makes.
function perfRateCell(row) {
  if (row.winRate !== null && row.winRate !== undefined) {
    const cls = row.winRate >= 0.6 ? 'pos' : row.winRate < 0.45 ? 'neg' : '';
    return `<span class="mono ${cls}">${fmtPct(row.winRate, 1)}</span>`;
  }
  if (row.graded === 0) return '<span class="faint">-</span>';
  return `<span class="faint" title="Needs ${row.needsForRate} more graded">${row.needsForRate} more</span>`;
}

function perfSignalBlock(sig) {
  const gradeRows = (sig.grades || [])
    .filter((g) => g.graded > 0 || g.pending > 0)
    .map((g) => `
      <tr>
        <td>${gradeBadge(g.grade)}</td>
        <td class="mono">${g.wins}-${g.losses}${g.pushes ? `-${g.pushes}` : ''}</td>
        <td>${perfRateCell(g)}</td>
        <td class="mono faint">${g.pending || 0}</td>
      </tr>`).join('');

  return `
    <div class="perf-block">
      <div class="perf-head">
        <span class="perf-name">${esc(sig.label)}</span>
        <span class="perf-topline">
          <span class="perf-wl mono">${sig.wins}-${sig.losses}${sig.pushes ? `-${sig.pushes}` : ''}</span>
          <span class="perf-rate">${perfRateCell(sig)}</span>
        </span>
      </div>
      ${gradeRows
        ? `<div class="table-wrap"><table class="data-table perf-table">
             <thead><tr><th>Grade</th><th>W-L</th><th>Hit rate</th><th>Pending</th></tr></thead>
             <tbody>${gradeRows}</tbody></table></div>`
        : '<p class="section-sub">No graded picks with a grade on file yet.</p>'}
    </div>`;
}

async function renderPerformance() {
  const host = $('#admin-view');
  host.innerHTML = '<div class="section-head"><h2 class="section-title">Performance</h2></div><p class="section-sub">Loading…</p>';
  try {
    const windowParam = state.perfWindow ? `?sinceDays=${state.perfWindow}` : '';
    const d = await api(`/api/performance/breakdown${windowParam}`);
    const scope = state.perfScope === 'published' ? d.published : d.algorithm;

    const windows = [[null, 'All time'], [30, 'Last 30 days'], [7, 'Last 7 days']];
    const windowBtns = windows.map(([days, label]) =>
      `<button class="tab ${(state.perfWindow ?? null) === days ? 'active' : ''}" data-perf-window="${days ?? ''}">${label}</button>`).join('');
    const scopeBtns = [['algorithm', 'Algorithm (everything generated)'], ['published', 'Published (what I called)']]
      .map(([key, label]) => `<button class="tab ${state.perfScope === key ? 'active' : ''}" data-perf-scope="${key}">${label}</button>`).join('');

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Performance</h2></div>
      <p class="section-sub">Straight counts off the pick ledger. Nothing is excluded, and a published pick can never be edited or removed, so these numbers can only get more honest over time. Hit rates stay hidden until ${d.minGradedForRate} graded picks.</p>
      <nav class="tabs" style="margin:12px 0 4px">${scopeBtns}</nav>
      <nav class="tabs" style="margin:0 0 16px">${windowBtns}</nav>
      <div class="perf-overall">
        <div class="perf-overall-wl mono">${scope.overall.wins}-${scope.overall.losses}${scope.overall.pushes ? `-${scope.overall.pushes}` : ''}</div>
        <div class="perf-overall-meta">
          <span>${scope.overall.graded} graded${scope.overall.pending ? `, ${scope.overall.pending} pending` : ''}</span>
          <span>${scope.overall.winRate !== null ? `${fmtPct(scope.overall.winRate, 1)} overall` : 'rate hidden until the sample is real'}</span>
        </div>
      </div>
      ${scope.signals.length
        ? scope.signals.map(perfSignalBlock).join('')
        : emptyState('Nothing graded yet', 'Once games finish and picks grade, the breakdown appears here.')}`;

    host.querySelectorAll('[data-perf-scope]').forEach((btn) => {
      btn.addEventListener('click', () => { state.perfScope = btn.dataset.perfScope; renderPerformance(); });
    });
    host.querySelectorAll('[data-perf-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.perfWindow = btn.dataset.perfWindow ? Number(btn.dataset.perfWindow) : null;
        renderPerformance();
      });
    });
  } catch (err) {
    host.innerHTML = `<div class="section-head"><h2 class="section-title">Performance</h2></div>${emptyState('Performance unavailable', err.message)}`;
  }
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
  if (name === 'performance') renderPerformance();
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

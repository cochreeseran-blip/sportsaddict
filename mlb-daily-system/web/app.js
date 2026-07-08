/* SlateFinder client — vanilla JS single-page app, no build step.
   Views: Slate (10-day interactive browser), Signals (daily edge digest),
   Performance (tracked pick ledger). All data comes from this server's
   /api/* endpoints; logos and headshots load from MLB's public CDN. */

'use strict';

// ---------------------------------------------------------------------------
// Static team registry: full name -> { id, abbrev }. Used to resolve logos
// in the Signals view where the digest only stores team names. The Slate
// view gets ids live from the schedule API, so this is only a fallback map.
const TEAMS = {
  'Arizona Diamondbacks': { id: 109, abbrev: 'AZ' },
  'Atlanta Braves': { id: 144, abbrev: 'ATL' },
  'Baltimore Orioles': { id: 110, abbrev: 'BAL' },
  'Boston Red Sox': { id: 111, abbrev: 'BOS' },
  'Chicago Cubs': { id: 112, abbrev: 'CHC' },
  'Chicago White Sox': { id: 145, abbrev: 'CWS' },
  'Cincinnati Reds': { id: 113, abbrev: 'CIN' },
  'Cleveland Guardians': { id: 114, abbrev: 'CLE' },
  'Colorado Rockies': { id: 115, abbrev: 'COL' },
  'Detroit Tigers': { id: 116, abbrev: 'DET' },
  'Houston Astros': { id: 117, abbrev: 'HOU' },
  'Kansas City Royals': { id: 118, abbrev: 'KC' },
  'Los Angeles Angels': { id: 108, abbrev: 'LAA' },
  'Los Angeles Dodgers': { id: 119, abbrev: 'LAD' },
  'Miami Marlins': { id: 146, abbrev: 'MIA' },
  'Milwaukee Brewers': { id: 158, abbrev: 'MIL' },
  'Minnesota Twins': { id: 142, abbrev: 'MIN' },
  'New York Mets': { id: 121, abbrev: 'NYM' },
  'New York Yankees': { id: 147, abbrev: 'NYY' },
  'Athletics': { id: 133, abbrev: 'ATH' },
  'Oakland Athletics': { id: 133, abbrev: 'OAK' },
  'Philadelphia Phillies': { id: 143, abbrev: 'PHI' },
  'Pittsburgh Pirates': { id: 134, abbrev: 'PIT' },
  'San Diego Padres': { id: 135, abbrev: 'SD' },
  'San Francisco Giants': { id: 137, abbrev: 'SF' },
  'Seattle Mariners': { id: 136, abbrev: 'SEA' },
  'St. Louis Cardinals': { id: 138, abbrev: 'STL' },
  'Tampa Bay Rays': { id: 139, abbrev: 'TB' },
  'Texas Rangers': { id: 140, abbrev: 'TEX' },
  'Toronto Blue Jays': { id: 141, abbrev: 'TOR' },
  'Washington Nationals': { id: 120, abbrev: 'WSH' },
};

const state = {
  today: new Date().toISOString().slice(0, 10), // corrected from /api/status
  view: 'slate',
  slateDate: null,
  signalsDate: null,
  slateCache: new Map(),
};

// --- tiny helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdds = (ml) => (ml === null || ml === undefined ? '—' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

function shiftIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dowLabel(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}
function shortDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
function longDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function etTime(iso) {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}
function etDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

function logoHtml(teamId, teamName, size = 34) {
  const id = teamId ?? TEAMS[teamName]?.id ?? null;
  const abbrev = TEAMS[teamName]?.abbrev ?? (teamName || '?').slice(0, 3).toUpperCase();
  if (!id) return `<span class="gc-logo-fallback" style="width:${size}px;height:${size}px">${esc(abbrev)}</span>`;
  return `<img class="gc-logo" style="width:${size}px;height:${size}px" loading="lazy" alt="${esc(teamName || '')} logo"
    src="https://www.mlbstatic.com/team-logos/${id}.svg"
    onerror="this.outerHTML='<span class=&quot;gc-logo-fallback&quot; style=&quot;width:${size}px;height:${size}px&quot;>${esc(abbrev)}</span>'">`;
}

function headshotHtml(personId, name) {
  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (!personId) return `<span class="headshot-fallback">${esc(initials)}</span>`;
  return `<img class="headshot" loading="lazy" alt=""
    src="https://img.mlbstatic.com/mlb-photos/image/upload/w_96,q_auto/v1/people/${personId}/headshot/67/current"
    onerror="this.outerHTML='<span class=&quot;headshot-fallback&quot;>${esc(initials)}</span>'">`;
}

function form5Html(results) {
  if (!results || !results.length) return '<span class="faint" style="font-size:11px">—</span>';
  return `<span class="form5">${results.map((hit) => `<i class="${hit ? 'hit' : ''}"></i>`).join('')}</span>`;
}

function lineupPill(confirmed, confirmedAt) {
  if (confirmed === true) {
    const when = confirmedAt ? ` · ${etDateTime(confirmedAt)}` : '';
    return `<span class="pill ok"><span class="pill-dot"></span>Lineup confirmed${esc(when)}</span>`;
  }
  if (confirmed === false) return '<span class="pill warn"><span class="pill-dot"></span>Projected lineup</span>';
  return '';
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
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

function fmtMoney(n, withSign = false) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return `-$${abs}`;
  return withSign ? `+$${abs}` : `$${abs}`;
}

const loadingHtml = '<div class="loading"><span class="spinner"></span>Loading</div>';
function emptyHtml(title, msg) {
  return `<div class="empty-state"><div class="es-title">${esc(title)}</div>${esc(msg)}</div>`;
}

// ---------------------------------------------------------------------------
// SLATE VIEW — 10-day window: 5 days back, today, 4 days ahead.
function slateWindow() {
  const days = [];
  for (let i = -5; i <= 4; i++) days.push(shiftIso(state.today, i));
  return days;
}

function renderSlateShell() {
  const days = slateWindow();
  $('#view-slate').innerHTML = `
    <p class="section-sub">The last five days, today, and the next four. Open a game for lineups, batting order, and pitcher form.</p>
    <div class="date-strip" id="dateStrip">
      ${days.map((d) => `
        <div class="date-chip ${d < state.today ? 'past' : ''} ${d === state.today ? 'today' : ''} ${d === state.slateDate ? 'selected' : ''}" data-date="${d}">
          <div class="dc-dow">${d === state.today ? 'Today' : dowLabel(d)}</div>
          <div class="dc-date">${shortDate(d)}</div>
        </div>`).join('')}
    </div>
    <div id="slateGames">${loadingHtml}</div>`;

  $('#dateStrip').addEventListener('click', (e) => {
    const chip = e.target.closest('.date-chip');
    if (!chip) return;
    state.slateDate = chip.dataset.date;
    document.querySelectorAll('.date-chip').forEach((c) => c.classList.toggle('selected', c === chip));
    loadSlateGames();
  });
}

function statusLabel(g) {
  if (g.abstractState === 'Final') return { text: g.status, cls: 'final' };
  if (g.abstractState === 'Live') {
    const inn = g.inning ? `${g.inningState || 'Live'} ${g.inning}` : 'Live';
    return { text: inn, cls: 'live' };
  }
  return { text: etTime(g.gameDate), cls: '' };
}

function gameCardHtml(g) {
  const st = statusLabel(g);
  const isFinal = g.abstractState === 'Final';
  const started = g.abstractState !== 'Preview';
  const awayWin = isFinal && g.away.score > g.home.score;
  const homeWin = isFinal && g.home.score > g.away.score;

  const teamRow = (t, ml, winner) => `
    <div class="gc-team">
      ${logoHtml(t.id, t.name)}
      <span class="gc-name">${esc(t.name || 'TBD')}<span class="gc-record">${esc(t.record || '')}</span></span>
      ${started
        ? `<span class="gc-score ${winner ? 'winner' : ''}">${t.score ?? '—'}</span>`
        : `<span class="gc-odds ${ml !== null && ml > 0 ? 'dog' : ''}">${fmtOdds(ml)}</span>`}
    </div>`;

  const pills = [];
  if (!started) {
    const bothPosted = g.lineups.home.posted && g.lineups.away.posted;
    const confirmedAt = g.lineups.home.confirmedAt || g.lineups.away.confirmedAt;
    if (bothPosted) pills.push(lineupPill(true, confirmedAt));
    else if (g.lineups.home.posted || g.lineups.away.posted) pills.push('<span class="pill info"><span class="pill-dot"></span>One lineup posted</span>');
    else pills.push('<span class="pill warn"><span class="pill-dot"></span>Lineups pending</span>');
    if (g.windBlowingOut === true) pills.push(`<span class="pill hot"><span class="pill-dot"></span>Wind out ${fmtNum(g.windSpeedMph, 0)} mph</span>`);
  }

  const pitchers = (g.away.starterName || g.home.starterName) && !isFinal ? `
    <div class="gc-pitchers">
      <div class="gc-pitcher"><span class="lbl">Away starter</span><span class="nm">${esc(g.away.starterName || 'TBD')}</span></div>
      <div class="gc-pitcher"><span class="lbl">Home starter</span><span class="nm">${esc(g.home.starterName || 'TBD')}</span></div>
    </div>` : '';

  return `
    <article class="game-card" data-gamepk="${g.gamePk}" data-date="${esc(g.officialDate)}">
      <div class="gc-status-row">
        <span class="gc-status ${st.cls}">${esc(st.text)}</span>
        <span class="gc-venue">${esc(g.venue || '')}</span>
      </div>
      ${teamRow(g.away, g.awayMl, awayWin)}
      <div class="gc-divider"></div>
      ${teamRow(g.home, g.homeMl, homeWin)}
      ${pitchers}
      ${pills.length ? `<div class="gc-meta">${pills.join('')}</div>` : ''}
    </article>`;
}

async function loadSlateGames() {
  const host = $('#slateGames');
  const date = state.slateDate;
  host.innerHTML = loadingHtml;
  try {
    let slate = state.slateCache.get(date);
    if (!slate) {
      slate = await api(`/api/slate?date=${encodeURIComponent(date)}`);
      state.slateCache.set(date, slate);
      // Keep live days fresh: today/live games shouldn't stick around.
      if (date >= state.today) setTimeout(() => state.slateCache.delete(date), 120000);
    }
    if (state.slateDate !== date) return; // user already clicked elsewhere
    if (!slate.games.length) {
      host.innerHTML = emptyHtml('No games', `There are no MLB games scheduled on ${longDate(date)}.`);
      return;
    }
    host.innerHTML = `<div class="game-grid">${slate.games.map(gameCardHtml).join('')}</div>`;
    host.querySelectorAll('.game-card').forEach((card) => {
      card.addEventListener('click', () => openGamePanel(card.dataset.gamepk, card.dataset.date));
    });
  } catch (err) {
    host.innerHTML = emptyHtml('Feed unavailable', `Could not load the slate for ${date}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// GAME DETAIL PANEL
function eraClass(era) {
  if (era === null || era === undefined) return '';
  return era >= 6 ? 'era-bad' : era <= 4 ? 'era-good' : '';
}

function lineupRows(side) {
  if (!side.posted || !side.batters.length) {
    return emptyHtml('Lineup not posted yet', 'Teams usually post official lineups 1-3 hours before first pitch. Check back closer to game time.');
  }
  return `<div class="lineup-list">${side.batters.map((b) => `
    <div class="lu-row">
      <span class="lu-order">${b.order}</span>
      ${headshotHtml(b.id, b.fullName)}
      <div>
        <div class="player-nm">${esc(b.fullName || 'Unknown')}</div>
        <div class="player-meta">
          ${b.jerseyNumber ? `<span class="jersey">#${esc(b.jerseyNumber)}</span>` : ''}
          ${b.position ? `<span>${esc(b.position)}</span>` : ''}
        </div>
      </div>
      <div class="lu-stats">
        ${b.battingLine ? `<div class="lu-stat"><div class="v">${b.battingLine.hits}-${b.battingLine.atBats}</div><div class="k">Today</div></div>` : ''}
        <div class="lu-stat"><div class="v">${b.hitStreak ?? '—'}</div><div class="k">Streak</div></div>
        <div class="lu-stat"><div class="v">${b.trailing15Avg !== null && b.trailing15Avg !== undefined ? fmtNum(b.trailing15Avg, 3) : '—'}</div><div class="k">L15 avg</div></div>
        <div class="lu-stat">${form5Html(b.last5Results)}<div class="k">Last 5</div></div>
      </div>
    </div>`).join('')}</div>`;
}

async function openGamePanel(gamePk, date) {
  const panel = $('#gamePanel');
  const overlay = $('#panelOverlay');
  const inner = $('#gamePanelInner');
  panel.classList.add('open');
  overlay.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  inner.innerHTML = `<button class="gp-close" id="gpClose" aria-label="Close">×</button>${loadingHtml}`;
  $('#gpClose').addEventListener('click', closeGamePanel);

  const slateGame = (state.slateCache.get(date)?.games || []).find((g) => String(g.gamePk) === String(gamePk));

  try {
    const d = await api(`/api/game?gamePk=${gamePk}&date=${date}`);
    const away = slateGame?.away || { id: d.away.teamId, name: d.away.teamName };
    const home = slateGame?.home || { id: d.home.teamId, name: d.home.teamName };
    const started = slateGame && slateGame.abstractState !== 'Preview';

    const starterBox = (label, s) => `
      <div class="gp-starter">
        <div class="lbl">${esc(label)}</div>
        <div class="who">${esc(s.name || 'TBD')}</div>
        <div class="eras">
          Last 3 starts: <span class="${eraClass(s.trailingEra)}">${fmtNum(s.trailingEra)} ERA</span><br>
          Season: ${fmtNum(s.seasonEra)} ERA
        </div>
      </div>`;

    const metaPills = [];
    if (d.homeMl !== null) metaPills.push(`<span class="pill info"><span class="pill-dot"></span>${esc(TEAMS[home.name]?.abbrev || 'HOME')} ${fmtOdds(d.homeMl)} / ${esc(TEAMS[away.name]?.abbrev || 'AWAY')} ${fmtOdds(d.awayMl)}</span>`);
    if (d.windBlowingOut === true) metaPills.push(`<span class="pill hot"><span class="pill-dot"></span>Wind blowing out ${fmtNum(d.windSpeedMph, 1)} mph</span>`);
    else if (d.windSpeedMph !== null) metaPills.push(`<span class="pill dim">Wind ${fmtNum(d.windSpeedMph, 1)} mph</span>`);

    const luMeta = (posted, teamName) => {
      const db = slateGame?.lineups;
      const which = teamName === home.name ? db?.home : db?.away;
      return lineupPill(posted ? true : false, which?.confirmedAt);
    };

    inner.innerHTML = `
      <button class="gp-close" id="gpClose" aria-label="Close">×</button>
      <div class="gp-matchup">
        <div class="gp-side">
          ${logoHtml(away.id, away.name, 62)}
          <div class="nm">${esc(away.name || 'Away')}</div>
          <div class="rec">${esc(slateGame?.away?.record || '')}</div>
          ${started ? `<div class="gp-score">${slateGame?.away?.score ?? ''}</div>` : ''}
        </div>
        <div class="gp-at">${started ? esc(statusLabel(slateGame).text) : 'at'}</div>
        <div class="gp-side">
          ${logoHtml(home.id, home.name, 62)}
          <div class="nm">${esc(home.name || 'Home')}</div>
          <div class="rec">${esc(slateGame?.home?.record || '')}</div>
          ${started ? `<div class="gp-score">${slateGame?.home?.score ?? ''}</div>` : ''}
        </div>
      </div>
      <div class="gp-when">${esc(longDate(date))}${slateGame && !started ? ` · ${esc(etTime(slateGame.gameDate))}` : ''}${d.venue ? ` · ${esc(d.venue)}` : ''}</div>
      ${metaPills.length ? `<div class="gp-meta">${metaPills.join('')}</div>` : ''}

      <div class="gp-block">
        <div class="gp-block-title">Probable starters</div>
        <div class="gp-starters">
          ${starterBox('Away', d.awayStarter)}
          ${starterBox('Home', d.homeStarter)}
        </div>
      </div>

      <div class="gp-block">
        <div class="gp-block-title">${esc(away.name || 'Away')} lineup</div>
        <div style="margin-bottom:10px">${luMeta(d.away.posted, away.name)}</div>
        ${lineupRows(d.away)}
      </div>

      <div class="gp-block">
        <div class="gp-block-title">${esc(home.name || 'Home')} lineup</div>
        <div style="margin-bottom:10px">${luMeta(d.home.posted, home.name)}</div>
        ${lineupRows(d.home)}
      </div>`;
    $('#gpClose').addEventListener('click', closeGamePanel);
  } catch (err) {
    inner.innerHTML = `<button class="gp-close" id="gpClose" aria-label="Close">×</button>${emptyHtml('Detail unavailable', err.message)}`;
    $('#gpClose').addEventListener('click', closeGamePanel);
  }
}

function closeGamePanel() {
  $('#gamePanel').classList.remove('open');
  $('#panelOverlay').classList.remove('open');
  $('#gamePanel').setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------------------
// BET TRACKING — "Track" buttons carry a prefill payload by id so no JSON
// ends up in HTML attributes.
let trackSeq = 0;
const trackData = new Map();
function trackBtn(prefill, label = 'Track bet') {
  const id = ++trackSeq;
  trackData.set(id, prefill);
  return `<button class="btn-track" data-track="${id}">${label}</button>`;
}

function openBetModal(prefill = {}) {
  const modal = $('#betModal');
  const form = $('#betForm');
  form.dataset.betKind = prefill.betKind || 'manual';
  form.dataset.mlbGameId = prefill.mlbGameId || '';
  form.dataset.batterId = prefill.batterId || '';
  $('#betModalTitle').textContent = prefill.description ? 'Track this bet' : 'Add a bet';
  $('#betDesc').value = prefill.description || '';
  $('#betOdds').value = prefill.odds !== null && prefill.odds !== undefined ? String(prefill.odds) : '';
  $('#betStake').value = state.lastStake || '';
  $('#betBook').value = state.lastBook || '';
  $('#betDate').value = prefill.gameDate || state.today;
  $('#betError').hidden = true;
  $('#betHint').hidden = true;
  $('#betSave').disabled = false;
  modal.hidden = false;
  (prefill.description ? $('#betStake') : $('#betDesc')).focus();
}

function closeBetModal() { $('#betModal').hidden = true; }

async function submitBet(e) {
  e.preventDefault();
  const form = $('#betForm');
  const oddsRaw = $('#betOdds').value.trim().replace(/^\+/, '');
  const payload = {
    description: $('#betDesc').value.trim(),
    odds: oddsRaw === '' ? null : Number(oddsRaw),
    stake: Number($('#betStake').value),
    book: $('#betBook').value.trim() || null,
    gameDate: $('#betDate').value,
    betKind: form.dataset.betKind,
    mlbGameId: form.dataset.mlbGameId || null,
    batterId: form.dataset.batterId ? Number(form.dataset.batterId) : null,
  };
  const err = $('#betError');
  try {
    $('#betSave').disabled = true;
    await apiSend('/api/bets', 'POST', payload);
    state.lastStake = $('#betStake').value;
    state.lastBook = $('#betBook').value.trim();
    const hint = $('#betHint');
    hint.textContent = 'Saved to My Bets.';
    hint.hidden = false;
    setTimeout(() => {
      closeBetModal();
      if (state.view === 'bets') renderBets();
    }, 550);
  } catch (ex) {
    $('#betSave').disabled = false;
    err.textContent = ex.message;
    err.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// MY BETS VIEW
function resultPill(result) {
  const label = result.charAt(0).toUpperCase() + result.slice(1);
  return `<span class="result-pill ${esc(result)}">${esc(label)}</span>`;
}

function betRow(b) {
  const actions = [];
  if (b.result === 'pending') {
    actions.push(`
      <span class="settle-group">
        <button class="btn-mini w" data-settle="win" data-bet="${b.id}" title="Mark won">W</button>
        <button class="btn-mini l" data-settle="loss" data-bet="${b.id}" title="Mark lost">L</button>
        <button class="btn-mini" data-settle="push" data-bet="${b.id}" title="Mark push">P</button>
      </span>`);
  } else {
    actions.push(`<button class="btn-mini" data-reopen="${b.id}" title="Undo and mark pending again">Undo</button>`);
  }
  actions.push(`<button class="btn-mini x" data-del="${b.id}" title="Delete bet">×</button>`);

  const autoTag = b.betKind !== 'manual' && b.result === 'pending' ? '<span class="auto-tag">auto-settles</span>' : '';
  const profitCell = b.result === 'pending'
    ? '<span class="faint">—</span>'
    : `<span class="${(b.profit ?? 0) > 0 ? 'profit-pos' : (b.profit ?? 0) < 0 ? 'profit-neg' : 'dim'}">${fmtMoney(b.profit, true)}</span>`;

  return `
    <tr>
      <td class="mono faint" style="white-space:nowrap">${esc(b.gameDate)}</td>
      <td><div class="bet-desc">${esc(b.description)}${autoTag}${b.book ? `<div class="bk">${esc(b.book)}</div>` : ''}</div></td>
      <td class="mono">${b.odds !== null ? fmtOdds(b.odds) : '—'}</td>
      <td class="mono">${fmtMoney(b.stake)}</td>
      <td>${b.result === 'pending' ? resultPill('pending') : resultPill(b.result)}</td>
      <td class="mono">${profitCell}</td>
      <td style="white-space:nowrap;text-align:right">${actions.join(' ')}</td>
    </tr>`;
}

async function renderBets() {
  const host = $('#view-bets');
  host.innerHTML = loadingHtml;
  try {
    const d = await api('/api/bets');
    const s = d.summary;
    const profitCls = s.profit > 0 ? 'profit-pos' : s.profit < 0 ? 'profit-neg' : '';

    host.innerHTML = `
      <div class="bets-toolbar">
        <button class="btn primary" id="addBetBtn">Add a bet</button>
        <button class="btn" id="gradeBetsBtn" ${s.pending ? '' : 'disabled'}>Check results</button>
        <span class="spacer"></span>
        <span class="toolbar-note">Bets tracked from a pick settle themselves once the game is final.</span>
      </div>

      <div class="stat-tiles">
        <div class="stat-tile">
          <div class="st-label">Profit</div>
          <div class="st-value ${profitCls}">${fmtMoney(s.profit, true)}</div>
          <div class="st-sub">${fmtMoney(s.staked)} staked on settled bets</div>
        </div>
        <div class="stat-tile">
          <div class="st-label">Record</div>
          <div class="st-value">${s.wins}<span class="unit">W</span> ${s.losses}<span class="unit">L</span>${s.pushes ? ` ${s.pushes}<span class="unit">P</span>` : ''}</div>
          <div class="st-sub">${s.wins + s.losses + s.pushes} settled</div>
        </div>
        <div class="stat-tile">
          <div class="st-label">Return on stake</div>
          <div class="st-value ${profitCls}">${s.roi !== null ? (s.roi * 100).toFixed(1) : '—'}<span class="unit">%</span></div>
          <div class="st-sub">Profit divided by total staked</div>
        </div>
        <div class="stat-tile">
          <div class="st-label">Pending</div>
          <div class="st-value">${s.pending}</div>
          <div class="st-sub">Waiting on results</div>
        </div>
      </div>

      <div class="section-head"><h2 class="section-title">All bets</h2></div>
      ${d.bets.length
        ? `<div class="table-wrap"><table class="data-table">
            <thead><tr><th>Date</th><th>Bet</th><th>Odds</th><th>Stake</th><th>Result</th><th>Profit</th><th></th></tr></thead>
            <tbody>${d.bets.map(betRow).join('')}</tbody>
          </table></div>`
        : emptyHtml('No bets yet', 'Hit "Track bet" on any pick in Signals, or add one manually with the button above.')}`;

    $('#addBetBtn').addEventListener('click', () => openBetModal());
    $('#gradeBetsBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await apiSend('/api/bets/grade', 'POST');
        await renderBets();
        if (!r.graded) {
          const note = $('#view-bets .toolbar-note');
          if (note) note.textContent = 'No finished games to settle yet — check back after tonight’s games.';
        }
      } catch (ex) {
        btn.disabled = false;
        btn.textContent = 'Check results';
      }
    });

    host.querySelectorAll('[data-settle]').forEach((btn) => btn.addEventListener('click', async () => {
      await apiSend(`/api/bets/${btn.dataset.bet}/settle`, 'POST', { result: btn.dataset.settle });
      renderBets();
    }));
    host.querySelectorAll('[data-reopen]').forEach((btn) => btn.addEventListener('click', async () => {
      await apiSend(`/api/bets/${btn.dataset.reopen}/reopen`, 'POST');
      renderBets();
    }));
    host.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Delete this bet?')) return;
      await apiSend(`/api/bets/${btn.dataset.del}`, 'DELETE');
      renderBets();
    }));
  } catch (err) {
    host.innerHTML = emptyHtml('Bets unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// SIGNALS VIEW
function pickPrefill(p) {
  const gameDate = state.signalsDate || state.today;
  const kind = { moneyline: 'moneyline_home', hit_streak: 'batter_hit', wind_hr: 'batter_hr' }[p.type] || 'manual';
  return {
    description: p.headline,
    odds: p.odds ?? null,
    betKind: kind,
    mlbGameId: p.mlbGameId || null,
    batterId: p.batterId || null,
    gameDate,
  };
}

function topPickCard(p, i) {
  const typeLabel = { moneyline: 'Moneyline', hit_streak: 'Hot hitter', wind_hr: 'Home run weather' }[p.type] || p.type;
  const foot = [];
  foot.push(trackBtn(pickPrefill(p)));
  if (p.lineupConfirmed === true) foot.push(lineupPill(true, null));
  if (p.lineupConfirmed === false) foot.push(lineupPill(false, null));
  if (p.last5Results) foot.push(`<span class="pill dim">Last 5 ${form5Html(p.last5Results)}</span>`);
  return `
    <div class="tp-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><span class="tp-rank">${i + 1}</span><div class="tp-type">${esc(typeLabel)}</div></div>
        ${p.batterId ? headshotHtml(p.batterId, p.headline) : p.homeTeam ? logoHtml(null, p.homeTeam, 38) : ''}
      </div>
      <div class="tp-head">${esc(p.headline)}</div>
      <div class="tp-detail">${esc(p.detail)}</div>
      ${foot.length ? `<div class="tp-foot">${foot.join('')}</div>` : ''}
    </div>`;
}

function playerCell(b) {
  return `
    <div class="player-cell">
      ${headshotHtml(b.batterId, b.batterName)}
      <div>
        <div class="player-nm">${esc(b.batterName)}</div>
        <div class="player-meta">
          ${b.jerseyNumber ? `<span class="jersey">#${esc(b.jerseyNumber)}</span>` : ''}
          ${b.position ? `<span>${esc(b.position)}</span>` : ''}
          <span>${esc(TEAMS[b.team]?.abbrev || b.team)}</span>
        </div>
      </div>
    </div>`;
}

function moneylineCards(ml) {
  if (ml.signal === 'SIT' || !ml.picks?.length) {
    return emptyHtml('SIT — no qualifying games', 'No matchup today pairs a modest home favorite with a struggling opposing starter. The nearest misses are listed below.');
  }
  return `<div class="sig-cards">${ml.picks.map((p) => `
    <div class="sig-card">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam)}</span>
        <span class="sig-odds">${fmtOdds(p.homeMl)}</span>
      </div>
      <div class="sig-sub">To beat ${esc(p.awayTeam)}. ${esc(p.awayStarterName ?? 'Their starter')} carries a <strong>${fmtNum(p.awayStarterTrailingEra)} ERA over his last 3 starts</strong> (season ${fmtNum(p.awayStarterSeasonEra)}).</div>
      <div class="sig-note">Needs to win ${p.breakevenPct !== null && p.breakevenPct !== undefined ? (p.breakevenPct * 100).toFixed(1) + '%' : '—'} of the time at ${fmtOdds(p.homeMl)} just to break even — not a prediction it will.</div>
      <div style="margin-top:10px">${trackBtn(pickPrefill({ type: 'moneyline', headline: `${p.homeTeam} ML (${fmtOdds(p.homeMl)}) vs ${p.awayTeam}`, odds: p.homeMl, mlbGameId: p.mlbGameId }))}</div>
    </div>`).join('')}</div>`;
}

function nearMissCards(otherGames) {
  if (!otherGames?.length) return '';
  return `
    <p class="section-sub" style="margin-top:18px">Close calls — evaluated but did not qualify:</p>
    <div class="sig-cards">${otherGames.map((g) => `
      <div class="sig-card miss">
        <div class="sig-head">
          <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, g.homeTeam, 26)} ${esc(g.awayTeam)} at ${esc(g.homeTeam)}</span>
          <span class="sig-odds dim mono">${fmtOdds(g.homeMl)}</span>
        </div>
        <div class="sig-sub">${esc(g.reason)}</div>
      </div>`).join('')}</div>`;
}

function digestWarningBanner(warnings) {
  if (!warnings?.length) return '';
  const items = warnings.map((w) => `<li>${esc(w)}</li>`).join('');
  return `
    <div class="digest-warning">
      <span class="dot"></span>
      <div>
        <strong>${warnings.length} issue${warnings.length === 1 ? '' : 's'} while building this slate</strong>
        <ul>${items}</ul>
      </div>
    </div>`;
}

function batterTable(rows, cols) {
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

function hitStreakSection(hs) {
  if (!hs.watchList?.length) return emptyHtml('No qualifying batters', 'Nobody clears the bar today: a 5+ game hit streak or a .320+ average over the last 15 games.');
  const rows = hs.watchList.map((b) => `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td>${playerCell(b)}</td>
      <td><span class="mono">${b.hitStreak >= 5 ? `${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)}`}</span><div class="faint" style="font-size:11px;margin-top:2px">${fmtNum(b.trailing15Avg, 3)} avg last 15</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : 'pos'}" style="font-size:11px;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA last 3</div>` : ''}</td>
      <td>${lineupPill(b.lineupConfirmed, null)}${b.highConfidence ? '<div style="margin-top:4px"><span class="pill info"><span class="pill-dot"></span>Prime matchup</span></div>' : ''}</td>
      <td style="text-align:right">${trackBtn(pickPrefill({ type: 'hit_streak', headline: `${b.batterName} to record a hit`, mlbGameId: b.mlbGameId, batterId: b.batterId }))}</td>
    </tr>`);
  return batterTable(rows, ['Hitter', 'Form', 'Last 5', 'Opposing starter', 'Status', '']);
}

function windHrSection(wh) {
  if (!wh.watchList?.length) return emptyHtml('No qualifying conditions', 'No park has 10+ mph wind blowing out today, or no power hitters cleared the top-third HR-rate bar.');
  const rows = wh.watchList.map((b) => `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td>${playerCell(b)}</td>
      <td><span class="mono">${fmtNum(b.trailing15HrRate, 2)}</span><div class="faint" style="font-size:11px;margin-top:2px">HR per game, last 15</div></td>
      <td>${esc(b.venue ?? '')}<div class="faint" style="font-size:11px;margin-top:2px">Wind out ${fmtNum(b.windSpeedMph, 1)} mph</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : 'pos'}" style="font-size:11px;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA last 3</div>` : ''}</td>
      <td>${lineupPill(b.lineupConfirmed, null)}</td>
      <td style="text-align:right">${trackBtn(pickPrefill({ type: 'wind_hr', headline: `${b.batterName} to hit a home run`, mlbGameId: b.mlbGameId, batterId: b.batterId }))}</td>
    </tr>`);
  return batterTable(rows, ['Power hitter', 'HR rate', 'Park + wind', 'Last 5', 'Opposing starter', 'Status', '']);
}

async function renderSignals() {
  const host = $('#view-signals');
  host.innerHTML = loadingHtml;
  try {
    const date = state.signalsDate || state.today;
    const d = await api(`/api/digest?date=${date}`);
    state.signalsDate = d.date;
    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    host.innerHTML = `
      <div class="signals-toolbar">
        <select class="date-select" id="signalsDate">${dateOptions}</select>
        <span class="toolbar-note">Signals for ${esc(longDate(d.date))}</span>
      </div>

      ${digestWarningBanner(d.warnings)}

      <div class="section-head"><h2 class="section-title">Top 3 picks</h2></div>
      <p class="section-sub">The day's strongest signals, ranked across all three categories. Scored by a simple, transparent heuristic — not a statistical model.</p>
      ${d.topPicks?.length ? `<div class="top-picks">${d.topPicks.map(topPickCard).join('')}</div>` : emptyHtml('Nothing today', 'No signal cleared its bar today, so nothing rose to the top.')}

      <div class="section-head"><h2 class="section-title">Moneyline</h2></div>
      <p class="section-sub">Home teams favored between -130 and -180 facing a visiting starter with a 6.00+ ERA over his last three starts.</p>
      ${moneylineCards(d.moneyline)}
      ${nearMissCards(d.moneyline.otherGames)}

      <div class="section-head"><h2 class="section-title">Hot hitters</h2></div>
      <p class="section-sub">Hitters riding a 5+ game hit streak or batting .320+ over their last 15 games. Prime matchup means the opposing starter is struggling too.</p>
      ${hitStreakSection(d.hitStreak)}

      <div class="section-head"><h2 class="section-title">Home run weather</h2></div>
      <p class="section-sub">Parks where the wind is blowing out at 10+ mph, crossed with the top third of today's hitters by recent home-run rate.</p>
      ${windHrSection(d.windHr)}`;

    $('#signalsDate').addEventListener('change', (e) => {
      state.signalsDate = e.target.value;
      renderSignals();
    });
  } catch (err) {
    host.innerHTML = emptyHtml('Signals unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// PERFORMANCE VIEW
const SIGNAL_NAMES = { moneyline: 'Moneyline', hit_streak: 'Hot hitters', wind_hr: 'HR weather' };

async function renderPerformance() {
  const host = $('#view-performance');
  host.innerHTML = loadingHtml;
  try {
    const d = await api('/api/performance');
    const tiles = d.summary.length ? d.summary.map((s) => {
      const wr = s.winRate !== null ? (s.winRate * 100).toFixed(1) : null;
      const edge = s.winRate !== null && s.avgBreakeven !== null ? ((s.winRate - s.avgBreakeven) * 100) : null;
      return `
        <div class="stat-tile">
          <div class="st-label">${esc(SIGNAL_NAMES[s.signalType] || s.signalType)}</div>
          <div class="st-value">${wr !== null ? `${wr}<span class="unit">%</span>` : '—'}</div>
          <div class="st-sub">${s.wins}W / ${s.losses}L${s.pushes ? ` / ${s.pushes} push` : ''} · ${s.pending} pending${
            edge !== null ? `<br>Edge vs break-even: <span class="${edge >= 0 ? 'pos' : 'neg'} mono">${edge >= 0 ? '+' : ''}${edge.toFixed(1)} pts</span>` : ''
          }${s.graded > 0 && s.graded < 20 ? `<br><span class="faint">Only ${s.graded} graded — too small a sample to mean anything yet.</span>` : ''}</div>
        </div>`;
    }).join('') : '';

    const recentRows = d.recent.map((r) => `
      <tr>
        <td class="mono faint" style="white-space:nowrap">${esc(r.gameDate)}</td>
        <td><span class="pill dim">${esc(SIGNAL_NAMES[r.signalType] || r.signalType)}</span></td>
        <td>${esc(r.description)}</td>
        <td class="mono">${r.lockedPrice !== null ? fmtOdds(r.lockedPrice) : '—'}</td>
        <td><span class="result-pill ${esc(r.result)}">${esc(r.result.charAt(0).toUpperCase() + r.result.slice(1))}</span></td>
      </tr>`);

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">How the signals have done</h2></div>
      <p class="section-sub">Every qualifying pick is recorded the first time it appears each day, then graded against real results. A signal only means something once its win rate beats the break-even rate implied by the price.</p>
      ${tiles ? `<div class="stat-tiles">${tiles}</div>` : emptyHtml('No picks tracked yet', 'Picks accumulate automatically as the daily refresh finds qualifying signals.')}

      <div class="section-head"><h2 class="section-title">Recent picks</h2></div>
      ${d.recent.length ? batterTable(recentRows, ['Date', 'Signal', 'Pick', 'Price', 'Result']) : emptyHtml('Nothing recorded yet', 'Recent picks will appear here as the pipeline runs.')}`;
  } catch (err) {
    host.innerHTML = emptyHtml('Performance unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// STATUS + REFRESH
let statusTimer = null;
async function pollStatus(fast = false) {
  clearTimeout(statusTimer);
  try {
    const s = await api('/api/status');
    if (s.today && s.today !== state.today) {
      state.today = s.today;
    }
    const dot = $('#statusDot');
    const txt = $('#statusText');
    const btn = $('#refreshBtn');
    if (s.isRefreshing) {
      dot.className = 'pulse-dot busy';
      const secs = s.refreshStartedAt ? Math.round((Date.now() - new Date(s.refreshStartedAt).getTime()) / 1000) : 0;
      txt.textContent = `Refreshing (${secs}s)`;
      btn.disabled = true;
      btn.classList.add('spinning');
      statusTimer = setTimeout(() => pollStatus(true), 2500);
      return;
    }
    btn.disabled = false;
    btn.classList.remove('spinning');
    if (fast) {
      // A sync just finished — drop caches and re-render the active view.
      state.slateCache.clear();
      showView(state.view, true);
    }
    if (s.lastRunError) {
      dot.className = 'pulse-dot err';
      txt.textContent = 'Last refresh failed';
      txt.title = s.lastRunError;
    } else if (s.lastRunWarnings && s.lastRunWarnings.length) {
      dot.className = 'pulse-dot warn';
      txt.textContent = `Updated with ${s.lastRunWarnings.length} warning${s.lastRunWarnings.length === 1 ? '' : 's'}`;
      txt.title = s.lastRunWarnings.join('\n');
    } else if (s.lastRunAt) {
      dot.className = 'pulse-dot';
      txt.textContent = `Updated ${new Date(s.lastRunAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      txt.title = '';
    } else {
      dot.className = 'pulse-dot';
      txt.textContent = 'Online';
    }
    statusTimer = setTimeout(() => pollStatus(false), 60000);
  } catch {
    $('#statusDot').className = 'pulse-dot err';
    $('#statusText').textContent = 'Offline';
    statusTimer = setTimeout(() => pollStatus(false), 10000);
  }
}

// ---------------------------------------------------------------------------
// NAV
function showView(name, force = false) {
  if (state.view === name && !force) return;
  state.view = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'slate') { renderSlateShell(); loadSlateGames(); }
  if (name === 'signals') renderSignals();
  if (name === 'bets') renderBets();
  if (name === 'performance') renderPerformance();
}

async function init() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });
  $('#panelOverlay').addEventListener('click', closeGamePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeGamePanel();
      closeBetModal();
    }
  });

  // Bet modal wiring + delegated "Track bet" buttons.
  $('#betForm').addEventListener('submit', submitBet);
  $('#betCancel').addEventListener('click', closeBetModal);
  $('#betModal').addEventListener('click', (e) => { if (e.target === $('#betModal')) closeBetModal(); });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-track]');
    if (!btn) return;
    const prefill = trackData.get(Number(btn.dataset.track));
    if (prefill) openBetModal(prefill);
  });

  // Newsletter signup.
  $('#subscribeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await apiSend('/api/subscribe', 'POST', { email: $('#subscribeEmail').value });
      form.innerHTML = '<span class="subscribe-done">You are on the list — first email goes out with the next morning digest.</span>';
    } catch (ex) {
      let err = form.querySelector('.subscribe-err');
      if (!err) {
        err = document.createElement('span');
        err.className = 'subscribe-err';
        err.style.cssText = 'color:var(--red);font-size:12px;width:100%;text-align:center';
        form.appendChild(err);
      }
      err.textContent = ex.message;
    }
  });
  $('#refreshBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/refresh', { method: 'POST' });
      pollStatus(true);
    } catch { /* status poll will surface it */ }
  });

  // Anchor "today" to the server's pipeline date before first render so the
  // 10-day window matches what the backend considers today.
  try {
    const s = await api('/api/status');
    if (s.today) state.today = s.today;
  } catch { /* fall back to client clock */ }

  state.slateDate = state.today;
  renderSlateShell();
  loadSlateGames();
  pollStatus();
}

init();

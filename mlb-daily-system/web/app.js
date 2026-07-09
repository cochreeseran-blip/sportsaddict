/* SlateFinder client, vanilla JS single-page app, no build step.
   Views: Slate (today's games), Signals (daily edge digest), Performance
   (tracked pick ledger). All data comes from this server's /api/*
   endpoints; logos and headshots load from MLB's public CDN. */

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
  view: 'signals',
  signalsDate: null,
  slateDate: null,
  slateCache: new Map(),
  user: null,
};

// ---------------------------------------------------------------------------
// Procedural avatars: every account gets a face built from its seed. Same
// seed, same face, no image hosting. Deliberately goofy - mismatched
// googly eyes, mustaches, backwards caps.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function avatarSvg(seed, size = 34) {
  const rnd = mulberry32(Number(seed) || 1);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const bg = pick(['#2b6cb0', '#b83280', '#2f855a', '#b7791f', '#6b46c1', '#c53030', '#2c7a7b', '#975a16']);
  const skin = pick(['#f6c99f', '#e8a06d', '#c68642', '#8d5524', '#9ae6b4', '#90cdf4', '#fbb6ce', '#d6bcfa']);
  const capColor = pick(['#1a202c', '#c53030', '#2b6cb0', '#2f855a', '#d69e2e', '#553c9a']);
  const eyeStyle = pick(['dots', 'googly', 'sleepy', 'wide']);
  const mouth = pick(['grin', 'flat', 'shock', 'smirk']);
  const hasStache = rnd() < 0.35;
  const hasShades = !hasStache && rnd() < 0.25;
  const capStyle = pick(['cap', 'cap', 'backwards', 'none']);
  const eyeBlack = rnd() < 0.3;

  const parts = [];
  parts.push(`<rect width="64" height="64" rx="14" fill="${bg}"/>`);
  parts.push(`<circle cx="32" cy="36" r="20" fill="${skin}"/>`);

  if (eyeBlack) {
    parts.push('<rect x="20" y="38" width="7" height="3.5" rx="1" fill="#1a202c" opacity="0.85"/>');
    parts.push('<rect x="37" y="38" width="7" height="3.5" rx="1" fill="#1a202c" opacity="0.85"/>');
  }

  if (hasShades) {
    parts.push('<rect x="18" y="28" width="12" height="8" rx="2.5" fill="#1a202c"/><rect x="34" y="28" width="12" height="8" rx="2.5" fill="#1a202c"/><rect x="29" y="30" width="6" height="2.4" fill="#1a202c"/>');
  } else if (eyeStyle === 'googly') {
    const r1 = 4 + rnd() * 2.4;
    const r2 = 4 + rnd() * 2.4;
    parts.push(`<circle cx="24" cy="32" r="${r1.toFixed(1)}" fill="#fff"/><circle cx="${(24 + rnd() * 3 - 1.5).toFixed(1)}" cy="${(32 + rnd() * 3 - 1.5).toFixed(1)}" r="2" fill="#111"/>`);
    parts.push(`<circle cx="40" cy="32" r="${r2.toFixed(1)}" fill="#fff"/><circle cx="${(40 + rnd() * 3 - 1.5).toFixed(1)}" cy="${(32 + rnd() * 3 - 1.5).toFixed(1)}" r="2" fill="#111"/>`);
  } else if (eyeStyle === 'sleepy') {
    parts.push('<path d="M20 32 q4 3 8 0" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M36 32 q4 3 8 0" stroke="#111" stroke-width="2" fill="none" stroke-linecap="round"/>');
  } else if (eyeStyle === 'wide') {
    parts.push('<circle cx="24" cy="32" r="3.4" fill="#fff"/><circle cx="24" cy="32" r="1.6" fill="#111"/><circle cx="40" cy="32" r="3.4" fill="#fff"/><circle cx="40" cy="32" r="1.6" fill="#111"/>');
  } else {
    parts.push('<circle cx="24" cy="32" r="2.2" fill="#111"/><circle cx="40" cy="32" r="2.2" fill="#111"/>');
  }

  if (hasStache) {
    parts.push('<path d="M22 43 q5 -4 10 0 q5 -4 10 0 q-5 5 -10 2 q-5 3 -10 -2" fill="#2d3748"/>');
  }
  if (mouth === 'grin') {
    parts.push(`<path d="M24 ${hasStache ? 49 : 45} q8 7 16 0" stroke="#7b341e" stroke-width="2.4" fill="none" stroke-linecap="round"/>`);
  } else if (mouth === 'flat') {
    parts.push(`<path d="M26 ${hasStache ? 49 : 46} h12" stroke="#7b341e" stroke-width="2.4" stroke-linecap="round"/>`);
  } else if (mouth === 'shock') {
    parts.push(`<ellipse cx="32" cy="${hasStache ? 50 : 47}" rx="4" ry="5" fill="#7b341e"/>`);
  } else {
    parts.push(`<path d="M27 ${hasStache ? 49 : 46} q6 4 11 -2" stroke="#7b341e" stroke-width="2.4" fill="none" stroke-linecap="round"/>`);
  }

  if (capStyle === 'cap') {
    parts.push(`<path d="M14 26 a18 16 0 0 1 36 0 z" fill="${capColor}"/><rect x="10" y="24" width="26" height="4.5" rx="2.2" fill="${capColor}"/>`);
  } else if (capStyle === 'backwards') {
    parts.push(`<path d="M14 26 a18 16 0 0 1 36 0 z" fill="${capColor}"/><rect x="40" y="23" width="13" height="5" rx="2.5" fill="${capColor}"/><circle cx="32" cy="14" r="2.2" fill="${capColor}" stroke="#fff" stroke-width="0.8"/>`);
  }

  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" style="border-radius:${Math.round(size * 0.22)}px;display:block" aria-hidden="true">${parts.join('')}</svg>`;
}

// --- tiny helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdds = (ml) => (ml === null || ml === undefined ? '-' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));

function longDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
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
function fmtRunTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}

// Image fallbacks use a delegated capture-phase error listener (see
// init) instead of inline onerror handlers, the CSP forbids inline
// script, and that's the point: no inline JS anywhere in this app.
function logoHtml(teamId, teamName, size = 34) {
  const id = teamId ?? TEAMS[teamName]?.id ?? null;
  const abbrev = TEAMS[teamName]?.abbrev ?? (teamName || '?').slice(0, 3).toUpperCase();
  if (!id) return `<span class="gc-logo-fallback" style="width:${size}px;height:${size}px">${esc(abbrev)}</span>`;
  return `<img class="gc-logo" style="width:${size}px;height:${size}px" loading="lazy" alt="${esc(teamName || '')} logo"
    data-fb="${esc(abbrev)}" data-fb-class="gc-logo-fallback"
    src="https://www.mlbstatic.com/team-logos/${id}.svg">`;
}

function headshotHtml(personId, name) {
  const initials = (name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (!personId) return `<span class="headshot-fallback">${esc(initials)}</span>`;
  return `<img class="headshot" loading="lazy" alt=""
    data-fb="${esc(initials)}" data-fb-class="headshot-fallback"
    src="https://img.mlbstatic.com/mlb-photos/image/upload/w_96,q_auto/v1/people/${personId}/headshot/67/current">`;
}

function form5Html(results) {
  if (!results || !results.length) return '<span class="faint" style="font-size:11px">-</span>';
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

// ---------------------------------------------------------------------------
// Estimated cash probabilities for the board. These are simple, honest
// estimates from recent form, labeled "est" in the UI, never presented as
// odds. Hit: chance of 1+ hit in ~4 at-bats at his last-15 average.
// HR: his own last-15 HR-per-game rate. K over: recent-start hit rate with
// Laplace smoothing so 5-for-5 doesn't read as 100%. ML: the market's own
// implied probability from the price.
function estHitProb(avg15) {
  if (avg15 === null || avg15 === undefined) return null;
  return Math.max(0.05, Math.min(0.97, 1 - Math.pow(1 - avg15, 4)));
}
function estHrProb(hrRate15) {
  if (hrRate15 === null || hrRate15 === undefined) return null;
  return Math.max(0.02, Math.min(0.75, hrRate15));
}
function estKOverProb(last5Ks, floor) {
  if (!last5Ks?.length) return null;
  const over = last5Ks.filter((k) => k >= floor).length;
  return (over + 1) / (last5Ks.length + 2);
}
function probChip(p, label = 'est') {
  if (p === null || p === undefined) return '';
  const pct = Math.round(p * 100);
  const tier = pct >= 70 ? 'hot' : pct >= 50 ? 'warm' : 'cool';
  return `<span class="prob-chip ${tier}"><b>${pct}%</b><i>${label}</i></span>`;
}

const loadingHtml = '<div class="loading"><span class="spinner"></span>Loading</div>';
function emptyHtml(title, msg) {
  return `<div class="empty-state"><div class="es-title">${esc(title)}</div>${esc(msg)}</div>`;
}

// ---------------------------------------------------------------------------
// SLATE VIEW, today's games only. Open a game for lineups, batting order,
// and pitcher form.
function dateStripHtml() {
  const date = state.slateDate || state.today;
  const days = [
    { d: addDays(state.today, -1), label: 'Yesterday' },
    { d: state.today, label: 'Today' },
    { d: addDays(state.today, 1), label: 'Tomorrow' },
  ];
  return `<div class="date-strip" id="slateDateStrip">${days.map((x) => `
    <button type="button" class="date-strip-btn ${x.d === date ? 'active' : ''}" data-date="${x.d}">
      <span class="ds-label">${x.label}</span>
      <span class="ds-date">${new Date(`${x.d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
    </button>`).join('')}</div>`;
}

function renderSlateShell() {
  const date = state.slateDate || state.today;
  $('#view-slate').innerHTML = `
    <div class="section-head"><h2 class="section-title">Slate</h2></div>
    ${dateStripHtml()}
    <p class="section-sub">${esc(longDate(date))}</p>
    <div id="slateGames">${loadingHtml}</div>`;
  $('#slateDateStrip').querySelectorAll('.date-strip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.slateDate = btn.dataset.date;
      renderSlateShell();
      loadSlateGames();
    });
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
        ? `<span class="gc-score ${winner ? 'winner' : ''}">${t.score ?? '-'}</span>`
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
  const date = state.slateDate || state.today;
  host.innerHTML = loadingHtml;
  try {
    let slate = state.slateCache.get(date);
    if (!slate) {
      slate = await api(`/api/slate?date=${encodeURIComponent(date)}`);
      state.slateCache.set(date, slate);
      // Today's games are live, don't let the cache go stale.
      setTimeout(() => state.slateCache.delete(date), 120000);
    }
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
        <div class="lu-stat"><div class="v">${b.hitStreak ?? '-'}</div><div class="k">Streak</div></div>
        <div class="lu-stat"><div class="v">${b.trailing15Avg !== null && b.trailing15Avg !== undefined ? fmtNum(b.trailing15Avg, 3) : '-'}</div><div class="k">L15 avg</div></div>
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
// MANUAL MONEYLINE PICKS
// A direct publish path: add a pick you researched yourself without
// waiting on or depending on the automated odds/schedule pipeline.
function openManualPickModal() {
  const modal = $('#manualPickModal');
  $('#mpHomeTeam').value = '';
  $('#mpAwayTeam').value = '';
  $('#mpHomeMl').value = '';
  $('#mpDate').value = state.signalsDate || state.today;
  $('#mpReason').value = '';
  $('#mpError').hidden = true;
  $('#mpHint').hidden = true;
  $('#mpSave').disabled = false;
  modal.hidden = false;
  $('#mpHomeTeam').focus();
}

function closeManualPickModal() { $('#manualPickModal').hidden = true; }

async function submitManualPick(e) {
  e.preventDefault();
  const oddsRaw = $('#mpHomeMl').value.trim().replace(/^\+/, '');
  const payload = {
    homeTeam: $('#mpHomeTeam').value.trim(),
    awayTeam: $('#mpAwayTeam').value.trim(),
    homeMl: Number(oddsRaw),
    gameDate: $('#mpDate').value,
    reason: $('#mpReason').value.trim() || null,
  };
  const err = $('#mpError');
  try {
    $('#mpSave').disabled = true;
    await apiSend('/api/manual-picks', 'POST', payload);
    const hint = $('#mpHint');
    hint.textContent = 'Added to the Moneyline section.';
    hint.hidden = false;
    setTimeout(() => {
      closeManualPickModal();
      if (state.view === 'signals') renderSignals();
    }, 550);
  } catch (ex) {
    $('#mpSave').disabled = false;
    err.textContent = ex.message;
    err.hidden = false;
  }
}

async function deleteManualPick(id) {
  if (!confirm('Remove this manual pick?')) return;
  await apiSend(`/api/manual-picks/${id}`, 'DELETE');
  renderSignals();
}

// ---------------------------------------------------------------------------
// TRACKING VIEW: Slatefinder's own daily top picks (see lib/topPicks.js,
// the 3-5 "we believe this is gonna hit" calls that headline Daily
// Slate), grouped by game with a tick mark (win/loss/push/pending) so the
// track record reads at a glance. This is our own call, not a personal
// wager ledger, for that you've already got a sportsbook app.
const SIGNAL_NAMES = { moneyline: 'Moneyline', hit_streak: 'Hot hitter', wind_hr: 'HR weather' };

function tickIcon(result) {
  if (result === 'win') return '<span class="tick tick-win" title="Win">✓</span>';
  if (result === 'loss') return '<span class="tick tick-loss" title="Loss">✕</span>';
  if (result === 'push') return '<span class="tick tick-push" title="Push">–</span>';
  return '<span class="tick tick-pending" title="Pending">•</span>';
}

function trackRow(p) {
  return `
    <div class="track-row">
      ${tickIcon(p.result)}
      <div class="track-desc">
        <div class="track-desc-main"><span class="pill dim">${esc(SIGNAL_NAMES[p.signalType] || p.signalType)}</span>${esc(p.description)}</div>
        ${p.lockedPrice !== null && p.lockedPrice !== undefined ? `<div class="track-desc-sub">${fmtOdds(p.lockedPrice)}</div>` : ''}
      </div>
    </div>`;
}

function trackGroupHtml(group) {
  const g = group.game;
  const title = g
    ? `<span class="track-group-teams">${logoHtml(g.away.id, g.away.name, 18)}${esc(g.away.name)} <span class="faint">at</span> ${esc(g.home.name)}${logoHtml(g.home.id, g.home.name, 18)}</span>`
    : `<span class="track-group-teams">${esc(longDate(group.gameDate))}</span>`;
  return `
    <div class="track-group">
      <div class="track-group-head">
        ${title}
        ${group.mlbGameId ? `<button type="button" class="btn ghost small" data-open-game="${esc(group.mlbGameId)}" data-open-date="${esc(group.gameDate)}">Open game</button>` : ''}
      </div>
      ${group.picks.map(trackRow).join('')}
    </div>`;
}

async function renderTracking() {
  const host = $('#view-tracking');
  host.innerHTML = loadingHtml;
  try {
    const perf = await api('/api/performance');
    const { summary, recent } = perf;

    // Pull matchup info (team names/logos) for whichever dates the tracked
    // picks touch, so groups read as real games, not raw descriptions.
    const dates = [...new Set(recent.map((p) => p.gameDate).filter(Boolean))];
    const slates = await Promise.all(dates.map((dt) => {
      const cached = state.slateCache.get(dt);
      return cached ? Promise.resolve(cached) : api(`/api/slate?date=${dt}`).catch(() => null);
    }));
    const gameByPk = new Map();
    slates.forEach((slate) => (slate?.games || []).forEach((g) => gameByPk.set(String(g.gamePk), g)));

    const groups = new Map();
    for (const p of recent) {
      const key = p.mlbGameId ? `g:${p.mlbGameId}` : `d:${p.gameDate}`;
      if (!groups.has(key)) {
        groups.set(key, {
          game: p.mlbGameId ? gameByPk.get(String(p.mlbGameId)) : null,
          gameDate: p.gameDate,
          mlbGameId: p.mlbGameId,
          picks: [],
        });
      }
      groups.get(key).picks.push(p);
    }
    const groupList = [...groups.values()].sort((a, b) => (a.gameDate < b.gameDate ? 1 : a.gameDate > b.gameDate ? -1 : 0));
    const anyPending = summary.some((s) => s.pending > 0);

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Tracking</h2></div>
      <p class="section-sub">Slatefinder's top 8 player props, graded against what actually happened.</p>

      ${summary.length ? `<div class="stat-tiles">${summary.map((s) => `
        <div class="stat-tile">
          <div class="st-label">${esc(SIGNAL_NAMES[s.signalType] || s.signalType)}</div>
          <div class="st-value">${s.winRate !== null ? `${(s.winRate * 100).toFixed(0)}<span class="unit">%</span>` : '-'}</div>
          <div class="st-sub">${s.wins}W ${s.losses}L${s.pushes ? ` ${s.pushes}P` : ''}${s.pending ? ` · ${s.pending} pending` : ''}</div>
        </div>`).join('')}</div>` : ''}

      <div class="bets-toolbar">
        <button class="btn" id="gradeBetsBtn" ${anyPending ? '' : 'disabled'}>Check results</button>
      </div>

      ${groupList.length ? groupList.map(trackGroupHtml).join('') : emptyHtml('Nothing tracked yet', "Top picks land here automatically once the daily slate runs.")}`;

    $('#gradeBetsBtn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        await apiSend('/api/tracked-picks/grade', 'POST');
        await renderTracking();
      } catch (ex) {
        btn.disabled = false;
        btn.textContent = 'Check results';
      }
    });
  } catch (err) {
    host.innerHTML = emptyHtml('Tracking unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// SIGNALS VIEW
// Player identity cell: headshot, name, then status pills inline between
// the name and the stat columns so lineup state reads as part of who the
// player is, not a separate column off to the right.
function playerCell(b, extraPills = '') {
  const status = lineupPill(b.lineupConfirmed, null);
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
        ${status || extraPills ? `<div class="player-status">${status}${extraPills}</div>` : ''}
      </div>
    </div>`;
}

// Two-line ERA readout for a starter: last-5-starts figure with the
// season figure alongside, whichever exists.
function starterEra(name, trailing, season, highlight) {
  const primary = trailing ?? season;
  const cls = highlight ? 'era-good' : primary !== null && primary >= 6 ? 'era-bad' : '';
  return `
    <div class="ml-starter">
      <div class="ml-starter-name">${esc(name ?? 'TBD')}</div>
      <div class="ml-starter-era">
        <span class="${cls}">${fmtNum(trailing)}</span> <span class="faint">last 5</span>
        &nbsp;·&nbsp; ${fmtNum(season)} <span class="faint">season</span>
      </div>
    </div>`;
}

function moneylinePickCard(p) {
  const noLine = p.lineStatus === 'no-line' || p.homeMl === null || p.homeMl === undefined;
  const breakeven = p.breakevenPct !== null && p.breakevenPct !== undefined ? `${(p.breakevenPct * 100).toFixed(1)}%` : '-';
  const edge = p.eraEdge !== null && p.eraEdge !== undefined ? fmtNum(p.eraEdge) : null;

  const flags = [];
  flags.push(p.startersConfirmed
    ? '<span class="pill ok"><span class="pill-dot"></span>Confirmed starters</span>'
    : '<span class="pill warn"><span class="pill-dot"></span>Projected starters</span>');
  if (noLine) flags.push('<span class="pill warn"><span class="pill-dot"></span>No betting line yet</span>');

  const oddsLabel = noLine ? 'No line' : fmtOdds(p.homeMl);
  const note = noLine
    ? 'No betting line posted yet. This is the pitching matchup only. The odds band gets checked once a price is available.'
    : `Needs to win ${breakeven} of the time at ${fmtOdds(p.homeMl)} just to break even. Not a prediction it will.`;

  return `
    <div class="sig-card">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam)}</span>
        <span class="sig-odds${noLine ? ' faint' : ''}">${oddsLabel}</span>
      </div>
      <div class="sig-sub">To beat ${esc(p.awayTeam)} at home${edge ? `. Home starter's ERA is <strong>${edge} runs better</strong> (${esc(p.eraBasis ?? '')})` : ''}.</div>
      <div class="ml-matchup">
        ${starterEra(p.homeStarterName, p.homeStarterTrailingEra, p.homeStarterSeasonEra, true)}
        <span class="ml-vs">vs</span>
        ${starterEra(p.awayStarterName, p.awayStarterTrailingEra, p.awayStarterSeasonEra, false)}
      </div>
      <div class="ml-flags">${flags.join('')}</div>
      <div class="sig-note">${note}</div>
    </div>`;
}

function moneylineCards(ml) {
  if (ml.signal === 'SIT' || !ml.picks?.length) {
    return emptyHtml('No qualifying games', 'No home favorite today whose starting pitcher has the better ERA than the visitor. The nearest misses are listed below.');
  }
  return `<div class="sig-cards">${ml.picks.map(moneylinePickCard).join('')}</div>`;
}

function manualPickCards(picks) {
  if (!picks?.length) return '';
  return `<div class="sig-cards">${picks.map((p) => `
    <div class="sig-card manual">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam)} <span class="manual-tag">Manual</span></span>
        <span class="sig-odds">${fmtOdds(p.homeMl)}</span>
      </div>
      <div class="sig-sub">To beat ${esc(p.awayTeam)}.${p.reason ? ` ${esc(p.reason)}` : ''}</div>
      <div class="sig-note">Needs to win ${p.breakevenPct !== null && p.breakevenPct !== undefined ? (p.breakevenPct * 100).toFixed(1) + '%' : '-'} of the time at ${fmtOdds(p.homeMl)} just to break even.</div>
      <div style="margin-top:10px">
        <button class="btn ghost small" data-delete-manual-pick="${p.id}">Remove</button>
      </div>
    </div>`).join('')}</div>`;
}

function nearMissCards(otherGames) {
  if (!otherGames?.length) return '';
  return `
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

function opposingStarterCell(b) {
  return `${esc(b.opposingStarterName ?? 'TBD')}${
    b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined
      ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : b.opposingStarterTrailingEra >= 4.5 ? '' : 'pos'}" style="font-size:11px;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA last 3${b.weakerArm ? ' (weaker arm)' : ''}</div>`
      : ''
  }`;
}

// --- trading-card pick grids -------------------------------------------------
// The sketch: picks presented like positions on a trading board. Big
// probability, headshot, sparkline of recent form; tap the card and it
// opens the "why" (form, opposing arm, wind).

function sparkBars(results) {
  if (!results?.length) return '';
  return `<span class="spark">${results.map((hit) => `<i class="${hit ? 'up' : ''}"></i>`).join('')}</span>`;
}

function whyRow(label, value) {
  return value ? `<div class="why-row"><span>${esc(label)}</span><b>${value}</b></div>` : '';
}

function pickCard({ rank, personId, name, sub, teamName, prob, probLabel, spark, why, flags, mlbGameId, gameDate }) {
  // The team logo doubles as a link to that matchup: tap the player to
  // open the why panel, then tap the team mark to jump straight to the
  // game (who's pitching, full lineup) to see the whole matchup at a
  // glance. It's a <button>, so the card's own tap-to-expand handler
  // (which ignores clicks on button/a) leaves it alone.
  const teamLink = mlbGameId
    ? `<button type="button" class="pc-team-link" data-open-game="${esc(mlbGameId)}" data-open-date="${esc(gameDate || '')}" title="Open this game">${logoHtml(null, teamName, 20)}</button>`
    : logoHtml(null, teamName, 20);
  return `
    <article class="pick-card" data-expand>
      <div class="pc-rank">${rank}</div>
      <div class="pc-top">
        ${headshotHtml(personId, name)}
        <div class="pc-id">
          <div class="pc-name">${esc(name)}</div>
          <div class="pc-sub">${sub}</div>
        </div>
        ${probChip(prob, probLabel)}
      </div>
      <div class="pc-mid">
        ${teamLink}
        ${spark || ''}
        ${flags || ''}
      </div>
      <div class="pc-why">
        ${why}
      </div>
    </article>`;
}

function hitStreakSection(hs) {
  if (!hs.watchList?.length) return emptyHtml('No qualifying batters', 'Nobody clears the bar today.');
  const cards = hs.watchList.map((b, i) => pickCard({
    rank: i + 1,
    personId: b.batterId,
    name: b.batterName,
    sub: `${b.jerseyNumber ? `#${esc(b.jerseyNumber)} ` : ''}${b.position ? esc(b.position) + ' · ' : ''}1+ hit`,
    teamName: b.team,
    prob: estHitProb(b.trailing15Avg),
    probLabel: 'est',
    spark: sparkBars(b.last5Results),
    flags: [
      b.highConfidence ? '<span class="pill info"><span class="pill-dot"></span>Prime matchup</span>' : '',
      b.lineupConfirmed === false ? '<span class="pill warn"><span class="pill-dot"></span>Projected</span>' : '',
    ].join(''),
    why: [
      whyRow('Form', b.hitStreak >= 5 ? `${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)}`),
      whyRow('Last 15 avg', fmtNum(b.trailing15Avg, 3)),
      whyRow('Opposing arm', `${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `, ${fmtNum(b.opposingStarterTrailingEra)} ERA${b.weakerArm ? ' (weaker arm)' : ''}` : ''}`),
    ].join(''),
    mlbGameId: b.mlbGameId,
    gameDate: state.signalsDate || state.today,
  }));
  return `<div class="pick-grid">${cards.join('')}</div>`;
}

function windHrSection(wh) {
  if (!wh.watchList?.length) return emptyHtml('No qualifying batters', 'No power bats cleared the top-third HR-rate bar today.');
  const cards = wh.watchList.map((b, i) => pickCard({
    rank: i + 1,
    personId: b.batterId,
    name: b.batterName,
    sub: `${b.jerseyNumber ? `#${esc(b.jerseyNumber)} ` : ''}${b.position ? esc(b.position) + ' · ' : ''}home run`,
    teamName: b.team,
    prob: estHrProb(b.trailing15HrRate),
    probLabel: 'est',
    spark: sparkBars(b.last5Results),
    flags: [
      b.windBlowingOut ? `<span class="pill hot"><span class="pill-dot"></span>Wind out${b.windSpeedMph ? ` ${fmtNum(b.windSpeedMph, 0)} mph` : ''}</span>` : '',
      b.lineupConfirmed === false ? '<span class="pill warn"><span class="pill-dot"></span>Projected</span>' : '',
    ].join(''),
    why: [
      whyRow('Power', `${fmtNum(b.trailing15HrRate, 2)} HR per game, last 15`),
      whyRow('Park', b.venue ? `${esc(b.venue)}${b.windBlowingOut ? `, wind out ${fmtNum(b.windSpeedMph, 0)} mph` : ''}` : null),
      whyRow('Opposing arm', `${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `, ${fmtNum(b.opposingStarterTrailingEra)} ERA${b.weakerArm ? ' (weaker arm)' : ''}` : ''}`),
    ].join(''),
    mlbGameId: b.mlbGameId,
    gameDate: state.signalsDate || state.today,
  }));
  return `<div class="pick-grid">${cards.join('')}</div>`;
}

function formKsHtml(ks, floor) {
  if (!ks || !ks.length) return '<span class="faint" style="font-size:11px">no data</span>';
  return `<span class="form-ks">${ks.map((k) => `<i class="${k >= floor ? 'over' : ''}">${k}</i>`).join('')}</span>`;
}

function strikeoutSection(so) {
  if (!so?.watchList?.length) {
    return emptyHtml('No strikeout spots', 'No probable starter today has a high, consistent strikeout floor over his recent starts.');
  }
  const cards = so.watchList.map((p, i) => pickCard({
    rank: i + 1,
    personId: p.pitcherId,
    name: p.pitcherName,
    sub: `P · over ${p.suggestedLine.toFixed(1)} Ks`,
    teamName: p.team,
    prob: estKOverProb(p.last5StartKs, p.strictFloorKs),
    probLabel: 'est',
    spark: formKsHtml(p.last5StartKs, p.strictFloorKs),
    flags: '',
    why: [
      whyRow('Floor', `Reached ${p.strictFloorKs}+ Ks in every recent start`),
      whyRow('Average', `${fmtNum(p.kPerStart, 1)} Ks per start`),
      whyRow('Matchup', `vs ${esc(p.opponent)}`),
    ].join(''),
    mlbGameId: p.mlbGameId,
    gameDate: state.signalsDate || state.today,
  }));
  return `<div class="pick-grid center">${cards.join('')}</div>`;
}

// --- jumbotron ---------------------------------------------------------------
// The rotating stadium board at the top of Daily Picks: the day's
// highest-probability picks, scrolling continuously with faces and
// percentages. Content is duplicated so the loop wraps seamlessly.
function buildBoardItems(d) {
  const items = [];
  for (const b of d.hitStreak?.watchList || []) {
    items.push({ personId: b.batterId, name: b.batterName, team: b.team, label: '1+ HIT', prob: estHitProb(b.trailing15Avg), probLabel: 'est' });
  }
  for (const b of d.windHr?.watchList || []) {
    items.push({ personId: b.batterId, name: b.batterName, team: b.team, label: 'HOME RUN', prob: estHrProb(b.trailing15HrRate), probLabel: 'est' });
  }
  for (const p of d.strikeouts?.watchList || []) {
    items.push({ personId: p.pitcherId, name: p.pitcherName, team: p.team, label: `OVER ${p.suggestedLine.toFixed(1)} K`, prob: estKOverProb(p.last5StartKs, p.strictFloorKs), probLabel: 'est' });
  }
  for (const p of d.moneyline?.picks || []) {
    items.push({ personId: null, name: p.homeTeam, team: p.homeTeam, label: `ML ${p.homeMl !== null ? fmtOdds(p.homeMl) : ''}`.trim(), prob: p.breakevenPct ?? null, probLabel: 'mkt' });
  }
  const seen = new Set();
  return items
    .filter((x) => x.prob !== null)
    .filter((x) => (seen.has(x.name + x.label) ? false : seen.add(x.name + x.label)))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 6); // only the absolute best picks make the board
}

function jumbotronHtml(d) {
  const items = buildBoardItems(d);
  if (items.length < 2) return '';
  const chip = (x, i) => `
    <span class="jumbo-item">
      <span class="jumbo-rank">${i + 1}</span>
      ${x.personId ? headshotHtml(x.personId, x.name) : logoHtml(null, x.team, 30)}
      <span class="jumbo-name">${esc(x.name)}</span>
      <span class="jumbo-label">${esc(x.label)}</span>
      ${probChip(x.prob, x.probLabel)}
    </span>`;
  const row = items.map(chip).join('<span class="jumbo-sep"></span>');
  // Repeated 4x (not 2x): with only 6 short items the row can be narrower
  // than a wide desktop viewport, which makes a 2-copy loop look static
  // since there's nothing to scroll past. Four copies guarantees the
  // track overflows any real screen so the marquee is always visibly
  // moving, on phone and on desktop. The keyframe below moves exactly
  // one row-width (-25% of the 4x track), so playback speed is unchanged.
  const track = Array(4).fill(row).join('<span class="jumbo-sep"></span>');
  return `
    <div class="jumbotron" aria-label="Today's top picks board">
      <div class="jumbo-title"><span class="jumbo-live"></span>TODAY'S BOARD</div>
      <div class="jumbo-viewport">
        <div class="jumbo-track">${track}<span class="jumbo-sep"></span></div>
      </div>
    </div>`;
}

// --- yesterday strip -----------------------------------------------------------
// Public accountability: yesterday's graded picks as W/L chips plus the
// all-time record, straight from the tracked ledger.
function yesterdayStrip(perf, today) {
  if (!perf) return '';
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yd = y.toISOString().slice(0, 10);
  const graded = (perf.recent || []).filter((r) => r.gameDate === yd && (r.result === 'win' || r.result === 'loss' || r.result === 'push'));
  let wins = 0, losses = 0, pushes = 0;
  for (const s of perf.summary || []) { wins += s.wins; losses += s.losses; pushes += s.pushes; }
  const pct = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : null;
  const chips = graded.slice(0, 8).map((r) => {
    const short = r.description.split(', ')[0].split(' to ')[0];
    return `<span class="yd-chip ${r.result}"><b>${r.result === 'win' ? 'W' : r.result === 'loss' ? 'L' : 'P'}</b>${esc(short)}</span>`;
  }).join('');
  return `
    <div class="yesterday-strip">
      <span class="yd-title">Yesterday</span>
      ${chips || '<span class="faint" style="font-size:12px">Nothing graded yet</span>'}
      <span class="yd-record">All-time <b>${wins}-${losses}${pushes ? `-${pushes}` : ''}</b>${pct !== null ? ` (${pct}%)` : ''}</span>
    </div>`;
}

// silent=true is used by the 120s auto-refresh: skip the loading spinner
// and put the scroll position back so a picture that hasn't changed
// doesn't visibly jump or flash while someone's mid-read.
async function renderSignals(silent = false) {
  const host = $('#view-signals');
  if (!silent) host.innerHTML = loadingHtml;
  const scrollY = silent ? window.scrollY : null;
  try {
    const date = state.signalsDate || state.today;
    const [d, perf] = await Promise.all([
      api(`/api/digest?date=${date}`),
      api('/api/performance').catch(() => null), // strip is optional, never blocks the page
    ]);
    state.signalsDate = d.date;
    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    host.innerHTML = `
      ${jumbotronHtml(d)}
      ${yesterdayStrip(perf, d.date)}

      <div class="signals-toolbar">
        <select class="date-select" id="signalsDate">${dateOptions}</select>
        <span class="toolbar-note">${esc(longDate(d.date))}${d.updatedAt ? ` · screener ran ${esc(fmtRunTime(d.updatedAt))}` : ''}</span>
        <span class="toolbar-note" style="margin-left:auto">Percentages are estimates from recent form, not guarantees.</span>
      </div>

      <div class="board-head">
        <h2 class="board-title">Moneyline</h2>
        <button class="btn small" data-add-manual-pick>Add a pick</button>
      </div>
      ${manualPickCards(d.manualPicks)}
      ${moneylineCards(d.moneyline)}

      <h2 class="board-title">+1 Hits</h2>
      ${hitStreakSection(d.hitStreak)}

      <h2 class="board-title">Home Runs</h2>
      ${windHrSection(d.windHr)}

      <h2 class="board-title center">Strikeout Watch</h2>
      ${strikeoutSection(d.strikeouts)}

      <h2 class="board-title">Close Calls</h2>
      ${nearMissCards(d.moneyline.otherGames) || emptyHtml('Nothing else evaluated', 'Every home favorite today either qualified or there were none.')}

      ${digestWarningBanner(d.warnings)}`;

    $('#signalsDate').addEventListener('change', (e) => {
      state.signalsDate = e.target.value;
      renderSignals();
    });
    if (scrollY !== null) window.scrollTo(0, scrollY);
  } catch (err) {
    if (!silent) host.innerHTML = emptyHtml('Signals unavailable', err.message);
    // A silent refresh that fails leaves the last good render on screen
    // rather than replacing it with an error, next tick tries again.
  }
}

// Auto-refresh: the pipeline updates lineups/odds through the day, and
// the chat/tracking data changes too, so Daily Picks quietly re-fetches
// itself every 120s while it's the active tab.
let signalsAutoTimer = null;
function startSignalsAutoRefresh() {
  clearTimeout(signalsAutoTimer);
  signalsAutoTimer = setTimeout(async () => {
    if (state.view === 'signals') {
      await renderSignals(true);
      startSignalsAutoRefresh();
    }
  }, 120000);
}
function stopSignalsAutoRefresh() {
  clearTimeout(signalsAutoTimer);
  signalsAutoTimer = null;
}

// ---------------------------------------------------------------------------
// LIVE CHAT VIEW, one flat room, polled. Signed-in users only can post;
// anyone can read. Denormalized username + avatar come back on each row.
let chatTimer = null;
let chatLastId = 0;
const chatSeen = new Set();

function chatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function chatMessageHtml(m) {
  const mine = state.user && m.userId === state.user.id;
  return `
    <div class="chat-msg${mine ? ' mine' : ''}">
      <span class="chat-avatar">${avatarSvg(m.avatarSeed, 30)}</span>
      <div class="chat-bubble">
        <div class="chat-meta"><span class="chat-user">${esc(m.username)}</span><span class="chat-time">${esc(chatTime(m.createdAt))}</span></div>
        <div class="chat-body">${esc(m.body)}</div>
      </div>
    </div>`;
}

function stopChatPolling() {
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null; }
}

async function pollChat() {
  stopChatPolling();
  try {
    const { messages } = await api(`/api/chat?since=${chatLastId}`);
    const feed = $('#chatFeed');
    if (feed && messages.length) {
      const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      const fresh = messages.filter((m) => !chatSeen.has(m.id));
      for (const m of fresh) chatSeen.add(m.id);
      if (fresh.length) {
        if ($('#chatEmpty')) $('#chatEmpty').remove();
        feed.insertAdjacentHTML('beforeend', fresh.map(chatMessageHtml).join(''));
        chatLastId = Math.max(chatLastId, ...fresh.map((m) => m.id));
        if (nearBottom) feed.scrollTop = feed.scrollHeight;
      }
    }
  } catch { /* transient; next tick retries */ }
  if (state.view === 'chat') chatTimer = setTimeout(pollChat, 4000);
}

function renderChat() {
  const host = $('#view-chat');
  chatLastId = 0;
  chatSeen.clear();
  const canPost = Boolean(state.user);
  host.innerHTML = `
    <h2 class="board-title">Live Chat</h2>
    <div class="chat-wrap">
      <div class="chat-feed" id="chatFeed"><div class="empty-state" id="chatEmpty"><div class="es-title">Quiet in here</div>Be the first to say something.</div></div>
      ${canPost
        ? `<form class="chat-form" id="chatForm">
             <span class="chat-you">${avatarSvg(state.user.avatarSeed, 26)}</span>
             <input type="text" id="chatInput" maxlength="500" autocomplete="off" placeholder="Talk some slate...">
             <button type="submit" class="btn primary" id="chatSend">Send</button>
           </form>`
        : `<div class="chat-locked">Sign in to join the chat. You can still read along.</div>`}
    </div>`;

  if (canPost) {
    $('#chatForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#chatInput');
      const body = input.value.trim();
      if (!body) return;
      $('#chatSend').disabled = true;
      try {
        await apiSend('/api/chat', 'POST', { body });
        input.value = '';
        await pollChat();
      } catch (ex) {
        input.placeholder = ex.message;
      } finally {
        $('#chatSend').disabled = false;
        input.focus();
      }
    });
  }
  pollChat();
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
    if (s.build) $('#buildTag').textContent = `Build ${s.build}`;
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
      // A sync just finished, drop caches and re-render the active view.
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
  if (name === 'tracking') renderTracking();
  if (name === 'chat') renderChat();
  if (name !== 'chat') stopChatPolling();
  if (name === 'signals') startSignalsAutoRefresh(); else stopSignalsAutoRefresh();
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
      closeManualPickModal();
    }
  });

  // Manual pick modal wiring + delegated add/delete buttons.
  $('#manualPickForm').addEventListener('submit', submitManualPick);
  $('#mpCancel').addEventListener('click', closeManualPickModal);
  $('#manualPickModal').addEventListener('click', (e) => { if (e.target === $('#manualPickModal')) closeManualPickModal(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-manual-pick]')) openManualPickModal();
    const delBtn = e.target.closest('[data-delete-manual-pick]');
    if (delBtn) deleteManualPick(Number(delBtn.dataset.deleteManualPick));
  });

  // Team-mark links on pick cards: jump straight to that matchup.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-open-game]');
    if (!link) return;
    openGamePanel(link.dataset.openGame, link.dataset.openDate || state.today);
  });

  // Account gate + topbar chip.
  wireAuth();

  // Newsletter signup.
  $('#subscribeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await apiSend('/api/subscribe', 'POST', { email: $('#subscribeEmail').value });
      form.innerHTML = '<span class="subscribe-done">You are on the list. First email goes out with the next morning digest.</span>';
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
  // slate matches what the backend considers today, and find out who is
  // signed in. If the auth check itself fails the gate stays closed - a
  // broken login endpoint should never lock anyone out of the research.
  try {
    const [s, me] = await Promise.all([
      api('/api/status'),
      api('/api/auth/me').catch(() => ({ user: null })),
    ]);
    if (s.today) state.today = s.today;
    state.user = me.user;
  } catch { /* fall back to client clock */ }

  if (!state.user) {
    openAuthGate();
  }
  updateAccountChip();

  // Trading-card expand/collapse: tap anywhere on a card that isn't a
  // button or link to open its "why" panel.
  document.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    const card = e.target.closest('[data-expand]');
    if (card) card.classList.toggle('open');
  });

  // Image fallbacks: swap any failed logo/headshot for its initials badge.
  // Capture phase because error events don't bubble.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fb) return;
    const span = document.createElement('span');
    span.className = img.dataset.fbClass || 'gc-logo-fallback';
    span.textContent = img.dataset.fb;
    if (img.style.width) { span.style.width = img.style.width; span.style.height = img.style.height; }
    img.replaceWith(span);
  }, true);

  renderSignals(); // Daily Picks is home
  startSignalsAutoRefresh();
  pollStatus();
}

// ---------------------------------------------------------------------------
// ACCOUNT GATE
let authMode = 'signup';

// "Remember me": the session cookie handles staying logged in; this just
// remembers the email locally so a returning user opens straight onto the
// login form with their address filled in.
function rememberedEmail() {
  try { return localStorage.getItem('sf_email') || ''; } catch { return ''; }
}
function setRememberedEmail(email) {
  try {
    if (email) localStorage.setItem('sf_email', email);
    else localStorage.removeItem('sf_email');
  } catch { /* private mode etc. */ }
}

function openAuthGate() {
  $('#authGate').hidden = false;
  $('#authFormWrap').hidden = false;
  $('#authReveal').hidden = true;
  // Never carry a previous session's password (or its visibility) over.
  const pw = $('#authPassword');
  pw.value = '';
  pw.type = 'password';
  $('#authShowPw').textContent = 'Show';
  const saved = rememberedEmail();
  setAuthMode(saved ? 'login' : 'signup');
  if (saved) {
    $('#authEmail').value = saved;
    pw.focus();
  }
}

function closeAuthGate() {
  $('#authGate').hidden = true;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
  $('#authSub').textContent = signup
    ? 'Your name and face get picked for you. All we need is an email and a password.'
    : 'Log in with the email and password you signed up with.';
  $('#authSubmit').textContent = signup ? 'Create account' : 'Log in';
  $('#authToggleLabel').textContent = signup ? 'Already have an account?' : 'New here?';
  $('#authToggle').textContent = signup ? 'Log in' : 'Create an account';
  $('#authPassword').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#authError').hidden = true;
}

function updateAccountChip() {
  const chip = $('#accountChip');
  if (!state.user) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  $('#accountAvatar').innerHTML = avatarSvg(state.user.avatarSeed, 26);
  $('#accountName').textContent = state.user.username;
}

function wireAuth() {
  $('#authToggle').addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'login' : 'signup'));

  $('#authShowPw').addEventListener('click', () => {
    const input = $('#authPassword');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('#authShowPw').textContent = showing ? 'Show' : 'Hide';
    $('#authShowPw').setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    input.focus();
  });

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#authError');
    err.hidden = true;
    $('#authSubmit').disabled = true;
    try {
      const remember = $('#authRemember').checked;
      const body = {
        email: $('#authEmail').value.trim(),
        password: $('#authPassword').value,
        rememberMe: remember,
      };
      const path = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const { user } = await apiSend(path, 'POST', body);
      setRememberedEmail(remember ? body.email : '');
      state.user = user;
      updateAccountChip();
      if (authMode === 'signup') {
        // The reveal: this is who you are now.
        $('#authFormWrap').hidden = true;
        $('#revealAvatar').innerHTML = avatarSvg(user.avatarSeed, 96);
        $('#revealName').textContent = user.username;
        $('#authReveal').hidden = false;
      } else {
        closeAuthGate();
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      $('#authSubmit').disabled = false;
    }
  });

  $('#authEnter').addEventListener('click', closeAuthGate);

  $('#signOutBtn').addEventListener('click', async () => {
    try { await apiSend('/api/auth/logout', 'POST'); } catch { /* cookie clears anyway */ }
    state.user = null;
    updateAccountChip();
    openAuthGate();
  });
}

init();

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
  researchDate: null,
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

function emptyHtml(title, msg) {
  return `<div class="empty-state"><div class="es-title">${esc(title)}</div>${esc(msg)}</div>`;
}

// Ghost/skeleton placeholders for the initial load of a page, standing in
// the shape of what's about to render instead of a bare spinner.
function skeletonCards(count = 6) {
  const card = `
    <div class="skel-card">
      <div class="skel-row">
        <div class="skel-block skel-avatar"></div>
        <div style="flex:1">
          <div class="skel-block skel-line w60"></div>
          <div class="skel-block skel-line w40" style="margin-top:6px"></div>
        </div>
      </div>
      <div class="skel-block skel-line w90"></div>
      <div class="skel-block skel-line w70"></div>
    </div>`;
  return `<div class="skel-grid">${Array(count).fill(card).join('')}</div>`;
}
function skeletonPanel() {
  return `
    <div class="skel-panel">
      <div class="skel-block skel-line w60" style="height:22px;width:70%"></div>
      <div class="skel-block skel-line w40"></div>
      ${Array(5).fill('<div class="skel-block skel-line w90"></div>').join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// RESEARCH TAB: the full ranked bulk behind the Daily Slate, every pick
// the screener surfaced, analyzed: all qualifying home moneyline calls,
// the top 15 hit picks, the top 10 K/O picks. The Daily Slate shows the 6
// best of these; this is the whole board. Free for now, this is the part
// that pay-gates later. (Section renderers reused from the Daily Slate,
// called without top-6 keys so they show the full list.)
async function renderResearch() {
  const host = $('#view-slate');
  host.innerHTML = skeletonCards(6);
  try {
    const date = state.researchDate || state.today;
    const d = await api(`/api/digest?date=${date}`);
    state.researchDate = d.date;

    if (isBeforeGoLive(d.date)) {
      host.innerHTML = `<div class="section-head"><h2 class="section-title">Research</h2></div>` +
        goLiveGate('gateSeeYesterdayR', "The full research board is finalized with the 9 AM ET run. Check back at 9, or look at yesterday.");
      $('#gateSeeYesterdayR')?.addEventListener('click', () => {
        state.researchDate = addDays(state.today, -1);
        renderResearch();
      });
      return;
    }

    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    const mlCount = d.moneyline?.picks?.length || 0;
    const hitCount = d.hitStreak?.watchList?.length || 0;
    const koCount = d.strikeouts?.watchList?.length || 0;
    const count = (n) => `<span class="board-count">${n}</span>`;

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Research</h2></div>
      <p class="section-sub">Every pick the screener surfaced, ranked and researched. The Daily Slate shows the 6 best of these.</p>

      <div class="signals-toolbar">
        <select class="date-select" id="researchDate">${dateOptions}</select>
        <span class="toolbar-note">${esc(longDate(d.date))}${d.updatedAt ? ` · ran ${esc(fmtRunTime(d.updatedAt))}` : ''}</span>
      </div>

      <h2 class="board-title">Moneyline${count(mlCount)}</h2>
      ${moneylineCards(d.moneyline) || emptyHtml('No moneyline picks', 'No home team today priced +100 to -250 with a 2+ run starting-pitcher ERA edge.')}

      <h2 class="board-title">Hit picks${count(hitCount)}</h2>
      ${hitStreakSection(d.hitStreak) || emptyHtml('No hit picks', 'Nobody cleared the hot-bat bar facing a beatable arm today.')}

      <h2 class="board-title">Strikeout picks${count(koCount)}</h2>
      ${strikeoutSection(d.strikeouts) || emptyHtml('No strikeout spots', 'No probable starter has a high, consistent K floor today.')}`;

    $('#researchDate').addEventListener('change', (e) => {
      state.researchDate = e.target.value;
      renderResearch();
    });
  } catch (err) {
    host.innerHTML = emptyHtml('Research unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// GAME DETAIL PANEL
function statusLabel(g) {
  if (g.abstractState === 'Final') return { text: g.status, cls: 'final' };
  if (g.abstractState === 'Live') {
    const inn = g.inning ? `${g.inningState || 'Live'} ${g.inning}` : 'Live';
    return { text: inn, cls: 'live' };
  }
  return { text: etTime(g.gameDate), cls: '' };
}

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
  inner.innerHTML = `<button class="gp-close" id="gpClose" aria-label="Close">×</button>${skeletonPanel()}`;
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
    : `Break-even ${breakeven}`;

  return `
    <div class="sig-card">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam)}</span>
        <span class="sig-odds${noLine ? ' faint' : ''}">${oddsLabel}</span>
      </div>
      <div class="sig-sub">Home vs ${esc(p.awayTeam)}${edge ? `. Starter ERA <strong>${edge} better</strong> over 5 starts` : ''}.</div>
      <div class="ml-matchup">
        ${starterEra(p.homeStarterName, p.homeStarterTrailingEra, p.homeStarterSeasonEra, true)}
        <span class="ml-vs">vs</span>
        ${starterEra(p.awayStarterName, p.awayStarterTrailingEra, p.awayStarterSeasonEra, false)}
      </div>
      <div class="ml-flags">${flags.join('')}</div>
      <div class="sig-note">${note}</div>
    </div>`;
}

// With topPickKeys (Daily Slate): only the ML picks that made the top 6.
// Without it (Research): every qualifying home ML pick, ranked.
function moneylineCards(ml, topPickKeys = null) {
  const picks = topPickKeys
    ? (ml.picks || []).filter((p) => topPickKeys.has(`ml:${p.homeTeam}:${p.awayTeam}`))
    : (ml.picks || []);
  if (!picks.length) return '';
  return `<div class="sig-cards">${picks.map(moneylinePickCard).join('')}</div>`;
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
      <div class="sig-note">Break-even ${p.breakevenPct !== null && p.breakevenPct !== undefined ? (p.breakevenPct * 100).toFixed(1) + '%' : '-'}</div>
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
        <strong>Heads up · ${warnings.length} data gap${warnings.length === 1 ? '' : 's'} today</strong>
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
    ? `<button type="button" class="pc-team-link" data-open-game="${esc(mlbGameId)}" data-open-date="${esc(gameDate || '')}" title="Open this game">${logoHtml(null, teamName, 16)}</button>`
    : logoHtml(null, teamName, 16);
  const pct = prob === null || prob === undefined ? null : Math.round(prob * 100);
  const tier = pct === null ? 'cool' : pct >= 70 ? 'hot' : pct >= 50 ? 'warm' : 'cool';
  const probBlock = pct === null ? '' : `
      <div class="pc-prob">
        <span class="pc-pct">${pct}<i>%</i></span>
        <span class="pc-plabel">${esc(probLabel || 'est')}</span>
        ${spark ? `<span class="pc-spark">${spark}</span>` : ''}
      </div>
      <div class="pc-meter"><i style="width:${pct}%"></i></div>`;
  return `
    <article class="pick-card ${tier}" data-expand>
      <div class="pc-head">
        ${headshotHtml(personId, name)}
        <div class="pc-id">
          <div class="pc-name">${esc(name)}</div>
          <div class="pc-sub">${sub}</div>
        </div>
        <span class="pc-rank">${rank}</span>
      </div>
      ${probBlock}
      <div class="pc-mid">
        ${teamLink}
        ${flags || ''}
      </div>
      <div class="pc-why">
        ${why}
      </div>
    </article>`;
}

// With topPickKeys (Daily Slate): only the hit picks in the top 6, ranked
// by their spot in that shared list. Without it (Research): all 15, ranked
// in order.
function hitStreakSection(hs, topPickKeys = null) {
  const list = topPickKeys
    ? (hs.watchList || []).filter((b) => topPickKeys.has(`hit:${b.batterName}:${b.team}`))
    : (hs.watchList || []);
  if (!list.length) return '';
  const cards = list.map((b, i) => pickCard({
    rank: topPickKeys ? topPickKeys.get(`hit:${b.batterName}:${b.team}`) : i + 1,
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

function formKsHtml(ks, floor) {
  if (!ks || !ks.length) return '<span class="faint" style="font-size:11px">no data</span>';
  return `<span class="form-ks">${ks.map((k) => `<i class="${k >= floor ? 'over' : ''}">${k}</i>`).join('')}</span>`;
}

// With topPickKeys (Daily Slate): only the K/O picks in the top 6. Without
// it (Research): all 10, ranked in order.
function strikeoutSection(so, topPickKeys = null) {
  const list = topPickKeys
    ? (so?.watchList || []).filter((p) => topPickKeys.has(`ko:${p.pitcherName}`))
    : (so?.watchList || []);
  if (!list.length) return '';
  const cards = list.map((p, i) => pickCard({
    rank: topPickKeys ? topPickKeys.get(`ko:${p.pitcherName}`) : i + 1,
    personId: p.pitcherId,
    name: p.pitcherName,
    sub: `P · over ${p.suggestedLine.toFixed(1)} Ks`,
    teamName: p.team,
    prob: estKOverProb(p.last5StartKs, p.strictFloorKs),
    probLabel: 'est',
    spark: formKsHtml(p.last5StartKs, p.strictFloorKs),
    flags: p.trailingEra !== null && p.trailingEra !== undefined && p.trailingEra <= 3.5
      ? '<span class="pill ok"><span class="pill-dot"></span>Low ERA arm</span>' : '',
    why: [
      whyRow('Floor', `Reached ${p.strictFloorKs}+ Ks in every recent start`),
      whyRow('Average', `${fmtNum(p.kPerStart, 1)} Ks per start`),
      whyRow('ERA', p.trailingEra !== null && p.trailingEra !== undefined ? `${fmtNum(p.trailingEra)} last 5` : null),
      whyRow('Matchup', `${p.isHome ? 'Home, ' : ''}vs ${esc(p.opponent)}`),
    ].join(''),
    mlbGameId: p.mlbGameId,
    gameDate: state.signalsDate || state.today,
  }));
  return `<div class="pick-grid">${cards.join('')}</div>`;
}

// --- jumbotron ---------------------------------------------------------------
// The rotating stadium board at the top of Daily Picks: the exact same
// top 6 that head the Daily Slate sections (lib/topPicks.js), not an
// independently-derived list, so the board and the sections below it
// always agree on what the day's best 6 calls are.
function buildBoardItems(d) {
  return (d.topPicks || []).map((p) => {
    if (p.type === 'moneyline') {
      return { personId: null, name: p.homeTeam, team: p.homeTeam, label: `ML ${p.homeMl !== null && p.homeMl !== undefined ? fmtOdds(p.homeMl) : ''}`.trim(), prob: p.breakevenPct ?? null, probLabel: 'mkt' };
    }
    if (p.type === 'hit_streak') {
      return { personId: p.batterId, name: p.batterName, team: p.team, label: '1+ HIT', prob: estHitProb(p.trailing15Avg), probLabel: 'est' };
    }
    // strikeout / K-over
    return { personId: p.pitcherId, name: p.pitcherName, team: p.team, label: `OVER ${p.suggestedLine?.toFixed(1)} K`, prob: estKOverProb(p.last5StartKs, p.strictFloorKs), probLabel: 'est' };
  });
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
  const row = items.map(chip).join('<span class="jumbo-sep"></span>') + '<span class="jumbo-sep"></span>';
  // Repeated 4x (not 2x): with only 6 short items the row can be narrower
  // than a wide desktop viewport, which makes a 2-copy loop look static
  // since there's nothing to scroll past. Four copies guarantees the
  // track overflows any real screen so the marquee is always visibly
  // moving, on phone and on desktop. The keyframe below moves exactly
  // one row-width (-25% of the 4x track), so playback speed is unchanged.
  // Each copy is wrapped in its own element (display:contents normally,
  // so it's a no-op in the flex layout) purely so prefers-reduced-motion
  // can hide copies 2-4 and show one clean row instead of the animation
  // stopping mid-track with all 4 copies dumped out statically.
  const track = Array(4).fill(0).map(() => `<div class="jumbo-copy">${row}</div>`).join('');
  return `
    <div class="jumbotron" aria-label="Today's top picks board">
      <div class="jumbo-title"><span class="jumbo-live"></span>TODAY'S BOARD</div>
      <div class="jumbo-viewport">
        <div class="jumbo-track">${track}</div>
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

// --- 9 AM go-live gate -------------------------------------------------------
// Today's picks are built off overnight probables and aren't finalized
// until the 9 AM ET run has the confirmed lineups. Only *today* is gated,
// and only before 9 AM ET, past dates are always viewable.
function currentEtHour() {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date()));
}
function isBeforeGoLive(dateStr) {
  return dateStr === state.today && currentEtHour() < 9;
}
function goLiveGate(btnId, subText) {
  return `
    <div class="golive-gate">
      <div class="golive-emoji">☕️</div>
      <div class="golive-title">Today's slate drops at 9:00 AM ET</div>
      <p class="golive-sub">${subText}</p>
      <button class="btn primary" id="${btnId}">See yesterday's picks</button>
    </div>`;
}

// silent=true is used by the 120s auto-refresh: skip the loading spinner
// and put the scroll position back so a picture that hasn't changed
// doesn't visibly jump or flash while someone's mid-read.
async function renderSignals(silent = false) {
  const host = $('#view-signals');
  if (!silent) host.innerHTML = skeletonCards(6);
  const scrollY = silent ? window.scrollY : null;
  try {
    const date = state.signalsDate || state.today;
    const [d, perf] = await Promise.all([
      api(`/api/digest?date=${date}`),
      api('/api/performance').catch(() => null), // strip is optional, never blocks the page
    ]);
    state.signalsDate = d.date;

    // Go-live gate: today's slate is built off overnight probables and
    // isn't finalized until the 9 AM ET run has confirmed lineups. Before
    // then, don't show today, offer yesterday instead.
    if (isBeforeGoLive(d.date)) {
      host.innerHTML = yesterdayStrip(perf, state.today) +
        goLiveGate('gateSeeYesterday', "The 6 best plays go live once the morning run has confirmed lineups and updated pitching. Check back at 9, or look at yesterday in the meantime.");
      $('#gateSeeYesterday')?.addEventListener('click', () => {
        state.signalsDate = addDays(state.today, -1);
        renderSignals();
      });
      if (scrollY !== null) window.scrollTo(0, scrollY);
      return;
    }

    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    // The exact top 6 picks (see lib/topPicks.js), keyed the same way the
    // server ranked them, so the sections below only show these 6, in
    // the same rank order as the jumbotron.
    const topPickKeys = new Map((d.topPicks || []).map((p, i) => [p.key, i + 1]));
    const mlBody = moneylineCards(d.moneyline, topPickKeys);
    const hitBody = hitStreakSection(d.hitStreak, topPickKeys);
    const koBody = strikeoutSection(d.strikeouts, topPickKeys);

    host.innerHTML = `
      ${jumbotronHtml(d)}
      ${yesterdayStrip(perf, d.date)}

      <div class="signals-toolbar">
        <select class="date-select" id="signalsDate">${dateOptions}</select>
        <span class="toolbar-note">${esc(longDate(d.date))}${d.updatedAt ? ` · screener ran ${esc(fmtRunTime(d.updatedAt))}` : ''}</span>
        <span class="toolbar-note" style="margin-left:auto">Today's 6 best plays</span>
      </div>

      <div class="board-head">
        <h2 class="board-title">Moneyline</h2>
        <button class="btn small" data-add-manual-pick>Add a pick</button>
      </div>
      ${manualPickCards(d.manualPicks)}
      ${mlBody || emptyHtml('No moneyline in today’s 6', 'The day’s best plays are hit and strikeout props. See all moneyline picks on the Research tab.')}

      ${hitBody ? `<h2 class="board-title">+1 Hits</h2>${hitBody}` : ''}

      ${koBody ? `<h2 class="board-title">Strikeouts</h2>${koBody}` : ''}

      <h2 class="board-title">Close Calls</h2>
      ${nearMissCards(d.moneyline.otherGames) || emptyHtml('No close calls', 'Nothing else came near the cut today.')}

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

// Auto-refresh: the pipeline updates lineups/odds through the day, so
// Daily Picks quietly re-fetches itself every 120s while it's the active
// tab.
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
  if (name === 'slate') renderResearch();
  if (name === 'signals') renderSignals();
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

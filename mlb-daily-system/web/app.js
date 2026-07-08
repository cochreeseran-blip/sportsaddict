/* SlateFinder client — vanilla JS single-page app, no build step.
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
  view: 'slate',
  signalsDate: null,
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
const fmtOdds = (ml) => (ml === null || ml === undefined ? '—' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

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
function fmtRunTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
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
// SLATE VIEW — today's games only. Open a game for lineups, batting order,
// and pitcher form.
function renderSlateShell() {
  $('#view-slate').innerHTML = `
    <div class="section-head"><h2 class="section-title">Today's slate</h2></div>
    <p class="section-sub">${esc(longDate(state.today))}</p>
    <div id="slateGames">${loadingHtml}</div>`;
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
  const date = state.today;
  host.innerHTML = loadingHtml;
  try {
    let slate = state.slateCache.get(date);
    if (!slate) {
      slate = await api(`/api/slate?date=${encodeURIComponent(date)}`);
      state.slateCache.set(date, slate);
      // Today's games are live — don't let the cache go stale.
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
        await apiSend('/api/bets/grade', 'POST');
        await renderBets();
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
  const breakeven = p.breakevenPct !== null && p.breakevenPct !== undefined ? `${(p.breakevenPct * 100).toFixed(1)}%` : '—';
  const edge = p.eraEdge !== null && p.eraEdge !== undefined ? fmtNum(p.eraEdge) : null;
  return `
    <div class="sig-card">
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam)}</span>
        <span class="sig-odds">${fmtOdds(p.homeMl)}</span>
      </div>
      <div class="sig-sub">To beat ${esc(p.awayTeam)} at home${edge ? ` — home starter's ERA is <strong>${edge} runs better</strong> (${esc(p.eraBasis ?? '')})` : ''}.</div>
      <div class="ml-matchup">
        ${starterEra(p.homeStarterName, p.homeStarterTrailingEra, p.homeStarterSeasonEra, true)}
        <span class="ml-vs">vs</span>
        ${starterEra(p.awayStarterName, p.awayStarterTrailingEra, p.awayStarterSeasonEra, false)}
      </div>
      <div class="sig-note">Needs to win ${breakeven} of the time at ${fmtOdds(p.homeMl)} just to break even — not a prediction it will.</div>
      <div style="margin-top:10px">${trackBtn(pickPrefill({ type: 'moneyline', headline: `${p.homeTeam} ML (${fmtOdds(p.homeMl)}) vs ${p.awayTeam}`, odds: p.homeMl, mlbGameId: p.mlbGameId }))}</div>
    </div>`;
}

function moneylineCards(ml) {
  if (ml.signal === 'SIT' || !ml.picks?.length) {
    return emptyHtml('SIT — no qualifying games', 'No home favorite between -100 and -250 today whose starting pitcher has the better ERA than the visitor. The nearest misses are listed below.');
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
      <div class="sig-note">Needs to win ${p.breakevenPct !== null && p.breakevenPct !== undefined ? (p.breakevenPct * 100).toFixed(1) + '%' : '—'} of the time at ${fmtOdds(p.homeMl)} just to break even.</div>
      <div style="margin-top:10px;display:flex;gap:10px">
        ${trackBtn(pickPrefill({ type: 'moneyline', headline: `${p.homeTeam} ML (${fmtOdds(p.homeMl)}) vs ${p.awayTeam}`, odds: p.homeMl, mlbGameId: p.mlbGameId }))}
        <button class="btn ghost small" data-delete-manual-pick="${p.id}">Remove</button>
      </div>
    </div>`).join('')}</div>`;
}

function nearMissCards(otherGames) {
  if (!otherGames?.length) return '';
  return `
    <p class="section-sub" style="margin-top:18px">Close calls</p>
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

function opposingStarterCell(b) {
  return `${esc(b.opposingStarterName ?? 'TBD')}${
    b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined
      ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : b.opposingStarterTrailingEra >= 4.5 ? '' : 'pos'}" style="font-size:11px;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA last 3${b.weakerArm ? ' (weaker arm)' : ''}</div>`
      : ''
  }`;
}

function hitStreakSection(hs) {
  if (!hs.watchList?.length) return emptyHtml('No qualifying batters', 'Nobody clears the bar today.');
  const rows = hs.watchList.map((b, i) => `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td class="mono faint rank-col">${i + 1}</td>
      <td>${playerCell(b, b.highConfidence ? '<span class="pill info"><span class="pill-dot"></span>Prime matchup</span>' : '')}</td>
      <td><span class="mono">${b.hitStreak >= 5 ? `${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)}`}</span><div class="faint" style="font-size:11px;margin-top:2px">${fmtNum(b.trailing15Avg, 3)} avg last 15</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${opposingStarterCell(b)}</td>
      <td style="text-align:right">${trackBtn(pickPrefill({ type: 'hit_streak', headline: `${b.batterName} to record a hit`, mlbGameId: b.mlbGameId, batterId: b.batterId }))}</td>
    </tr>`);
  return batterTable(rows, ['#', 'Hitter', 'Form', 'Last 5', 'Opposing starter', '']);
}

function windHrSection(wh) {
  if (!wh.watchList?.length) return emptyHtml('No qualifying batters', 'No power bats cleared the top-third HR-rate bar today.');
  const rows = wh.watchList.map((b, i) => `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td class="mono faint rank-col">${i + 1}</td>
      <td>${playerCell(b, b.windBlowingOut ? `<span class="pill hot"><span class="pill-dot"></span>Wind out${b.windSpeedMph ? ` ${fmtNum(b.windSpeedMph, 0)} mph` : ''}</span>` : '')}</td>
      <td><span class="mono">${fmtNum(b.trailing15HrRate, 2)}</span><div class="faint" style="font-size:11px;margin-top:2px">HR per game, last 15</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${opposingStarterCell(b)}</td>
      <td style="text-align:right">${trackBtn(pickPrefill({ type: 'wind_hr', headline: `${b.batterName} to hit a home run`, mlbGameId: b.mlbGameId, batterId: b.batterId }))}</td>
    </tr>`);
  return batterTable(rows, ['#', 'Power hitter', 'HR rate', 'Last 5', 'Opposing starter', '']);
}

function formKsHtml(ks, floor) {
  if (!ks || !ks.length) return '<span class="faint" style="font-size:11px">no data</span>';
  return `<span class="form-ks">${ks.map((k) => `<i class="${k >= floor ? 'over' : ''}">${k}</i>`).join('')}</span>`;
}

function strikeoutSection(so) {
  if (!so?.watchList?.length) {
    return emptyHtml('No strikeout spots', 'No probable starter today has a high, consistent strikeout floor over his recent starts.');
  }
  const rows = so.watchList.map((p, i) => `
    <tr>
      <td class="mono faint rank-col">${i + 1}</td>
      <td>${playerCell({ batterId: p.pitcherId, batterName: p.pitcherName, team: p.team, position: 'P', jerseyNumber: null, lineupConfirmed: null })}</td>
      <td><span class="mono" style="font-weight:600">Over ${p.suggestedLine.toFixed(1)} Ks</span><div class="faint" style="font-size:11px;margin-top:2px">Reached ${p.strictFloorKs}+ in every recent start</div></td>
      <td>${formKsHtml(p.last5StartKs, p.strictFloorKs)}<div class="faint" style="font-size:11px;margin-top:3px">Ks by start, oldest first</div></td>
      <td><span class="mono">${fmtNum(p.kPerStart, 1)}</span><div class="faint" style="font-size:11px;margin-top:2px">Ks per start</div></td>
      <td>vs ${esc(p.opponent)}</td>
      <td style="text-align:right">${trackBtn({ description: `${p.pitcherName} over ${p.suggestedLine.toFixed(1)} strikeouts`, odds: null, betKind: 'manual', mlbGameId: p.mlbGameId, batterId: null, gameDate: state.signalsDate || state.today })}</td>
    </tr>`);
  return batterTable(rows, ['#', 'Pitcher', 'Suggested line', 'Recent Ks', 'Average', 'Matchup', '']);
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

      <div class="section-head">
        <h2 class="section-title">Moneyline</h2>
        <span class="section-freshness">${d.updatedAt ? `Screener last ran ${esc(fmtRunTime(d.updatedAt))}` : 'Screener has not run yet'}</span>
        <button class="btn small" style="margin-left:auto" data-add-manual-pick>Add a pick</button>
      </div>
      <p class="section-sub">Home favorites between -100 and -250 whose starting pitcher has the better ERA (last 5 starts) than the visitor.</p>
      ${manualPickCards(d.manualPicks)}
      ${moneylineCards(d.moneyline)}

      <div class="section-head"><h2 class="section-title">Projected to get a hit</h2></div>
      <p class="section-sub">Today's ten hottest bats, ranked by recent form and how weak the arm they're facing is.</p>
      ${hitStreakSection(d.hitStreak)}

      <div class="section-head"><h2 class="section-title">Projected to go deep</h2></div>
      <p class="section-sub">Top home-run rates over the last 15 games, ranked against the opposing starter. Wind blowing out is a bonus flag, not a requirement.</p>
      ${windHrSection(d.windHr)}

      <div class="section-head"><h2 class="section-title">Strikeout watch</h2></div>
      <p class="section-sub">Probable starters whose recent strikeout counts hold a consistent floor. The suggested line is what his own last starts support, not a book line.</p>
      ${strikeoutSection(d.strikeouts)}

      <div class="section-head"><h2 class="section-title">All home favorites considered</h2></div>
      <p class="section-sub">Everything the screener evaluated for the moneyline section and why each one did or did not make it.</p>
      ${nearMissCards(d.moneyline.otherGames) || emptyHtml('Nothing else evaluated', 'Every home favorite today either qualified or there were none.')}`;

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
      ${tiles ? `<div class="stat-tiles">${tiles}</div>` : emptyHtml('No picks tracked yet', 'Picks accumulate as the daily refresh finds qualifying signals.')}

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
      closeManualPickModal();
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

  // Manual pick modal wiring + delegated add/delete buttons.
  $('#manualPickForm').addEventListener('submit', submitManualPick);
  $('#mpCancel').addEventListener('click', closeManualPickModal);
  $('#manualPickModal').addEventListener('click', (e) => { if (e.target === $('#manualPickModal')) closeManualPickModal(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-manual-pick]')) openManualPickModal();
    const delBtn = e.target.closest('[data-delete-manual-pick]');
    if (delBtn) deleteManualPick(Number(delBtn.dataset.deleteManualPick));
  });

  // Account gate + topbar chip.
  wireAuth();

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

  renderSlateShell();
  loadSlateGames();
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

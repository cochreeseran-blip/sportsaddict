/* SlateFinder client, vanilla JS single-page app, no build step.
   Views: Daily Slate (every game + the full moneyline board with graded
   results, the free core), Research (the matchup lab: hot bats and K
   floors as analysis tables), Live Chat. All data comes from this
   server's /api/* endpoints; logos and headshots load from MLB's public
   CDN. */

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
  digestCache: new Map(),
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

// Confirmed gets a pill; anything short of confirmed says nothing, the
// lineup section itself already reads "not posted yet" until it's real.
function lineupPill(confirmed, confirmedAt) {
  if (confirmed === true) {
    const when = confirmedAt ? ` · ${etDateTime(confirmedAt)}` : '';
    return `<span class="pill ok"><span class="pill-dot"></span>Lineup confirmed${esc(when)}</span>`;
  }
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
// RESEARCH TAB: the matchup lab. Deep tables, not pick cards: who's
// swinging it against a beatable arm, whose strikeout floor is real,
// every number the screener weighed laid out to be read. Research, not
// promises. Free for now, this is the part that pay-gates later.

// Hot bats vs beatable arms: the ranked hitter pool with all the numbers
// the screener used. Every row expands: click it and the full breakdown
// drops out underneath (form, streak, the arm he's facing, lineup state),
// with a jump straight into that game's panel.
function hitterDetailRow(b, date) {
  const stat = (k, v) => `<div class="exp-stat"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const era = b.opposingStarterTrailingEra;
  const arm = b.opposingStarterName
    ? `${esc(b.opposingStarterName)}${era !== null && era !== undefined ? `, ${fmtNum(era)} ERA over his last starts` : ', no ERA data yet'}`
    : 'Starter not announced yet';
  return `
    <tr class="exp-detail" hidden><td colspan="6">
      <div class="exp-grid">
        ${stat('Batting form', b.trailing15Avg !== null && b.trailing15Avg !== undefined ? `<b class="mono">${fmtNum(b.trailing15Avg, 3)}</b> over his last 15 games` : 'No trailing average yet')}
        ${stat('Hit streak', b.hitStreak >= 2 ? `<b class="mono">${b.hitStreak}</b> straight games with a hit` : 'No active streak')}
        ${stat('Last 5 games', `${form5Html(b.last5Results)} <span class="faint">hit / no hit</span>`)}
        ${stat('The matchup', arm)}
        ${stat('Arm quality', era !== null && era !== undefined ? (b.weakerArm ? 'Beatable: this arm has been giving up runs' : 'Tough: this arm has been sharp lately') : 'Unknown until he has made a start')}
        ${stat('Lineup', b.lineupConfirmed ? 'Officially in today’s lineup' : 'Not posted yet, check back closer to first pitch')}
      </div>
      ${b.mlbGameId ? `<div class="exp-actions"><button class="btn small" data-open-game="${esc(b.mlbGameId)}" data-open-date="${esc(date)}">Open this game</button></div>` : ''}
    </td></tr>`;
}

function hitterResearchTable(hs, date) {
  const list = hs?.watchList || [];
  if (!list.length) return '';
  const rows = list.map((b, i) => `
    <tr class="exp-row ${b.highConfidence ? 'hc' : ''}" data-exp>
      <td class="rank-col mono">${i + 1}</td>
      <td>${playerCell(b, b.highConfidence ? '<span class="pill info"><span class="pill-dot"></span>Prime matchup</span>' : '')}</td>
      <td class="mono">${b.trailing15Avg !== null && b.trailing15Avg !== undefined ? `<strong>${fmtNum(b.trailing15Avg, 3)}</strong>` : '-'}</td>
      <td class="mono">${b.hitStreak >= 2 ? `${b.hitStreak}` : '-'}</td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${opposingStarterCell(b)}<span class="exp-caret" aria-hidden="true">▾</span></td>
    </tr>
    ${hitterDetailRow(b, date)}`).join('');
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th class="rank-col">#</th><th>Batter</th><th>L15 avg</th><th>Hit streak</th><th>Last 5</th><th>Opposing starter</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Strikeout floors: starters who cleared the same K bar in every recent
// start, with the floor, the volume, and how the arm is actually throwing.
function strikeoutResearchTable(so) {
  const list = so?.watchList || [];
  if (!list.length) return '';
  const rows = list.map((p, i) => `
    <tr>
      <td class="rank-col mono">${i + 1}</td>
      <td>
        <div class="player-cell">
          ${headshotHtml(p.pitcherId, p.pitcherName)}
          <div>
            <div class="player-nm">${esc(p.pitcherName)}</div>
            <div class="player-meta"><span>${esc(TEAMS[p.team]?.abbrev || p.team)}</span><span>SP</span></div>
          </div>
        </div>
      </td>
      <td class="mono"><strong>${p.strictFloorKs}+</strong></td>
      <td class="mono">${fmtNum(p.kPerStart, 1)}</td>
      <td>${formKsHtml(p.last5StartKs, p.strictFloorKs)}</td>
      <td class="mono ${p.trailingEra !== null && p.trailingEra !== undefined ? (p.trailingEra <= 3.5 ? 'pos' : p.trailingEra >= 5 ? 'neg' : '') : ''}">${fmtNum(p.trailingEra)}</td>
      <td>${p.isHome ? 'vs' : 'at'} ${esc(TEAMS[p.opponent]?.abbrev || p.opponent)}</td>
    </tr>`).join('');
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th class="rank-col">#</th><th>Starter</th><th>K floor</th><th>K/start</th><th>Last 5 starts</th><th>ERA L5</th><th>Matchup</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function renderResearch() {
  const host = $('#view-slate');
  host.innerHTML = skeletonCards(6);
  try {
    const date = state.researchDate || state.today;
    const d = await api(`/api/digest?date=${date}`);
    state.researchDate = d.date;
    state.digestCache.set(d.date, d);

    if (isBeforeGoLive(d.date)) {
      host.innerHTML = `<div class="section-head"><h2 class="section-title">Research</h2></div>` +
        goLiveGate('gateSeeYesterdayR', "The research board is finalized with the 9 AM ET run. Check back at 9, or look at yesterday.");
      $('#gateSeeYesterdayR')?.addEventListener('click', () => {
        state.researchDate = addDays(state.today, -1);
        renderResearch();
      });
      return;
    }

    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    const hitCount = d.hitStreak?.watchList?.length || 0;
    const koCount = d.strikeouts?.watchList?.length || 0;
    const count = (n) => `<span class="board-count">${n}</span>`;

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title">Research</h2></div>
      <p class="section-sub">The matchup lab behind the board. Who's hot, who's facing a beatable arm, whose strikeout floor is real, with every number the screener weighed. Research, not picks; the bets live on the Daily Slate.</p>

      <div class="signals-toolbar">
        <select class="date-select" id="researchDate">${dateOptions}</select>
      </div>

      <h2 class="board-title">Hot bats vs beatable arms${count(hitCount)}</h2>
      <p class="section-sub">Ranked by recent batting form against how the opposing starter has actually been throwing. Confirm the lineup before reading anything into it.</p>
      ${hitterResearchTable(d.hitStreak, d.date) || emptyHtml('No standout bats', 'Nobody cleared the hot-bat bar against a beatable arm today.')}

      <h2 class="board-title">Strikeout floors${count(koCount)}</h2>
      <p class="section-sub">Starters who reached the same strikeout count in every one of their recent starts. The floor is history, not a guarantee.</p>
      ${strikeoutResearchTable(d.strikeouts) || emptyHtml('No reliable K floors', 'No probable starter has a high, consistent strikeout floor today.')}`;

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

// One game on the Daily Slate grid: status/score/odds at a glance, click
// anywhere to open the panel (lineups, starters, live at-bat).
function gameCardHtml(g, date) {
  const st = statusLabel(g);
  const started = g.abstractState !== 'Preview';
  const isFinal = g.abstractState === 'Final';
  const homeWon = isFinal && g.home.score !== null && g.away.score !== null && g.home.score > g.away.score;
  const awayWon = isFinal && g.home.score !== null && g.away.score !== null && g.away.score > g.home.score;

  const teamRow = (t, ml, winner) => `
    <div class="gc-team">
      ${logoHtml(t.id, t.name, 26)}
      <span class="gc-name">${esc(t.name || '?')}${t.record ? `<span class="gc-record">${esc(t.record)}</span>` : ''}</span>
      ${started
        ? `<span class="gc-score${winner ? ' winner' : ''}">${t.score ?? '-'}</span>`
        : `<span class="gc-odds${ml !== null && ml !== undefined && ml > 0 ? ' dog' : ''}">${ml !== null && ml !== undefined ? fmtOdds(ml) : ''}</span>`}
    </div>`;

  const pills = [];
  const luHome = g.lineups?.home?.posted;
  const luAway = g.lineups?.away?.posted;
  if (luHome && luAway) pills.push('<span class="pill ok"><span class="pill-dot"></span>Lineups posted</span>');
  else if (luHome || luAway) pills.push('<span class="pill warn"><span class="pill-dot"></span>One lineup posted</span>');
  else if (!started) pills.push('<span class="pill dim">Lineups pending</span>');
  if (g.abstractState === 'Live') pills.push('<span class="pill ok"><span class="pill-dot"></span>Live</span>');

  return `
    <div class="game-card" data-open-game="${esc(g.gamePk)}" data-open-date="${esc(date)}" role="button" tabindex="0">
      <div class="gc-status-row">
        <span class="gc-status ${st.cls}">${esc(st.text)}</span>
        <span class="gc-venue">${esc(g.venue || '')}</span>
      </div>
      ${teamRow(g.away, g.awayMl, awayWon)}
      ${teamRow(g.home, g.homeMl, homeWon)}
      <div class="gc-divider"></div>
      <div class="gc-pitchers">
        <div class="gc-pitcher"><span class="lbl">Away starter</span><span class="nm">${esc(g.away.starterName || 'TBD')}</span></div>
        <div class="gc-pitcher"><span class="lbl">Home starter</span><span class="nm">${esc(g.home.starterName || 'TBD')}</span></div>
      </div>
      ${pills.length ? `<div class="gc-meta">${pills.join('')}</div>` : ''}
    </div>`;
}

// live: the linescore block while the game is in progress, so the row of
// whoever's at the plate carries the baseball (and the on-deck man a hint).
// The marker moves batter to batter as the panel refreshes.
function lineupRows(side, live = null) {
  if (!side.posted || !side.batters.length) {
    return emptyHtml('Lineup not posted yet', 'Teams usually post official lineups 1-3 hours before first pitch. Check back closer to game time.');
  }
  return `<div class="lineup-list">${side.batters.map((b) => {
    const atBat = live && live.batterId === b.id;
    const onDeck = live && live.onDeckId === b.id;
    return `
    <div class="lu-row${atBat ? ' at-bat' : ''}">
      <span class="lu-order">${atBat ? '<span class="lu-ball" title="At bat">⚾</span>' : b.order}</span>
      ${headshotHtml(b.id, b.fullName)}
      <div>
        <div class="player-nm">${esc(b.fullName || 'Unknown')}${atBat ? ' <span class="lu-now">At bat</span>' : onDeck ? ' <span class="lu-now deck">On deck</span>' : ''}</div>
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
    </div>`;
  }).join('')}</div>`;
}

// Broadcast-style scorebug for a live game: bases diamond, inning with
// the half arrow, the count, and out dots, the strip you'd see in the
// corner of the TV feed.
function scorebugHtml(live) {
  if (!live) return '';
  const half = (live.inningState || '').toLowerCase();
  const arrow = half.startsWith('bot') ? '▼' : half.startsWith('top') ? '▲' : '◆';
  const outs = live.outs ?? 0;
  return `
    <div class="scorebug">
      <span class="sb-bases" role="img" aria-label="${['second','third','first'].filter((_, i) => [live.onSecond, live.onThird, live.onFirst][i]).length ? 'runners on' : 'bases empty'}">
        <i class="sb-b sb-2${live.onSecond ? ' on' : ''}"></i>
        <i class="sb-b sb-3${live.onThird ? ' on' : ''}"></i>
        <i class="sb-b sb-1${live.onFirst ? ' on' : ''}"></i>
      </span>
      <span class="sb-inning">${arrow}<b>${live.currentInning ?? ''}</b></span>
      <span class="sb-sep"></span>
      <span class="sb-count">${live.balls ?? 0}–${live.strikes ?? 0}</span>
      <span class="sb-sep"></span>
      <span class="sb-outs">${[0, 1, 2].map((i) => `<i${i < outs ? ' class="on"' : ''}></i>`).join('')}<b>OUT</b></span>
    </div>
    ${live.batterName ? `<div class="gp-live-now"><span class="lu-ball">⚾</span> ${esc(live.batterName)} at the plate${live.onDeckName ? ` · ${esc(live.onDeckName)} on deck` : ''}</div>` : ''}`;
}

// The screener's verdict on this specific game: on the board (with its
// result once graded), or the plain-English reason it didn't qualify.
// Reads the digest already cached by the board; falls back to a fetch
// when the panel opens on a date the board hasn't loaded.
async function moneylineVerdictBlock(gamePk, date) {
  if (isBeforeGoLive(date)) return ''; // today's board isn't public before 9 AM ET
  let d = state.digestCache.get(date);
  if (!d) {
    try {
      d = await api(`/api/digest?date=${date}`);
      state.digestCache.set(date, d);
    } catch { return ''; }
  }
  const idStr = String(gamePk);
  // The locked ledger, not the live re-screen: once a game's on today's
  // board it stays there (and keeps its result) even if a later run's
  // numbers would no longer qualify it.
  const pick = (d.lockedMoneyline || []).find((p) => String(p.mlbGameId) === idStr);
  if (pick) {
    return `
      <div class="gp-block">
        <div class="gp-block-title">Moneyline screen</div>
        <div class="ml-verdict on">
          <div class="mlv-head"><span class="mlv-badge">${esc(pick.homeTeam || '')} ML${pick.homeMl !== null && pick.homeMl !== undefined ? ` ${fmtOdds(pick.homeMl)}` : ''}</span>${resultChip(pick.result)}</div>
          <div class="mlv-text">${esc(pick.detail || 'On today’s board.')}</div>
        </div>
      </div>`;
  }
  const other = (d.moneyline?.otherGames || []).find((g) => String(g.mlbGameId) === idStr);
  if (other && other.reason) {
    const sentence = other.reason.charAt(0).toUpperCase() + other.reason.slice(1);
    return `
      <div class="gp-block">
        <div class="gp-block-title">Moneyline screen</div>
        <div class="ml-verdict off">
          <div class="mlv-head"><span class="mlv-badge dim">Not on the board</span></div>
          <div class="mlv-text">${esc(sentence)}.</div>
        </div>
      </div>`;
  }
  return '';
}

// While the panel is open on a live game it re-fetches itself every 60s
// so the score, scorebug, and the at-bat baseball keep moving.
let panelTimer = null;
let panelOpenKey = null;

async function openGamePanel(gamePk, date, silent = false) {
  const panel = $('#gamePanel');
  const overlay = $('#panelOverlay');
  const inner = $('#gamePanelInner');
  panel.classList.add('open');
  overlay.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  panelOpenKey = `${gamePk}:${date}`;
  clearTimeout(panelTimer);
  const panelScroll = silent ? panel.scrollTop : 0;
  if (!silent) {
    inner.innerHTML = `<button class="gp-close" id="gpClose" aria-label="Close">×</button>${skeletonPanel()}`;
    $('#gpClose').addEventListener('click', closeGamePanel);
  }

  const slateGame = (state.slateCache.get(date)?.games || []).find((g) => String(g.gamePk) === String(gamePk));

  try {
    const [d, mlBlock] = await Promise.all([
      api(`/api/game?gamePk=${gamePk}&date=${date}`),
      moneylineVerdictBlock(gamePk, date), // never throws, '' when unknown
    ]);
    // The user closed it (or opened another game) while we were fetching.
    if (panelOpenKey !== `${gamePk}:${date}`) return;
    const away = slateGame?.away || { id: d.away.teamId, name: d.away.teamName };
    const home = slateGame?.home || { id: d.home.teamId, name: d.home.teamName };
    const started = slateGame && slateGame.abstractState !== 'Preview';
    const isLive = slateGame?.abstractState === 'Live';
    const live = isLive ? d.live : null;
    // Prefer the linescore's score while live: it refreshes with the
    // panel's own 60s cycle instead of waiting on the slate cache.
    const awayScore = live && live.awayRuns !== null ? live.awayRuns : slateGame?.away?.score;
    const homeScore = live && live.homeRuns !== null ? live.homeRuns : slateGame?.home?.score;
    const liveStatus = live && live.currentInning
      ? `${live.inningState || 'Live'} ${live.currentInning}`
      : slateGame ? statusLabel(slateGame).text : '';

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
          ${started ? `<div class="gp-score">${awayScore ?? ''}</div>` : ''}
        </div>
        <div class="gp-at">${started ? esc(liveStatus) : 'at'}</div>
        <div class="gp-side">
          ${logoHtml(home.id, home.name, 62)}
          <div class="nm">${esc(home.name || 'Home')}</div>
          <div class="rec">${esc(slateGame?.home?.record || '')}</div>
          ${started ? `<div class="gp-score">${homeScore ?? ''}</div>` : ''}
        </div>
      </div>
      <div class="gp-when">${esc(longDate(date))}${slateGame && !started ? ` · ${esc(etTime(slateGame.gameDate))}` : ''}${d.venue ? ` · ${esc(d.venue)}` : ''}</div>
      ${scorebugHtml(live)}
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
        ${lineupRows(d.away, live)}
      </div>

      <div class="gp-block">
        <div class="gp-block-title">${esc(home.name || 'Home')} lineup</div>
        <div style="margin-bottom:10px">${luMeta(d.home.posted, home.name)}</div>
        ${lineupRows(d.home, live)}
      </div>

      ${mlBlock}`;
    $('#gpClose').addEventListener('click', closeGamePanel);
    if (silent) panel.scrollTop = panelScroll;
    // Keep a live game's panel moving: score, lines, and the baseball.
    if (isLive) {
      panelTimer = setTimeout(() => {
        if (panelOpenKey === `${gamePk}:${date}`) openGamePanel(gamePk, date, true);
      }, 60000);
    }
  } catch (err) {
    if (silent) return; // keep the last good render, next slate tick retries
    inner.innerHTML = `<button class="gp-close" id="gpClose" aria-label="Close">×</button>${emptyHtml('Detail unavailable', err.message)}`;
    $('#gpClose').addEventListener('click', closeGamePanel);
  }
}

function closeGamePanel() {
  clearTimeout(panelTimer);
  panelOpenKey = null;
  $('#gamePanel').classList.remove('open');
  $('#panelOverlay').classList.remove('open');
  $('#gamePanel').setAttribute('aria-hidden', 'true');
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

// W/L chip once a tracked pick has been graded against the final score.
function resultChip(result) {
  if (result === 'win') return '<span class="pill ok"><span class="pill-dot"></span>Won</span>';
  if (result === 'loss') return '<span class="pill hot"><span class="pill-dot"></span>Lost</span>';
  if (result === 'push') return '<span class="pill warn"><span class="pill-dot"></span>Push</span>';
  return '';
}

// A big, obvious badge for the day's outcome on this pick: a real win
// gets a celebratory treatment (bright green, a checkmark), not just a
// quiet pill, that's the whole point of a public track record. A pick
// still pending whose game has thrown its first pitch gets LIVE instead
// of a flat PENDING, that's the moment there's actually something to watch.
function bigResultBadge(result, liveGame) {
  if (result === 'win') return '<span class="mlv-big win"><i>✓</i>WON</span>';
  if (result === 'loss') return '<span class="mlv-big loss"><i>✕</i>LOST</span>';
  if (result === 'push') return '<span class="mlv-big push">PUSH</span>';
  if (liveGame) {
    const inn = liveGame.inning ? `${(liveGame.inningState || 'Live')} ${liveGame.inning}` : '';
    return `<span class="mlv-big live"><i class="live-dot"></i>LIVE${inn ? `<b>${esc(inn)}</b>` : ''}</span>`;
  }
  return '<span class="mlv-big pending"><i class="pulse"></i>PENDING</span>';
}

// The Moneyline Board renders the day's LOCKED ledger (see the /api/digest
// comment on lockedMoneyline server-side): every game that qualified at
// any point today, in the order it first qualified, each with its result.
// This deliberately does NOT re-derive from the live screener on every
// render, once a game's on today's board it stays there all day. Status
// (Preview/Live/Final) is looked up from the already-fetched slate so a
// pending pick flips to a LIVE badge the moment its game's first pitch is
// thrown, no extra fetch needed, the card stays clickable either way.
function lockedMoneylineCard(p, statusByGamePk) {
  const breakeven = p.breakevenPct !== null && p.breakevenPct !== undefined ? `${(p.breakevenPct * 100).toFixed(1)}%` : null;
  const isPending = !p.result || p.result === 'pending';
  const g = isPending && p.mlbGameId ? statusByGamePk?.get(String(p.mlbGameId)) : null;
  const isLive = g?.abstractState === 'Live';
  const stateCls = isLive ? 'live' : (p.result || 'pending');
  return `
    <div class="sig-card locked-${stateCls}" ${p.mlbGameId ? `data-open-game="${esc(p.mlbGameId)}" data-open-date="${esc(state.signalsDate || state.today)}" role="button" tabindex="0"` : ''}>
      <div class="sig-head">
        <span style="display:flex;align-items:center;gap:10px">${logoHtml(null, p.homeTeam, 30)} ${esc(p.homeTeam || 'Unknown')}${p.homeMl !== null && p.homeMl !== undefined ? `<span class="sig-odds" style="margin-left:4px">${fmtOdds(p.homeMl)}</span>` : ''}</span>
        ${bigResultBadge(p.result, isLive ? g : null)}
      </div>
      <div class="sig-sub">${esc(p.detail || `To beat ${p.awayTeam || 'the visitor'}.`)}</div>
      ${breakeven ? `<div class="sig-note">Break-even ${breakeven}</div>` : ''}
    </div>`;
}

function lockedMoneylineCards(picks, statusByGamePk) {
  if (!picks?.length) return '';
  return `<div class="sig-cards">${picks.map((p) => lockedMoneylineCard(p, statusByGamePk)).join('')}</div>`;
}

function opposingStarterCell(b) {
  return `${esc(b.opposingStarterName ?? 'TBD')}${
    b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined
      ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : b.opposingStarterTrailingEra >= 4.5 ? '' : 'pos'}" style="font-size:11px;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA last 3${b.weakerArm ? ' (weaker arm)' : ''}</div>`
      : ''
  }`;
}

// Last-5-starts strikeout boxes for the K-floor table: each start's K
// count, filled when it cleared the floor.
function formKsHtml(ks, floor) {
  if (!ks || !ks.length) return '<span class="faint" style="font-size:11px">no data</span>';
  return `<span class="form-ks">${ks.map((k) => `<i class="${k >= floor ? 'over' : ''}">${k}</i>`).join('')}</span>`;
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

// silent=true is used by the 60s auto-refresh: skip the loading spinner
// and put the scroll position back so a picture that hasn't changed
// doesn't visibly jump or flash while someone's mid-read.
//
// The Daily Slate is the free core of the app: every game of the day
// (live scores, click through for lineups and the at-bat marker), then
// the full moneyline board underneath, every qualifying call with its
// graded W/L. Player props live on the Research tab, not here.
async function renderSignals(silent = false) {
  const host = $('#view-signals');
  if (!silent) host.innerHTML = skeletonCards(6);
  const scrollY = silent ? window.scrollY : null;
  try {
    const date = state.signalsDate || state.today;
    const [d, slate, perf] = await Promise.all([
      api(`/api/digest?date=${date}`),
      api(`/api/slate?date=${date}`).catch(() => ({ date, games: [] })), // schedule column is best-effort
      api('/api/performance').catch(() => null), // strip is optional, never blocks the page
    ]);
    state.signalsDate = d.date;
    // The game panel reads team ids/records/status out of this cache, and
    // the moneyline verdict block reads the digest.
    state.slateCache.set(d.date, slate);
    state.digestCache.set(d.date, d);

    const dateOptions = (d.availableDates.length ? d.availableDates : [d.date])
      .map((dd) => `<option value="${dd}" ${dd === d.date ? 'selected' : ''}>${dd}</option>`).join('');

    const games = slate.games || [];
    const gamesHtml = games.length
      ? `<div class="game-grid">${games.map((g) => gameCardHtml(g, d.date)).join('')}</div>`
      : emptyHtml('No games scheduled', 'Nothing on the MLB schedule for this date.');

    // The schedule is public information and always shows; the moneyline
    // board itself is published by the 9 AM ET run and gated before then.
    const gated = isBeforeGoLive(d.date);
    const lockedPicks = d.lockedMoneyline || [];
    const mlCount = gated ? null : lockedPicks.length;
    const statusByGamePk = new Map(games.map((g) => [String(g.gamePk), g]));
    // Today so far, straight off the locked ledger for this date.
    let dayW = 0, dayL = 0, dayPend = 0;
    for (const p of lockedPicks) {
      if (p.result === 'win') dayW++;
      else if (p.result === 'loss') dayL++;
      else if (p.result === 'pending') dayPend++;
    }
    const dayRecord = !gated && (dayW + dayL + dayPend) > 0
      ? `<span class="ml-day-record${dayW > dayL ? ' up' : dayL > dayW ? ' down' : ''}">${dayW}–${dayL}${dayPend ? ` · ${dayPend} pending` : ''}</span>`
      : '';
    const mlBody = gated
      ? goLiveGate('gateSeeYesterday', 'The moneyline board is published with the 9 AM ET run, once overnight pitching and prices are in. Check back at 9, or look at how yesterday went.')
      : (lockedMoneylineCards(lockedPicks, statusByGamePk) || emptyHtml('No qualifying moneyline today', 'No home team is priced +100 to -250 with a 2+ run starting-pitcher ERA edge. Sitting out is a position too.'));

    host.innerHTML = `
      ${yesterdayStrip(perf, d.date)}

      <div class="signals-toolbar">
        <select class="date-select" id="signalsDate">${dateOptions}</select>
      </div>

      <h2 class="board-title">Games<span class="board-count">${games.length}</span></h2>
      ${gamesHtml}

      <h2 class="board-title">Moneyline Board${mlCount !== null ? `<span class="board-count">${mlCount}</span>` : ''}${dayRecord}</h2>
      ${mlBody}`;

    $('#signalsDate').addEventListener('change', (e) => {
      state.signalsDate = e.target.value;
      renderSignals();
    });
    $('#gateSeeYesterday')?.addEventListener('click', () => {
      state.signalsDate = addDays(state.today, -1);
      renderSignals();
    });
    if (scrollY !== null) window.scrollTo(0, scrollY);
  } catch (err) {
    if (!silent) host.innerHTML = emptyHtml('Slate unavailable', err.message);
    // A silent refresh that fails leaves the last good render on screen
    // rather than replacing it with an error, next tick tries again.
  }
}

// Auto-refresh: live scores and the at-bat marker move constantly during
// games, so the slate quietly re-fetches itself every 60s while it's the
// active tab.
let signalsAutoTimer = null;
function startSignalsAutoRefresh() {
  clearTimeout(signalsAutoTimer);
  signalsAutoTimer = setTimeout(async () => {
    if (state.view === 'signals') {
      await renderSignals(true);
      startSignalsAutoRefresh();
    }
  }, 60000);
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
// Latest sync warnings; the topbar status is a button that drops these
// down instead of a banner sitting at the bottom of the board.
let lastWarningsList = [];

function toggleStatusDrop(forceClose = false) {
  const drop = $('#statusDrop');
  if (!drop) return;
  if (forceClose || !drop.hidden) {
    drop.hidden = true;
    return;
  }
  drop.innerHTML = lastWarningsList.length
    ? `<div class="sd-title">Data gaps on the last sync</div><ul>${lastWarningsList.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : `<div class="sd-title">All clear</div><ul><li>The last sync finished with no data gaps.</li></ul>`;
  drop.hidden = false;
}
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
    lastWarningsList = s.lastRunWarnings || [];
    if (s.lastRunError) {
      dot.className = 'pulse-dot err';
      txt.textContent = 'Last refresh failed';
      txt.title = s.lastRunError;
    } else if (s.lastRunWarnings && s.lastRunWarnings.length) {
      dot.className = 'pulse-dot warn';
      txt.textContent = `Updated with ${s.lastRunWarnings.length} warning${s.lastRunWarnings.length === 1 ? '' : 's'}`;
      txt.title = 'Click for details';
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
    if (e.key === 'Escape') closeGamePanel();
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
    // Research rows: tap a row, its full breakdown drops out underneath.
    const row = e.target.closest('tr[data-exp]');
    if (row) {
      const detail = row.nextElementSibling;
      if (detail?.classList.contains('exp-detail')) {
        detail.hidden = !detail.hidden;
        row.classList.toggle('open', !detail.hidden);
      }
    }
  });

  // Topbar status doubles as the warnings dropdown.
  $('#sysStatus').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStatusDrop();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#statusDrop')) toggleStatusDrop(true);
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

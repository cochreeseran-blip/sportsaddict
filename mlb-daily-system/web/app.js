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
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase();
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
  if (!results || !results.length) return '<span class="faint mono" style="font-size:0.62rem">NO DATA</span>';
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

const loadingHtml = '<div class="loading"><span class="spinner"></span>Acquiring data</div>';
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
    <div class="section-head"><h2 class="section-title"><span class="idx">01</span>Slate Browser</h2><span class="section-line"></span></div>
    <p class="section-sub">Ten-day operational window — the last five days with final scores, today's board, and the next four days of scheduled matchups. Select a day, then open any game for full lineups, batting order, and pitching intel.</p>
    <div class="date-strip" id="dateStrip">
      ${days.map((d) => `
        <div class="date-chip ${d < state.today ? 'past' : ''} ${d === state.today ? 'today' : ''} ${d === state.slateDate ? 'selected' : ''}" data-date="${d}">
          <div class="dc-dow">${dowLabel(d)}</div>
          <div class="dc-date">${shortDate(d)}</div>
          <div class="dc-note">${d < state.today ? 'FINALS' : d === state.today ? 'LIVE BOARD' : 'UPCOMING'}</div>
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
  if (g.abstractState === 'Final') return { text: g.status.toUpperCase(), cls: 'final' };
  if (g.abstractState === 'Live') {
    const inn = g.inning ? `${(g.inningState || '').toUpperCase()} ${g.inning}` : 'LIVE';
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
      slate = await api(`/api/slate?date=${date}`);
      state.slateCache.set(date, slate);
      // Keep live days fresh: today/live games shouldn't stick around.
      if (date >= state.today) setTimeout(() => state.slateCache.delete(date), 120000);
    }
    if (state.slateDate !== date) return; // user already clicked elsewhere
    if (!slate.games.length) {
      host.innerHTML = emptyHtml('No games scheduled', `The league board is dark on ${longDate(date)}.`);
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
    return emptyHtml('Lineup not posted', 'MLB usually posts official lineups 1-3 hours before first pitch. Hit Sync Data closer to game time.');
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
        <div class="lu-stat"><div class="v">${b.trailing15Avg !== null && b.trailing15Avg !== undefined ? fmtNum(b.trailing15Avg, 3) : '—'}</div><div class="k">L15 AVG</div></div>
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
          L3 STARTS ERA <span class="${eraClass(s.trailingEra)}">${fmtNum(s.trailingEra)}</span><br>
          SEASON ERA <span>${fmtNum(s.seasonEra)}</span>
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
        <div class="gp-at">${started ? esc(statusLabel(slateGame).text) : 'AT'}</div>
        <div class="gp-side">
          ${logoHtml(home.id, home.name, 62)}
          <div class="nm">${esc(home.name || 'Home')}</div>
          <div class="rec">${esc(slateGame?.home?.record || '')}</div>
          ${started ? `<div class="gp-score">${slateGame?.home?.score ?? ''}</div>` : ''}
        </div>
      </div>
      <div style="text-align:center" class="mono faint" >${esc(longDate(date))}${slateGame && !started ? ` · ${esc(etTime(slateGame.gameDate))}` : ''}${d.venue ? ` · ${esc(d.venue)}` : ''}</div>
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
// SIGNALS VIEW
function topPickCard(p, i) {
  const typeLabel = { moneyline: 'Moneyline Edge', hit_streak: 'Contact Signal', wind_hr: 'Power + Weather' }[p.type] || p.type;
  const foot = [];
  if (p.lineupConfirmed === true) foot.push(lineupPill(true, null));
  if (p.lineupConfirmed === false) foot.push(lineupPill(false, null));
  if (p.last5Results) foot.push(`<span class="pill dim">L5 ${form5Html(p.last5Results)}</span>`);
  return `
    <div class="tp-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><div class="tp-rank">0${i + 1}</div><div class="tp-type">${esc(typeLabel)}</div></div>
        ${p.batterId ? headshotHtml(p.batterId, p.headline) : p.homeTeam ? logoHtml(null, p.homeTeam, 44) : ''}
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
      <div class="sig-note">BREAK-EVEN ${p.breakevenPct !== null && p.breakevenPct !== undefined ? (p.breakevenPct * 100).toFixed(1) + '%' : '—'} AT ${fmtOdds(p.homeMl)} — the win rate this price must clear, not a prediction it will.</div>
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
      <td><span class="mono">${b.hitStreak >= 5 ? `${b.hitStreak}-game streak` : `${fmtNum(b.trailing15Avg, 3)} L15`}</span><div class="faint mono" style="font-size:0.6rem;margin-top:2px">${fmtNum(b.trailing15Avg, 3)} AVG LAST 15</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : 'pos'}" style="font-size:0.66rem;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA L3</div>` : ''}</td>
      <td>${lineupPill(b.lineupConfirmed, null)}${b.highConfidence ? '<div style="margin-top:4px"><span class="pill info"><span class="pill-dot"></span>Prime matchup</span></div>' : ''}</td>
    </tr>`);
  return batterTable(rows, ['Hitter', 'Form', 'Last 5', 'Opposing starter', 'Status']);
}

function windHrSection(wh) {
  if (!wh.watchList?.length) return emptyHtml('No qualifying conditions', 'No park has 10+ mph wind blowing out today, or no power hitters cleared the top-third HR-rate bar.');
  const rows = wh.watchList.map((b) => `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td>${playerCell(b)}</td>
      <td><span class="mono">${fmtNum(b.trailing15HrRate, 2)}</span><div class="faint mono" style="font-size:0.6rem;margin-top:2px">HR / GAME L15</div></td>
      <td>${esc(b.venue ?? '')}<div class="mono faint" style="font-size:0.66rem;margin-top:2px">WIND OUT ${fmtNum(b.windSpeedMph, 1)} MPH</div></td>
      <td>${form5Html(b.last5Results)}</td>
      <td>${esc(b.opposingStarterName ?? 'TBD')}${b.opposingStarterTrailingEra !== null && b.opposingStarterTrailingEra !== undefined ? `<div class="mono ${b.opposingStarterTrailingEra >= 6 ? 'neg' : 'pos'}" style="font-size:0.66rem;margin-top:2px">${fmtNum(b.opposingStarterTrailingEra)} ERA L3</div>` : ''}</td>
      <td>${lineupPill(b.lineupConfirmed, null)}</td>
    </tr>`);
  return batterTable(rows, ['Power hitter', 'HR rate', 'Park + wind', 'Last 5', 'Opposing starter', 'Status']);
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
        <span class="toolbar-note">DIGEST FOR ${esc(longDate(d.date)).toUpperCase()}</span>
      </div>

      <div class="section-head"><h2 class="section-title"><span class="idx">01</span>Top 3 Picks</h2><span class="section-line"></span></div>
      <p class="section-sub">The strongest signals of the day, pooled and ranked across all three categories. Scored by a transparent heuristic — how badly the opposing pitcher is struggling, plus how strong each category's own signal is — not a statistical model.</p>
      ${d.topPicks?.length ? `<div class="top-picks">${d.topPicks.map(topPickCard).join('')}</div>` : emptyHtml('No pooled picks', 'No signal cleared its bar today, so nothing rose to the top.')}

      <div class="section-head"><h2 class="section-title"><span class="idx">02</span>Moneyline Edge</h2><span class="section-line"></span></div>
      <p class="section-sub">Home teams favored between -130 and -180 facing a visiting starter with a 6.00+ ERA over his last three starts.</p>
      ${moneylineCards(d.moneyline)}
      ${nearMissCards(d.moneyline.otherGames)}

      <div class="section-head"><h2 class="section-title"><span class="idx">03</span>Contact Signal</h2><span class="section-line"></span></div>
      <p class="section-sub">Hitters riding a 5+ game hit streak or batting .320+ over their last 15 games. Prime matchup marks a hot hitter facing a struggling starter.</p>
      ${hitStreakSection(d.hitStreak)}

      <div class="section-head"><h2 class="section-title"><span class="idx">04</span>Power + Weather</h2><span class="section-line"></span></div>
      <p class="section-sub">Parks with verified orientation where wind is blowing out at 10+ mph, crossed with the top third of today's hitters by recent home-run rate.</p>
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
const SIGNAL_NAMES = { moneyline: 'Moneyline Edge', hit_streak: 'Contact Signal', wind_hr: 'Power + Weather' };

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
        <td><span class="result-pill ${esc(r.result)}">${esc(r.result.toUpperCase())}</span></td>
      </tr>`);

    host.innerHTML = `
      <div class="section-head"><h2 class="section-title"><span class="idx">01</span>Signal Performance</h2><span class="section-line"></span></div>
      <p class="section-sub">Every qualifying pick is written to a permanent ledger the first time it appears each day, then graded against real results. Win rate has to beat the break-even rate implied by the locked price before a signal means anything.</p>
      ${tiles ? `<div class="stat-tiles">${tiles}</div>` : emptyHtml('Ledger is empty', 'No tracked picks yet. They accumulate automatically as the daily pipeline finds qualifying signals.')}

      <div class="section-head"><h2 class="section-title"><span class="idx">02</span>Recent Ledger</h2><span class="section-line"></span></div>
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
      txt.textContent = `Syncing ${secs}s`;
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
      txt.textContent = 'Last sync failed';
    } else if (s.lastRunAt) {
      dot.className = 'pulse-dot';
      txt.textContent = `Synced ${new Date(s.lastRunAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
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
  if (name === 'performance') renderPerformance();
}

async function init() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });
  $('#panelOverlay').addEventListener('click', closeGamePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGamePanel(); });
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

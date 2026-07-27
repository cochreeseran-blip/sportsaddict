/* Slate Addict, the public app. Vanilla JS, no build step.
   Three views: Today (the picks that were published before first pitch),
   Track record (the immutable ledger, per signal and per grade), and How
   it works (what each number means, stated plainly).

   Design principle throughout: this product's only real asset is a track
   record that cannot be edited after the fact, so the evidence is never
   more than one click away and the caveats are printed next to the
   numbers, not buried. */

'use strict';

const state = {
  view: 'today',
  user: null,
  today: new Date().toISOString().slice(0, 10),
  recordScope: 'published',
};

// ---------------------------------------------------------------------------
// Procedural avatars: every account gets a face built from its seed. Same
// seed, same face, no image hosting.
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

// --- helpers ----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdds = (ml) => (ml === null || ml === undefined ? '-' : ml > 0 ? `+${ml}` : `${ml}`);
const fmtNum = (n, d = 2) => (n === null || n === undefined ? '-' : Number(n).toFixed(d));
const fmtPct = (n, d = 0) => (n === null || n === undefined ? '-' : `${(Number(n) * 100).toFixed(d)}%`);

function longDate(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function etTime(iso) {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
}
// Chat timestamps render in the READER's own timezone, unlike game times
// (which are pinned to ET because that is how a slate is discussed).
function shortTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

function emptyState(title, msg) {
  return `<div class="empty-state"><div class="es-title">${esc(title)}</div>${esc(msg)}</div>`;
}

function gradeBadge(grade) {
  if (!grade) return '';
  const cls = `g-${String(grade).toLowerCase().replace('+', 'plus')}`;
  return `<span class="grade-badge ${cls}">${esc(grade)}</span>`;
}

// Result chip. A pick that lost says so, in the same size type as a win:
// hiding losses is exactly what makes a track record worthless.
function resultChip(result) {
  if (result === 'win') return '<span class="res-chip win">Win</span>';
  if (result === 'loss') return '<span class="res-chip loss">Loss</span>';
  if (result === 'push') return '<span class="res-chip push">Push</span>';
  return '<span class="res-chip pending">Pending</span>';
}

const SIGNAL_META = {
  strikeout: { label: 'Strikeouts', blurb: 'Pitchers whose recent starts support the over.' },
  multi_hit: { label: '2+ Hits', blurb: 'Batters projected to collect multiple hits.' },
  // Retired signal, kept so historical published picks still label
  // correctly on the record instead of showing a raw key.
  hit_streak: { label: '1+ Hit (retired)', blurb: 'No longer generated; kept on the record.' },
  home_run: { label: 'Home Runs', blurb: 'Statcast power against arms that give up homers.' },
  moneyline: { label: 'Moneyline', blurb: 'Home favorites facing a struggling starter.' },
  wind_hr: { label: 'Home Runs', blurb: 'Power spots.' },
};
const SIGNAL_ORDER = ['strikeout', 'multi_hit', 'hit_streak', 'home_run', 'moneyline', 'wind_hr'];

// ---------------------------------------------------------------------------
// TODAY
// Only picks that were PUBLISHED before first pitch appear here. That's
// the whole promise: nothing gets added after a game starts, and nothing
// gets quietly removed after it ends.

// A pick card. Leads with the player's face and the one number that
// matters for that pick type, carries the team's colour as an accent, and
// states its result plainly once graded -- losses in the same weight as
// wins, because a record that hides them is worth nothing.
function pickCard(p, opts) {
  if (p.locked) return lockedCard(p);
  const meta = SIGNAL_META[p.signalType] || { label: p.signalType };
  const featured = Boolean(opts && opts.featuredId && p.id === opts.featuredId);
  const person = p.batterId || p.pitcherId || null;
  const personName = p.batterName || p.pitcherName || '';
  const team = p.team || p.homeTeam || '';
  const isMl = p.signalType === 'moneyline';

  const lead = pickLead(p);
  const face = isMl
    ? `<span class="pc-face pc-face-team">${Media.teamLogo(p.homeTeam, 46)}</span>`
    : `<span class="pc-face">${Media.headshot(person, personName, 52)}</span>`;

  return `
    <article class="pick-card ${featured ? 'is-featured' : ''} ${p.result === 'win' ? 'is-win' : p.result === 'loss' ? 'is-loss' : ''}"
             style="--team-color:${Media.teamColor(team)}">
      ${featured ? '<div class="pc-featured-flag">Today\'s free pick</div>' : ''}
      <div class="pc-top">
        <span class="pc-kind">${esc(meta.label)}</span>
        <span class="pc-badges">${gradeBadge(p.grade)}${resultChip(p.result)}</span>
      </div>
      <div class="pc-body">
        ${face}
        <div class="pc-text">
          <h3 class="pc-headline">${esc(pickTitle(p))}</h3>
          <div class="pc-sub">${esc(pickSubtitle(p))}</div>
        </div>
      </div>
      ${lead}
      <p class="pc-detail">${esc(p.detail || '')}</p>
    </article>`;
}

// A pick the reader has not paid for. The server already stripped the
// player, the team and every number before this reached the browser, so
// there is nothing here to reveal -- this only draws the empty seat.
//
// It still shows the grade and, once the game is done, the result. That
// is the point: the locked board wins and loses in public, so the record
// on the next tab is something the reader watched happen rather than a
// number they have to take on faith.
function lockedCard(p) {
  const meta = SIGNAL_META[p.signalType] || { label: p.signalType };
  return `
    <article class="pick-card is-locked ${p.result === 'win' ? 'is-win' : p.result === 'loss' ? 'is-loss' : ''}">
      <div class="pc-top">
        <span class="pc-kind">${esc(meta.label)}</span>
        <span class="pc-badges">${gradeBadge(p.grade)}${resultChip(p.result)}</span>
      </div>
      <div class="pc-body">
        <span class="pc-face pc-face-locked" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="10" width="16" height="10" rx="2"></rect>
            <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
          </svg>
        </span>
        <div class="pc-text">
          <h3 class="pc-headline pc-headline-locked">Members only</h3>
          <div class="pc-sub">Published before first pitch</div>
        </div>
      </div>
      <div class="pc-lead pc-lead-locked" aria-hidden="true">
        <span class="pc-redact pc-redact-lg"></span>
        <span class="pc-redact pc-redact-sm"></span>
      </div>
      <p class="pc-detail pc-detail-locked" aria-hidden="true">
        <span class="pc-redact"></span><span class="pc-redact pc-redact-sm"></span>
      </p>
    </article>`;
}

// The upsell. States the count plainly and leans on the record rather
// than on urgency, because the record is the actual argument.
function upsellBlock(access, record) {
  if (!access || access.research || !access.lockedCount) return '';
  const pub = record?.published;
  const proof = pub && pub.winRate != null
    ? `The full board is ${pub.wins}-${pub.losses} on the record.`
    : 'Every pick lands on the public record, win or lose.';
  return `
    <section class="upsell">
      <div class="upsell-body">
        <h3 class="upsell-title">${access.lockedCount} more pick${access.lockedCount === 1 ? '' : 's'} on today's board</h3>
        <p class="upsell-copy">You are seeing the day's best pick free. Members get the rest, with the full projection and the reasoning behind every one. ${esc(proof)}</p>
        <div class="upsell-actions">
          <button class="btn primary" data-nav="record">See the track record first</button>
        </div>
      </div>
    </section>`;
}

// The headline: who, in as few words as possible. The full sentence lives
// in the detail line underneath.
function pickTitle(p) {
  if (p.signalType === 'moneyline') return `${p.homeTeam ?? ''} ${fmtOdds(p.homeMl)}`;
  return p.batterName || p.pitcherName || p.headline || '';
}

function pickSubtitle(p) {
  if (p.signalType === 'moneyline') return `to beat ${p.awayTeam ?? ''}`;
  const team = Media.teamAbbrev(p.team);
  if (p.signalType === 'strikeout') return `${team} · strikeouts`;
  if (p.signalType === 'multi_hit') return `${team}${Number.isInteger(p.battingOrderSlot) ? ` · batting ${p.battingOrderSlot}` : ''} · 2+ hits`;
  if (p.signalType === 'home_run') return `${team} · home run`;
  return team;
}

// The big number, chosen per signal: what this pick is actually claiming.
function pickLead(p) {
  const box = (num, label, sub) => `
    <div class="pc-lead">
      <span class="pc-lead-num">${num}</span>
      <span class="pc-lead-lbl">${label}</span>
      ${sub ? `<span class="pc-lead-sub">${sub}</span>` : ''}
    </div>`;

  if (p.signalType === 'multi_hit' && p.pAtLeastTwo != null) {
    return box(fmtPct(p.pAtLeastTwo), 'to get 2+ hits',
      p.expectedHits != null ? `${fmtNum(p.expectedHits, 2)} projected hits` : '');
  }
  if (p.signalType === 'strikeout' && p.suggestedLine != null) {
    return box(`o${fmtNum(p.suggestedLine, 1)}`, 'strikeouts',
      p.strictFloorKs != null ? `${p.strictFloorKs}+ in every recent start` : '');
  }
  if (p.signalType === 'home_run' && p.barrelPct != null) {
    return box(`${fmtNum(p.barrelPct, 1)}%`, 'barrel rate',
      p.avgExitVelo != null ? `${fmtNum(p.avgExitVelo, 1)} mph exit velo` : '');
  }
  if (p.signalType === 'moneyline' && p.homeMl != null) {
    return box(fmtOdds(p.homeMl), 'locked at publish',
      p.awayStarterTrailingEra != null ? `opposing arm ${fmtNum(p.awayStarterTrailingEra)} ERA` : '');
  }
  if (p.signalType === 'hit_streak' && p.pAtLeastOne != null) {
    return box(fmtPct(p.pAtLeastOne), 'to get a hit', '');
  }
  return '';
}

// --- live scoreboard strip ---------------------------------------------------
// The app is alive before you even look at a pick. Reads the same public
// /api/slate the rest of the site uses, so it costs no extra plumbing.
function liveStrip(games) {
  if (!games?.length) return '';
  const tiles = games.map((g) => {
    const live = g.abstractState === 'Live';
    const final = g.abstractState === 'Final';
    const state = live
      ? `<span class="ls-live"><span class="live-dot"></span>${esc((g.inningState || '').slice(0, 3).toUpperCase())} ${g.inning ?? ''}</span>`
      : final ? '<span class="ls-final">Final</span>'
      : `<span class="ls-time">${esc(etTime(g.gameDate))}</span>`;
    const showScore = live || final;
    return `
      <div class="ls-tile ${live ? 'is-live' : ''}">
        ${state}
        <div class="ls-row">
          <span class="ls-abbr">${esc(Media.teamAbbrev(g.away?.name))}</span>
          <span class="ls-score mono">${showScore ? (g.away?.score ?? 0) : ''}</span>
        </div>
        <div class="ls-row">
          <span class="ls-abbr">${esc(Media.teamAbbrev(g.home?.name))}</span>
          <span class="ls-score mono">${showScore ? (g.home?.score ?? 0) : ''}</span>
        </div>
      </div>`;
  }).join('');
  return `<div class="live-strip">${tiles}</div>`;
}

function heroBlock(record) {
  const pub = record?.published;
  if (!pub) return '';
  const rate = pub.winRate !== null && pub.winRate !== undefined
    ? `<span class="hero-rate">${fmtPct(pub.winRate, 1)}</span><span class="hero-rate-lbl">win rate</span>`
    : `<span class="hero-rate-lbl">Win rate stays hidden until the sample is big enough to mean something.</span>`;
  return `
    <div class="hero">
      <div class="hero-left">
        <h1 class="hero-title">Every pick, logged before first pitch.</h1>
        <p class="hero-sub">Published picks are written to a ledger the app itself cannot edit or delete. Wins and losses both stay on the record, permanently.</p>
      </div>
      <div class="hero-right">
        <div class="hero-wl">${pub.wins}<span class="hero-dash">-</span>${pub.losses}${pub.pushes ? `<span class="hero-push">-${pub.pushes}</span>` : ''}</div>
        <div class="hero-meta">${rate}</div>
        <button class="btn ghost small" data-nav="record">See the full record</button>
      </div>
    </div>`;
}

async function renderToday() {
  const host = $('#view-today');
  host.innerHTML = '<p class="section-sub">Loading today\'s board…</p>';
  try {
    const [digest, record, slate] = await Promise.all([
      api(`/api/digest?date=${state.today}`),
      api('/api/record').catch(() => null),
      api(`/api/slate?date=${state.today}`).catch(() => null),
    ]);

    const allPicks = digest.publishedToday || [];
    const access = digest.access || {};
    const cardOpts = { featuredId: digest.featuredPickId ?? null };

    // A free reader's one real pick is lifted out of its signal section and
    // shown first. Left in place it lands wherever its signal happens to
    // sort -- three sections down, behind a wall of locked cards -- which
    // makes the free tier feel like a locked door with a pick hidden behind
    // it rather than a pick with more available.
    const featured = access.research ? null : allPicks.find((p) => p.id === digest.featuredPickId && !p.locked);
    const picks = featured ? allPicks.filter((p) => p.id !== featured.id) : allPicks;

    const featuredBlock = featured
      ? `<section class="board-section featured-section">
           <div class="pick-grid pick-grid-single">${pickCard(featured, cardOpts)}</div>
         </section>`
      : '';

    const grouped = new Map();
    for (const p of picks) {
      if (!grouped.has(p.signalType)) grouped.set(p.signalType, []);
      grouped.get(p.signalType).push(p);
    }
    const sections = SIGNAL_ORDER.filter((k) => grouped.has(k)).map((k) => {
      const meta = SIGNAL_META[k] || { label: k, blurb: '' };
      return `
        <section class="board-section">
          <div class="board-head">
            <h2 class="board-title">${esc(meta.label)}</h2>
            <span class="board-blurb">${esc(meta.blurb || '')}</span>
          </div>
          <div class="pick-grid">${grouped.get(k).map((p) => pickCard(p, cardOpts)).join('')}</div>
        </section>`;
    }).join('');

    host.innerHTML = `
      ${heroBlock(record)}
      ${slate?.games?.length ? `
        <div class="strip-head">
          <span class="strip-title">Today's games</span>
          <span class="strip-note">${slate.games.filter((g) => g.abstractState === 'Live').length} live now</span>
        </div>
        ${liveStrip(slate.games)}` : ''}
      <div class="board-date">
        <h2 class="section-title">${esc(longDate(digest.date))}</h2>
        <span class="section-sub">${allPicks.length} published pick${allPicks.length === 1 ? '' : 's'}</span>
      </div>
      ${featuredBlock}
      ${upsellBlock(access, record)}
      ${sections || (featuredBlock ? '' : emptyState('Nothing published yet today', 'Picks go up in the morning, before first pitch. Check back shortly, or look at the track record in the meantime.'))}`;
  } catch (err) {
    host.innerHTML = emptyState('Could not load today\'s board', err.message);
  }
}

// ---------------------------------------------------------------------------
// TRACK RECORD
// The proof. Two scopes side by side so the flattering number is never
// shown without the honest one.

function perfRate(row) {
  if (row.winRate !== null && row.winRate !== undefined) {
    const cls = row.winRate >= 0.6 ? 'pos' : row.winRate < 0.45 ? 'neg' : '';
    return `<span class="mono ${cls}">${fmtPct(row.winRate, 1)}</span>`;
  }
  if (!row.graded) return '<span class="faint">no graded picks</span>';
  return `<span class="faint">${row.needsForRate} more picks needed</span>`;
}

function signalRecordCard(sig) {
  const grades = (sig.grades || []).filter((g) => g.graded > 0);
  const gradeRows = grades.map((g) => `
    <tr>
      <td>${gradeBadge(g.grade)}</td>
      <td class="mono">${g.wins}-${g.losses}</td>
      <td>${perfRate(g)}</td>
    </tr>`).join('');
  const meta = SIGNAL_META[sig.signalType] || { label: sig.label };
  return `
    <div class="rec-card">
      <div class="rec-card-head">
        <span class="rec-card-name">${esc(meta.label || sig.label)}</span>
        <span class="rec-card-wl mono">${sig.wins}-${sig.losses}${sig.pushes ? `-${sig.pushes}` : ''}</span>
      </div>
      <div class="rec-card-rate">${perfRate(sig)}</div>
      ${gradeRows ? `
        <table class="rec-grade-table">
          <thead><tr><th>Grade</th><th>W-L</th><th>Hit rate</th></tr></thead>
          <tbody>${gradeRows}</tbody>
        </table>` : '<p class="rec-card-note">Grade breakdown appears once picks finish grading.</p>'}
      ${sig.pending ? `<div class="rec-card-note">${sig.pending} still pending</div>` : ''}
    </div>`;
}

async function renderRecord() {
  const host = $('#view-record');
  host.innerHTML = '<p class="section-sub">Loading the record…</p>';
  try {
    const breakdown = await api('/api/performance/breakdown');
    const scope = state.recordScope === 'algorithm' ? breakdown.algorithm : breakdown.published;
    const scopeBtns = [
      ['published', 'Picks I called'],
      ['algorithm', 'Everything the system generated'],
    ].map(([k, label]) => `<button class="tab ${state.recordScope === k ? 'active' : ''}" data-record-scope="${k}">${label}</button>`).join('');

    host.innerHTML = `
      <div class="board-date">
        <h2 class="section-title">Track record</h2>
        <span class="section-sub">Straight counts off an append-only ledger. A published pick can never be edited or deleted, so these numbers can only get more honest.</span>
      </div>
      <nav class="tabs" style="margin:14px 0 18px">${scopeBtns}</nav>
      <div class="rec-overall">
        <div class="rec-overall-wl">${scope.overall.wins}<span class="hero-dash">-</span>${scope.overall.losses}${scope.overall.pushes ? `<span class="hero-push">-${scope.overall.pushes}</span>` : ''}</div>
        <div class="rec-overall-meta">
          <span>${scope.overall.graded} graded${scope.overall.pending ? ` · ${scope.overall.pending} pending` : ''}</span>
          <span>${scope.overall.winRate !== null ? `${fmtPct(scope.overall.winRate, 1)} overall` : `Rate hidden until ${breakdown.minGradedForRate} graded picks`}</span>
        </div>
      </div>
      ${scope.signals.length
        ? `<div class="rec-grid">${scope.signals.map(signalRecordCard).join('')}</div>`
        : emptyState('Nothing graded yet', 'Once games finish, results land here automatically.')}
      <p class="rec-disclaimer">
        ${state.recordScope === 'algorithm'
          ? 'This scope counts every pick the system generated, including ones that were never published. It is the harsher number, and it is here so the published record can be checked against it.'
          : 'This scope counts only picks published before first pitch. Switch scopes to see everything the system generated, published or not.'}
      </p>`;

    host.querySelectorAll('[data-record-scope]').forEach((btn) => {
      btn.addEventListener('click', () => { state.recordScope = btn.dataset.recordScope; renderRecord(); });
    });
  } catch (err) {
    host.innerHTML = emptyState('Record unavailable', err.message);
  }
}

// ---------------------------------------------------------------------------
// RESEARCH
// The member surface: every graded pick on the slate with the full scoring
// breakdown, not just the ones published to the free board. This is the
// thing being paid for, so when the reader has no access the tab says what
// it holds rather than pretending to be empty.
async function renderResearch() {
  const host = $('#view-research');
  host.innerHTML = '<p class="section-sub">Loading research…</p>';
  try {
    const digest = await api(`/api/digest?date=${state.today}`);
    const access = digest.access || {};

    if (!access.research) {
      host.innerHTML = `
        <div class="board-date">
          <h2 class="section-title">Research</h2>
          <span class="section-sub">Members only</span>
        </div>
        ${upsellBlock({ ...access, lockedCount: access.lockedCount || 1 }, null)}
        <div class="how-grid">
          <div class="how-card">
            <h3>What is in here</h3>
            <p>Every batter and pitcher the engine graded today, not only the ones published to the board: the full ranked list, each one's score with the exact points behind it, and the projection inputs it was built from.</p>
          </div>
          <div class="how-card">
            <h3>Why it is worth seeing</h3>
            <p>The published board is the conclusion. This is the work: which spots nearly qualified, which graded well but got cut by the per-team limit, and what separated an A from a B on the same slate.</p>
          </div>
        </div>`;
      return;
    }

    // Source is the LEDGER, not the saved digest. The ledger is every
    // candidate the engine recorded for the date, published or not, and it
    // exists the moment picks are generated. The digest is a snapshot that
    // can lag a rerun, so a research tab built on it shows an empty board
    // exactly when someone is looking. Filter boards are the fallback for
    // dates recorded before the ledger carried grades.
    const ledger = digest.ledger || [];
    const bySignal = new Map();
    for (const r of ledger) {
      if (!bySignal.has(r.signalType)) bySignal.set(r.signalType, []);
      bySignal.get(r.signalType).push(r);
    }
    for (const list of bySignal.values()) list.sort((a, b) => (b.gradeScore ?? 0) - (a.gradeScore ?? 0));

    const fallback = {
      strikeout: digest.strikeouts?.watchListAll || digest.strikeouts?.watchList || [],
      multi_hit: digest.hitStreak?.multiHitAll || digest.hitStreak?.multiHit || digest.hitStreak?.watchList || [],
      home_run: digest.windHr?.watchListAll || digest.windHr?.watchList || [],
    };
    const listFor = (kind) => (bySignal.get(kind)?.length ? bySignal.get(kind) : fallback[kind] || []);

    const boards = [
      ['strikeout', 'Strikeouts', listFor('strikeout')],
      ['multi_hit', '2+ Hits', listFor('multi_hit')],
      ['home_run', 'Home Runs', listFor('home_run')],
    ];

    const rows = (list, kind) => list.map((r, i) => {
      const name = r.batterName || r.pitcherName || '';
      const person = r.batterId || r.pitcherId || null;
      const lead = kind === 'multi_hit' && r.pAtLeastTwo != null ? fmtPct(r.pAtLeastTwo)
        : kind === 'strikeout' && r.suggestedLine != null ? `o${fmtNum(r.suggestedLine, 1)}`
        : kind === 'home_run' && r.barrelPct != null ? `${fmtNum(r.barrelPct, 1)}%`
        : '';
      return `
        <div class="rs-row">
          <span class="rs-rank mono">${i + 1}</span>
          <span class="rs-face">${Media.headshot(person, name, 34)}</span>
          <div class="rs-main">
            <div class="rs-name">${esc(name)}<span class="rs-team">${esc(Media.teamAbbrev(r.team))}</span></div>
            <div class="rs-reasons">${(r.gradeReasons || []).map((x) => `<span class="rs-chip">${esc(x)}</span>`).join('')}</div>
          </div>
          <span class="rs-lead mono">${esc(lead)}</span>
          <span class="rs-grade">${gradeBadge(r.grade)}<span class="rs-score mono">${r.gradeScore ?? ''}</span></span>
        </div>`;
    }).join('');

    host.innerHTML = `
      <div class="board-date">
        <h2 class="section-title">Research</h2>
        <span class="section-sub">${esc(longDate(digest.date))} · every graded candidate, best first</span>
      </div>
      ${boards.map(([kind, label, list]) => `
        <section class="board-section">
          <div class="board-head">
            <h2 class="board-title">${esc(label)}</h2>
            <span class="board-blurb">${list.length} graded</span>
          </div>
          <div class="rs-table">${list.length ? rows(list, kind) : '<p class="section-sub">Nothing graded on this board today.</p>'}</div>
        </section>`).join('')}`;
  } catch (err) {
    host.innerHTML = emptyState('Could not load research', err.message);
  }
}

// ---------------------------------------------------------------------------
// CHAT
// One flat room. Reading is open to anyone; posting needs an account,
// because the poster is taken from the session and never from the request
// body. Polls rather than holding a socket open: the traffic here is a
// handful of messages a minute, and a socket would be more machinery than
// the feature is worth.
let chatTimer = null;
let chatLastId = 0;

function chatBubble(m, mine) {
  return `
    <div class="chat-msg ${mine ? 'is-mine' : ''}">
      <span class="chat-avatar">${avatarSvg(m.avatarSeed, 28)}</span>
      <div class="chat-body">
        <div class="chat-meta"><span class="chat-user">${esc(m.username)}</span><span class="chat-time">${esc(shortTime(m.createdAt))}</span></div>
        <div class="chat-text">${esc(m.body)}</div>
      </div>
    </div>`;
}

function appendChat(messages) {
  if (!messages?.length) return;
  const feed = $('#chatFeed');
  if (!feed) return;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.insertAdjacentHTML('beforeend', messages.map((m) => chatBubble(m, m.userId === state.user?.id)).join(''));
  chatLastId = Math.max(chatLastId, ...messages.map((m) => m.id));
  // Only auto-scroll if the reader was already at the bottom; yanking the
  // view while someone is reading back is worse than a missed message.
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

function stopChatPolling() {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
}

function startChatPolling() {
  stopChatPolling();
  chatTimer = setInterval(async () => {
    if (state.view !== 'chat') return;
    try {
      const { messages } = await api(`/api/chat?since=${chatLastId}`);
      appendChat(messages);
    } catch { /* transient; next tick retries */ }
  }, 6000);
}

async function renderChat() {
  const host = $('#view-chat');
  chatLastId = 0;
  host.innerHTML = `
    <div class="board-date">
      <h2 class="section-title">Chat</h2>
      <span class="section-sub">One room, everyone in it.</span>
    </div>
    <div class="chat-wrap">
      <div class="chat-feed" id="chatFeed"></div>
      ${state.user
        ? `<form class="chat-form" id="chatForm">
             <input class="chat-input" id="chatInput" maxlength="500" autocomplete="off" placeholder="Say something">
             <button class="btn primary" type="submit">Send</button>
           </form>`
        : `<div class="chat-signin">
             <span>Sign in to post. Anyone can read.</span>
             <button class="btn primary small" id="chatSignIn">Sign in</button>
           </div>`}
      <div class="chat-error" id="chatError" hidden></div>
    </div>`;

  try {
    const { messages } = await api('/api/chat');
    appendChat(messages);
    const feed = $('#chatFeed');
    if (feed) feed.scrollTop = feed.scrollHeight;
  } catch (err) {
    $('#chatFeed').innerHTML = `<p class="section-sub">Could not load chat: ${esc(err.message)}</p>`;
  }

  $('#chatSignIn')?.addEventListener('click', () => openAuthGate());
  $('#chatForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const body = input.value.trim();
    if (!body) return;
    const err = $('#chatError');
    err.hidden = true;
    input.value = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      appendChat([data.message]);
      $('#chatFeed').scrollTop = $('#chatFeed').scrollHeight;
    } catch (e2) {
      // Put the text back rather than losing what they typed.
      input.value = body;
      err.textContent = e2.message;
      err.hidden = false;
    }
  });
}

// ---------------------------------------------------------------------------
// HOW IT WORKS
// Plain-language explanation of every number the app shows, including what
// it does NOT know. A research product that hides its method is a tout.
function renderHow() {
  $('#view-how').innerHTML = `
    <div class="board-date">
      <h2 class="section-title">How it works</h2>
      <span class="section-sub">What each number means, where it comes from, and what it can't tell you.</span>
    </div>

    <div class="how-grid">
      <div class="how-card">
        <h3>Strikeout props</h3>
        <p>Starts from a pitcher's <strong>floor</strong>: the strikeout count he has reached in essentially every recent start, allowing for one off night. The score then weighs his own strikeout and whiff rates against <strong>how often the opposing lineup actually strikes out</strong>, which is the input that separates a good arm in a bad spot from a good arm in a great one.</p>
      </div>
      <div class="how-card">
        <h3>Hit props, both tiers</h3>
        <p>One projection produces both boards. It estimates a per-at-bat hit probability by blending recent batting average, Savant's expected batting average, and how many hits the opposing starter actually allows, then runs it over the at-bats his lineup slot is worth. That yields the chance of <strong>1+ hit</strong> and the chance of <strong>2+ hits</strong>, which is why the two tiers never disagree.</p>
      </div>
      <div class="how-card">
        <h3>Home runs</h3>
        <p>Ranked on Statcast contact quality, mainly <strong>barrel rate</strong> and exit velocity, against arms measured by the home runs they actually give up. Recent home run count is only a minor input: over fifteen games it is mostly noise. Wind helps at parks whose orientation has been verified, and never counts as a substitute for real power.</p>
      </div>
      <div class="how-card">
        <h3>Moneyline</h3>
        <p>Two hard facts, no score: the home team is priced between -115 and -180, and the opposing starter's ERA over his last three starts is 6.00 or worse. At most two games a day clear both. Some days none do, and on those days the honest answer is to sit.</p>
      </div>
      <div class="how-card">
        <h3>The grades</h3>
        <p>A letter from A+ down to C, from a points scale over the inputs above. They are useful for ranking one pick against another on the same board. They are <strong>not fitted to betting outcomes</strong>, which is exactly why the track record breaks results down by grade, so the letters can be checked against what actually happened.</p>
      </div>
      <div class="how-card">
        <h3>Why the record is trustworthy</h3>
        <p>Publishing is one-way and enforced by the database itself, not by app code. A published pick cannot be edited, cannot be un-published, and cannot be deleted, by anyone, including the owner. Nothing can be published after a game has started. Losses stay up.</p>
      </div>
    </div>

    <div class="how-caveat">
      <h3>What this does not do</h3>
      <p>It does not know the betting line you are being offered, so it cannot tell you whether a price is good value. It does not model bullpen usage, weather beyond wind, injuries not yet reflected in a lineup, or anything about how a game is actually managed. Projections assume at-bats are independent, which they aren't. Treat everything here as research that narrows a slate, not as a prediction of the future.</p>
    </div>`;
}

// Live score polling. 45s is frequent enough to feel live without being a
// firehose; the endpoint is cached server-side for 3 minutes anyway, so a
// tighter interval would mostly return the same payload.
let scoreTimer = null;
function stopScorePolling() {
  if (scoreTimer) { clearInterval(scoreTimer); scoreTimer = null; }
}
function startScorePolling() {
  stopScorePolling();
  scoreTimer = setInterval(async () => {
    if (state.view !== 'today') return;
    try {
      const slate = await api(`/api/slate?date=${state.today}`);
      const host = document.querySelector('.live-strip');
      if (host && slate?.games?.length) {
        host.outerHTML = liveStrip(slate.games);
        const note = document.querySelector('.strip-note');
        if (note) note.textContent = `${slate.games.filter((g) => g.abstractState === 'Live').length} live now`;
      }
    } catch { /* transient; the next tick retries */ }
  }, 45000);
}

// ---------------------------------------------------------------------------
// NAV + CHROME
function showView(name) {
  state.view = name;
  document.querySelectorAll('.tab[data-view]').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'today') renderToday();
  // Only poll while the relevant tab is on screen: nobody needs live
  // scores while reading the methodology page, and an idle tab should not
  // keep asking. Same rule for the chat feed.
  if (name === 'today') startScorePolling(); else stopScorePolling();
  if (name === 'chat') startChatPolling(); else stopChatPolling();
  if (name === 'record') renderRecord();
  if (name === 'research') renderResearch();
  if (name === 'chat') renderChat();
  if (name === 'how') renderHow();
  const wantPath = name === 'today' ? '/' : `/${name}`;
  if (location.pathname !== wantPath) history.replaceState(null, '', wantPath);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// The header record chip: the headline claim, visible on every screen, and
// deliberately raw W-L rather than a percentage until the sample earns one.
async function loadRecordChip() {
  try {
    const r = await api('/api/record');
    const pub = r.published;
    if (!pub || (pub.wins + pub.losses) === 0) return;
    const chip = $('#recordChip');
    chip.innerHTML = `<span class="chip-wl mono">${pub.wins}-${pub.losses}</span>${pub.winRate !== null && pub.winRate !== undefined ? `<span class="chip-rate">${fmtPct(pub.winRate, 1)}</span>` : ''}`;
    chip.hidden = false;
  } catch { /* the chip is decoration; never block the app on it */ }
}

async function init() {
  // Install image fallbacks before anything renders, so a failed headshot
  // becomes an initials disc rather than a broken-image icon.
  Media.installFallbacks();

  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });

  // In-app nav links (e.g. "See the full record" in the hero).
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (!nav) return;
    e.preventDefault();
    showView(nav.dataset.nav);
  });

  wireAuth();

  try {
    const [status, me] = await Promise.all([
      api('/api/status').catch(() => null),
      api('/api/auth/me').catch(() => ({ user: null })),
    ]);
    if (status?.today) state.today = status.today;
    state.user = me.user;
  } catch { /* fall back to the client clock and signed-out */ }

  updateAccountChip();
  loadRecordChip();

  // Deep links: every tab is a real URL, so a shared /research or /chat
  // link opens on that tab instead of bouncing to Today.
  const ROUTES = { '/record': 'record', '/research': 'research', '/chat': 'chat', '/how': 'how' };
  showView(ROUTES[location.pathname] || 'today');
}

// ---------------------------------------------------------------------------
// ACCOUNT
let authMode = 'signup';

function rememberedEmail() {
  try { return localStorage.getItem('sa_email') || ''; } catch { return ''; }
}
function setRememberedEmail(email) {
  try {
    if (email) localStorage.setItem('sa_email', email);
    else localStorage.removeItem('sa_email');
  } catch { /* private mode etc. */ }
}

function openAuthGate() {
  $('#authGate').hidden = false;
  $('#authFormWrap').hidden = false;
  $('#authReveal').hidden = true;
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
  const mkt = $('#authMarketingRow');
  if (mkt) mkt.hidden = !signup;
  $('#authError').hidden = true;
}

function updateAccountChip() {
  const chip = $('#accountChip');
  const signIn = $('#signInBtn');
  if (!state.user) {
    chip.hidden = true;
    signIn.hidden = false;
    return;
  }
  chip.hidden = false;
  signIn.hidden = true;
  $('#accountAvatar').innerHTML = avatarSvg(state.user.avatarSeed, 26);
  $('#accountName').textContent = state.user.username;
}

function wireAuth() {
  $('#signInBtn').addEventListener('click', openAuthGate);
  $('#authSkip').addEventListener('click', closeAuthGate);
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
        // Explicit opt-in, only sent on signup; unchecked by default so
        // nobody is ever subscribed silently.
        marketingOptIn: authMode === 'signup' && $('#authMarketing')?.checked === true,
      };
      const path = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const { user } = await apiSend(path, 'POST', body);
      setRememberedEmail(remember ? body.email : '');
      state.user = user;
      updateAccountChip();
      if (authMode === 'signup') {
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
  });
}

init();

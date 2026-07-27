/* Player headshots and team logos, shared by both surfaces.
   Loaded before the surface's own bundle, so it attaches to window rather
   than using modules (neither surface has a build step).

   Images come from MLB's public CDN. The Content-Security-Policy in
   server.js already allows exactly these two hosts and nothing else.

   Every image gets a text fallback (initials for a player, abbreviation
   for a team) applied by a delegated capture-phase error listener rather
   than an inline onerror handler, because the CSP forbids inline script
   and that restriction is worth keeping. A missing headshot must never
   leave a broken-image icon on a card. */

(function (global) {
  'use strict';

  const HEADSHOT = (id, w) =>
    `https://img.mlbstatic.com/mlb-photos/image/upload/w_${w},q_auto:best/v1/people/${id}/headshot/67/current`;
  const TEAM_LOGO = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

  // Full team name -> { id, abbrev }. ids are MLB's own team ids, used for
  // the logo CDN path. Kept here so both surfaces resolve a logo the same
  // way from the team name the API returns.
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

  // Team accent colours, used for card edges and score strips so a game
  // reads as "that team" at a glance instead of every card looking alike.
  const TEAM_COLORS = {
    AZ: '#A71930', ATL: '#CE1141', BAL: '#DF4601', BOS: '#BD3039', CHC: '#0E3386',
    CWS: '#27251F', CIN: '#C6011F', CLE: '#00385D', COL: '#333366', DET: '#0C2340',
    HOU: '#EB6E1F', KC: '#004687', LAA: '#BA0021', LAD: '#005A9C', MIA: '#00A3E0',
    MIL: '#12284B', MIN: '#002B5C', NYM: '#002D72', NYY: '#0C2340', ATH: '#003831',
    OAK: '#003831', PHI: '#E81828', PIT: '#FDB827', SD: '#2F241D', SF: '#FD5A1E',
    SEA: '#0C2C56', STL: '#C41E3A', TB: '#092C5C', TEX: '#003278', TOR: '#134A8E',
    WSH: '#AB0003',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function teamAbbrev(teamName) {
    return (TEAMS[teamName] && TEAMS[teamName].abbrev) || String(teamName || '?').slice(0, 3).toUpperCase();
  }

  function teamColor(teamName) {
    return TEAM_COLORS[teamAbbrev(teamName)] || '#55585f';
  }

  function initials(name) {
    return String(name || '?')
      .split(' ')
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  // A player headshot at `size` px. personId null (or a 404 from the CDN,
  // common for a just-called-up player) degrades to an initials disc.
  function headshot(personId, name, size) {
    const px = size || 48;
    const fb = initials(name);
    if (!personId) {
      return `<span class="headshot-fallback" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.34)}px">${esc(fb)}</span>`;
    }
    // Request at 2x for crisp rendering on retina, display at 1x.
    return `<img class="headshot" style="width:${px}px;height:${px}px" loading="lazy" alt=""
      data-fb="${esc(fb)}" data-fb-class="headshot-fallback"
      src="${HEADSHOT(personId, px * 2)}">`;
  }

  // opts.silent: render an EMPTY placeholder if the logo fails, instead of
  // the abbreviation. Use this wherever the team abbreviation is already
  // printed beside the logo -- otherwise a failed image produces "NYY NYY",
  // which is what the text fallback looks like next to its own label.
  function teamLogo(teamName, size, opts) {
    const px = size || 24;
    const t = TEAMS[teamName];
    const ab = teamAbbrev(teamName);
    const silent = Boolean(opts && opts.silent);
    if (!t) {
      return silent
        ? `<span class="logo-fallback is-silent" style="width:${px}px;height:${px}px"></span>`
        : `<span class="logo-fallback" style="width:${px}px;height:${px}px">${esc(ab)}</span>`;
    }
    return `<img class="team-logo" style="width:${px}px;height:${px}px" loading="lazy" alt="${esc(teamName)}"
      data-fb="${silent ? '' : esc(ab)}" data-fb-class="logo-fallback${silent ? ' is-silent' : ''}"
      src="${TEAM_LOGO(t.id)}">`;
  }

  // Install once per page. Capture phase because error events from <img>
  // do not bubble.
  function installFallbacks() {
    if (global.__mediaFallbacksInstalled) return;
    global.__mediaFallbacksInstalled = true;
    document.addEventListener(
      'error',
      (e) => {
        const img = e.target;
        // dataset.fb may be an empty string for a silent fallback, so
        // check for the ATTRIBUTE's presence, not its truthiness.
        if (!(img instanceof HTMLImageElement) || img.dataset.fb === undefined) return;
        const span = document.createElement('span');
        span.className = img.dataset.fbClass || 'headshot-fallback';
        span.textContent = img.dataset.fb;
        if (img.style.width) {
          span.style.width = img.style.width;
          span.style.height = img.style.height;
        }
        img.replaceWith(span);
      },
      true
    );
  }

  global.Media = { headshot, teamLogo, teamAbbrev, teamColor, initials, installFallbacks, TEAMS };
})(window);

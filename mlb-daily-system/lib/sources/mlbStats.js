// Overridable so tests/local dev can point at a fixture server.
//
// Read per call rather than captured at module load: this module is
// imported at startup by the pipeline, so a constant would freeze whatever
// the environment looked like at import time and silently ignore any
// later override -- which is exactly what a fixture server needs to do.
const base = () => process.env.MLB_STATS_API_BASE || 'https://statsapi.mlb.com/api/v1';

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`MLB Stats API ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Today's schedule with probable starters. This is the same feed that
// backs mlb.com/probable-pitchers, that page is just a render of
// statsapi's schedule endpoint with probablePitcher hydration, so we use
// the identical request (probablePitcher(note),venue) and read the same
// fields. There is no separate probable-pitchers API to scrape.
export async function fetchScheduleWithProbables(dateStr) {
  const url = `${base()}/schedule?sportId=1&hydrate=probablePitcher(note),venue&date=${dateStr}`;
  const data = await fetchJson(url);
  const dates = data.dates || [];
  const games = [];
  for (const d of dates) {
    for (const g of d.games || []) {
      const home = g.teams?.home;
      const away = g.teams?.away;
      games.push({
        gamePk: g.gamePk,
        mlbGameId: String(g.gamePk),
        gameDate: g.gameDate, // ISO UTC string
        venue: g.venue?.name || null,
        homeTeamId: home?.team?.id ?? null,
        homeTeamName: home?.team?.name ?? null,
        awayTeamId: away?.team?.id ?? null,
        awayTeamName: away?.team?.name ?? null,
        homeStarterId: home?.probablePitcher?.id ?? null,
        homeStarterName: home?.probablePitcher?.fullName ?? null,
        awayStarterId: away?.probablePitcher?.id ?? null,
        awayStarterName: away?.probablePitcher?.fullName ?? null,
      });
    }
  }
  return games;
}

// Multi-day schedule for the interactive slate view: statuses, scores
// (linescore), venues, probable starters, and team ids/abbreviations in a
// single request. `lineups` hydration is best-effort, when the API
// returns it we can tell lineups are posted without a per-game boxscore
// call; when it doesn't, callers fall back gracefully.
export async function fetchScheduleRange(startDate, endDate) {
  const hydrate = 'probablePitcher,venue,team,linescore,lineups';
  const url = `${base()}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=${hydrate}`;
  const data = await fetchJson(url);
  const byDate = {};
  for (const d of data.dates || []) {
    byDate[d.date] = (d.games || []).map((g) => {
      const home = g.teams?.home;
      const away = g.teams?.away;
      return {
        gamePk: g.gamePk,
        gameDate: g.gameDate,
        officialDate: g.officialDate || d.date,
        status: g.status?.detailedState || g.status?.abstractGameState || 'Unknown',
        abstractState: g.status?.abstractGameState || 'Unknown', // Preview | Live | Final
        venue: g.venue?.name || null,
        inning: g.linescore?.currentInning ?? null,
        inningState: g.linescore?.inningState ?? null,
        home: {
          id: home?.team?.id ?? null,
          name: home?.team?.name ?? null,
          abbrev: home?.team?.abbreviation ?? null,
          record: home?.leagueRecord ? `${home.leagueRecord.wins}-${home.leagueRecord.losses}` : null,
          score: home?.score ?? null,
          starterId: home?.probablePitcher?.id ?? null,
          starterName: home?.probablePitcher?.fullName ?? null,
        },
        away: {
          id: away?.team?.id ?? null,
          name: away?.team?.name ?? null,
          abbrev: away?.team?.abbreviation ?? null,
          record: away?.leagueRecord ? `${away.leagueRecord.wins}-${away.leagueRecord.losses}` : null,
          score: away?.score ?? null,
          starterId: away?.probablePitcher?.id ?? null,
          starterName: away?.probablePitcher?.fullName ?? null,
        },
        lineupsPosted: {
          home: Boolean(g.lineups?.homePlayers?.length),
          away: Boolean(g.lineups?.awayPlayers?.length),
        },
      };
    });
  }
  return byDate;
}

// Full boxscore lineups for the game-detail view: batting order with
// jersey numbers, positions, and (for Live/Final games) the day's line.
export async function fetchBoxscoreLineups(gamePk) {
  const url = `${base()}/game/${gamePk}/boxscore`;
  const data = await fetchJson(url);
  const side = (key) => {
    const team = data.teams?.[key];
    const order = team?.battingOrder || [];
    return {
      teamId: team?.team?.id ?? null,
      teamName: team?.team?.name ?? null,
      posted: order.length > 0,
      batters: order.map((id, i) => {
        const p = team.players?.[`ID${id}`];
        return {
          id,
          order: i + 1,
          fullName: p?.person?.fullName || null,
          jerseyNumber: p?.jerseyNumber || null,
          position: p?.position?.abbreviation || null,
          battingLine: p?.stats?.batting && Object.keys(p.stats.batting).length
            ? {
                hits: p.stats.batting.hits ?? null,
                atBats: p.stats.batting.atBats ?? null,
                homeRuns: p.stats.batting.homeRuns ?? null,
                rbi: p.stats.batting.rbi ?? null,
              }
            : null,
        };
      }),
    };
  };
  return { home: side('home'), away: side('away') };
}

// Live game state for the at-bat marker: who's at the plate, who's on
// deck, and the count/outs. Only meaningful while a game is Live; for
// Preview/Final games the offense block is absent or stale, callers gate
// on the schedule's abstractGameState before showing any of this.
export async function fetchLinescore(gamePk) {
  const url = `${base()}/game/${gamePk}/linescore`;
  const data = await fetchJson(url);
  return {
    currentInning: data.currentInning ?? null,
    inningState: data.inningState ?? null,
    outs: data.outs ?? null,
    balls: data.balls ?? null,
    strikes: data.strikes ?? null,
    // Live score, so an open game panel updates on its own refresh
    // instead of waiting on the slate's schedule cache.
    homeRuns: data.teams?.home?.runs ?? null,
    awayRuns: data.teams?.away?.runs ?? null,
    // Runners for the scorebug's bases diamond.
    onFirst: Boolean(data.offense?.first),
    onSecond: Boolean(data.offense?.second),
    onThird: Boolean(data.offense?.third),
    batterId: data.offense?.batter?.id ?? null,
    batterName: data.offense?.batter?.fullName ?? null,
    onDeckId: data.offense?.onDeck?.id ?? null,
    onDeckName: data.offense?.onDeck?.fullName ?? null,
    pitcherId: data.defense?.pitcher?.id ?? null,
    pitcherName: data.defense?.pitcher?.fullName ?? null,
  };
}

// Live in-game stat line for whichever pitcher is CURRENTLY on the mound
// for a side (from the boxscore, which carries a running stat line per
// player while the game is in progress). Used by the dashboard's live
// monitor to show K-prop progress in real time and to know exactly how
// many Ks a departed starter had at the moment he was pulled.
export async function fetchLivePitcherLine(gamePk, side, pitcherId) {
  if (!pitcherId) return null;
  const url = `${base()}/game/${gamePk}/boxscore`;
  const data = await fetchJson(url);
  const p = data.teams?.[side]?.players?.[`ID${pitcherId}`];
  const s = p?.stats?.pitching;
  if (!s) return null;
  return {
    strikeouts: s.strikeOuts ?? null,
    hits: s.hits ?? null,
    earnedRuns: s.earnedRuns ?? null,
    inningsPitched: s.inningsPitched ?? null,
  };
}

// Game-by-game pitching log for the season, most recent start first.
export async function fetchPitcherGameLog(pitcherId, season) {
  const url = `${base()}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const data = await fetchJson(url);
  const splits = data.stats?.[0]?.splits || [];
  return [...splits].sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function fetchPitcherSeasonEra(pitcherId, season) {
  const url = `${base()}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;
  const data = await fetchJson(url);
  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  const era = stat?.era !== undefined ? parseFloat(stat.era) : null;
  return Number.isFinite(era) ? era : null;
}

// Game-by-game hitting log for the season, most recent game first.
export async function fetchBatterGameLog(batterId, season) {
  const url = `${base()}/people/${batterId}/stats?stats=gameLog&group=hitting&season=${season}`;
  const data = await fetchJson(url);
  const splits = data.stats?.[0]?.splits || [];
  return [...splits].sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Final score + status for a specific game, used by the grading script.
// Targeted, single-game probable-pitcher check. Probable starters are
// usually announced well before game day and are far more stable than
// same-day lineups, but a late scratch, doubleheader shuffle, or bullpen
// game can still swap one out. This is meant to be called only against
// the small handful of games that already cleared the odds filter, right
// before a pick locks in, rather than re-fetching the whole day's slate.
export async function fetchGameProbables(gamePk) {
  const url = `${base()}/schedule?gamePk=${gamePk}&hydrate=probablePitcher`;
  const data = await fetchJson(url);
  const game = data.dates?.[0]?.games?.[0];
  if (!game) return null;
  return {
    homeStarterId: game.teams?.home?.probablePitcher?.id ?? null,
    homeStarterName: game.teams?.home?.probablePitcher?.fullName ?? null,
    awayStarterId: game.teams?.away?.probablePitcher?.id ?? null,
    awayStarterName: game.teams?.away?.probablePitcher?.fullName ?? null,
  };
}

export async function fetchGameResult(gamePk) {
  const url = `${base()}/schedule?gamePk=${gamePk}`;
  const data = await fetchJson(url);
  const game = data.dates?.[0]?.games?.[0];
  if (!game) return null;
  return {
    isFinal: game.status?.abstractGameState === 'Final',
    homeTeam: game.teams?.home?.team?.name ?? null,
    awayTeam: game.teams?.away?.team?.name ?? null,
    homeScore: game.teams?.home?.score ?? null,
    awayScore: game.teams?.away?.score ?? null,
  };
}

// Best-effort today's lineup for a team/game. MLB only posts official
// lineups a couple of hours before first pitch, so this can legitimately
// come back empty earlier in the day - callers fall back to the active
// roster in that case.
export async function fetchConfirmedLineup(gamePk, side) {
  const url = `${base()}/game/${gamePk}/boxscore`;
  const data = await fetchJson(url);
  const team = data.teams?.[side];
  const order = team?.battingOrder || [];
  if (!order.length) return [];
  // battingOrder is already in actual lineup sequence (index 0 = leadoff),
  // so slot = index + 1 -- needed for the hit-prop lineup-position bonus
  // (Phase 1 spec 2B: batting 1st-3rd/4th-5th/6th+).
  return order.map((id, idx) => {
    const p = team.players?.[`ID${id}`];
    return {
      id,
      fullName: p?.person?.fullName || null,
      jerseyNumber: p?.jerseyNumber || null,
      position: p?.position?.abbreviation || null,
      battingOrderSlot: idx + 1,
    };
  });
}

// Every MLB venue with location hydration, one request for the league.
// location.azimuthAngle is the park's field orientation straight from
// MLB's own database, and defaultCoordinates carries lat/long. See
// lib/parkBearings.js for how the angles are validated before being
// trusted by the wind math.
export async function fetchVenues(season) {
  const url = `${base()}/venues?sportId=1&hydrate=location&season=${season}`;
  const data = await fetchJson(url);
  return (data.venues || []).map((v) => ({
    id: v.id,
    name: v.name,
    azimuthAngle: typeof v.location?.azimuthAngle === 'number' ? v.location.azimuthAngle : null,
    latitude: v.location?.defaultCoordinates?.latitude ?? null,
    longitude: v.location?.defaultCoordinates?.longitude ?? null,
  }));
}

// Full active roster (both pitchers and position players) in one call, so
// the pipeline can track every rostered player's form daily instead of
// just today's probable starters and confirmed lineup. One roster fetch,
// split by position, rather than a separate call per group.
export async function fetchActiveRoster(teamId) {
  const url = `${base()}/teams/${teamId}/roster?rosterType=active`;
  const data = await fetchJson(url);
  const roster = data.roster || [];
  const toPlayer = (p) => ({
    id: p.person.id,
    fullName: p.person.fullName,
    jerseyNumber: p.jerseyNumber || null,
    position: p.position?.abbreviation || null,
  });
  return {
    pitchers: roster.filter((p) => p.position?.abbreviation === 'P').map(toPlayer),
    hitters: roster.filter((p) => p.position?.abbreviation && p.position.abbreviation !== 'P').map(toPlayer),
  };
}

// Every MLB team for a season (30 clubs; historically stable but fetched
// live rather than hardcoded in case of relocation/rebrand). Used by the
// historical backfill to enumerate who to pull rosters for -- there is no
// bulk "every game log ever" endpoint, so backfill has to go team by team,
// season by season.
export async function fetchAllTeams(season) {
  const url = `${base()}/teams?sportId=1&season=${season}`;
  const data = await fetchJson(url);
  return (data.teams || []).map((t) => ({ id: t.id, name: t.name, abbrev: t.abbreviation }));
}

// A team's FULL SEASON roster (everyone who appeared for the club that
// year), not just who's active today -- rosterType=active only returns
// the current 26-man, which is useless for a historical-season backfill
// where "today" isn't the season being pulled.
export async function fetchSeasonRoster(teamId, season) {
  const url = `${base()}/teams/${teamId}/roster?rosterType=fullSeason&season=${season}`;
  const data = await fetchJson(url);
  const roster = data.roster || [];
  const toPlayer = (p) => ({
    id: p.person.id,
    fullName: p.person.fullName,
    position: p.position?.abbreviation || null,
  });
  return {
    pitchers: roster.filter((p) => p.position?.abbreviation === 'P').map(toPlayer),
    hitters: roster.filter((p) => p.position?.abbreviation && p.position.abbreviation !== 'P').map(toPlayer),
  };
}


// Career batter-vs-team splits. `vsTeamTotal` is MLB's own career total
// against one opponent, which is what the hit-prop score wants -- the
// per-season `vsTeam` variant would reset every year and almost never
// clear the 20-PA gate.
//
// Returns null (not zeros) when the split is missing, so the caller can
// tell "never faced them" apart from "faced them and did nothing".
export async function fetchBatterVsTeam(batterId, opposingTeamId) {
  const url = `${base()}/people/${batterId}/stats?stats=vsTeamTotal&group=hitting&opposingTeamId=${opposingTeamId}`;
  const data = await fetchJson(url);
  // The vsTeam feeds nest one split per opponent; with opposingTeamId set
  // there is at most one, but the shape is still an array.
  const split = data.stats?.[0]?.splits?.find((s) => s.stat) ?? null;
  if (!split) return null;
  const s = split.stat || {};
  const int = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const pa = int(s.plateAppearances);
  const ab = int(s.atBats);
  if (!pa && !ab) return null;
  return {
    plateAppearances: pa ?? 0,
    atBats: ab ?? 0,
    hits: int(s.hits) ?? 0,
    homeRuns: int(s.homeRuns) ?? 0,
    strikeOuts: int(s.strikeOuts) ?? 0,
    // MLB returns avg as a string like ".312"; recompute from the counts
    // instead so a missing/odd avg string can never poison the score.
    battingAvg: ab ? Number(((int(s.hits) ?? 0) / ab).toFixed(3)) : null,
  };
}

// Overridable so tests/local dev can point at a fixture server.
const BASE = process.env.MLB_STATS_API_BASE || 'https://statsapi.mlb.com/api/v1';

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

// Today's schedule with probable starters, hydrated per-team.
export async function fetchScheduleWithProbables(dateStr) {
  const url = `${BASE}/schedule?sportId=1&hydrate=probablePitcher,venue&date=${dateStr}`;
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
// single request. `lineups` hydration is best-effort — when the API
// returns it we can tell lineups are posted without a per-game boxscore
// call; when it doesn't, callers fall back gracefully.
export async function fetchScheduleRange(startDate, endDate) {
  const hydrate = 'probablePitcher,venue,team,linescore,lineups';
  const url = `${BASE}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=${hydrate}`;
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
  const url = `${BASE}/game/${gamePk}/boxscore`;
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

// Game-by-game pitching log for the season, most recent start first.
export async function fetchPitcherGameLog(pitcherId, season) {
  const url = `${BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`;
  const data = await fetchJson(url);
  const splits = data.stats?.[0]?.splits || [];
  return [...splits].sort((a, b) => new Date(b.date) - new Date(a.date));
}

export async function fetchPitcherSeasonEra(pitcherId, season) {
  const url = `${BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;
  const data = await fetchJson(url);
  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  const era = stat?.era !== undefined ? parseFloat(stat.era) : null;
  return Number.isFinite(era) ? era : null;
}

// Game-by-game hitting log for the season, most recent game first.
export async function fetchBatterGameLog(batterId, season) {
  const url = `${BASE}/people/${batterId}/stats?stats=gameLog&group=hitting&season=${season}`;
  const data = await fetchJson(url);
  const splits = data.stats?.[0]?.splits || [];
  return [...splits].sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Final score + status for a specific game, used by the grading script.
export async function fetchGameResult(gamePk) {
  const url = `${BASE}/schedule?gamePk=${gamePk}`;
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
  const url = `${BASE}/game/${gamePk}/boxscore`;
  const data = await fetchJson(url);
  const team = data.teams?.[side];
  const order = team?.battingOrder || [];
  if (!order.length) return [];
  return order.map((id) => {
    const p = team.players?.[`ID${id}`];
    return {
      id,
      fullName: p?.person?.fullName || null,
      jerseyNumber: p?.jerseyNumber || null,
      position: p?.position?.abbreviation || null,
    };
  });
}

// Fallback roster of position players ("regulars") when no lineup is out yet.
export async function fetchActiveHitters(teamId) {
  const url = `${BASE}/teams/${teamId}/roster?rosterType=active`;
  const data = await fetchJson(url);
  const roster = data.roster || [];
  return roster
    .filter((p) => p.position?.abbreviation && p.position.abbreviation !== 'P')
    .map((p) => ({
      id: p.person.id,
      fullName: p.person.fullName,
      jerseyNumber: p.jerseyNumber || null,
      position: p.position?.abbreviation || null,
    }));
}

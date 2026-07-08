const BASE = 'https://statsapi.mlb.com/api/v1';

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
    return { id, fullName: p?.person?.fullName || null };
  });
}

// Fallback roster of position players ("regulars") when no lineup is out yet.
export async function fetchActiveHitters(teamId) {
  const url = `${BASE}/teams/${teamId}/roster?rosterType=active`;
  const data = await fetchJson(url);
  const roster = data.roster || [];
  return roster
    .filter((p) => p.position?.abbreviation && p.position.abbreviation !== 'P')
    .map((p) => ({ id: p.person.id, fullName: p.person.fullName }));
}

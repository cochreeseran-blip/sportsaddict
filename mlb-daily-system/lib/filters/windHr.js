import { postedLineupTeams, benchedOut } from '../lineupStatus.js';

const ERA_GATE = 6.0;
const WEAK_ARM_FLOOR = 4.5;
// Not a business cap, just a safety valve, see hitStreak.js for why.
const MAX_WATCH = 200;

// Top hitters projected to go deep today: the top third of the slate by
// HR rate over the last 15 games, ranked by that rate plus how weak the
// opposing starter is. Wind blowing out at a verified park is a bonus on
// top, not a requirement - a power bat facing a meltdown arm indoors is
// still a real HR spot.
export async function runWindHrFilter(pool, gameDate) {
  const warnings = [];
  const { rows: allBatters } = await pool.query('SELECT * FROM batter_form WHERE game_date = $1', [gameDate]);

  // Same lineup gate as the hit-streak filter: once a team's lineup is
  // posted, a hitter who isn't in it has no HR prop — he isn't starting.
  // Dropped here so it never reaches the HR-rate threshold math or the
  // watch list. Before the lineup posts he stays a projected candidate.
  const postedTeams = await postedLineupTeams(pool, gameDate);
  const startingBatters = allBatters.filter((b) => !benchedOut(b, postedTeams));

  const hrRates = startingBatters
    .map((b) => (b.trailing_15_hr_rate !== null ? Number(b.trailing_15_hr_rate) : null))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);

  if (!hrRates.length) {
    return { watchList: [], highConfidence: [], hrRateThreshold: null, warnings };
  }

  // Top third of today's full batter set, computed dynamically rather than
  // a fixed rate cutoff.
  const cutoffIdx = Math.floor((2 / 3) * (hrRates.length - 1));
  const hrRateThreshold = hrRates[cutoffIdx];

  const { rows: games } = await pool.query(
    `SELECT g.*,
            (g.wind_blowing_out = true AND po.out_bearing_degrees IS NOT NULL) AS wind_out_verified,
            (g.wind_blowing_out = true AND po.out_bearing_degrees IS NULL) AS wind_out_stale
     FROM games g
     LEFT JOIN park_orientations po ON lower(po.venue) = lower(g.venue)
     WHERE g.game_date = $1`,
    [gameDate]
  );

  // A wind_blowing_out=true row at a park whose bearing is (no longer)
  // verified is stale data from an earlier run - never trust it.
  for (const g of games) {
    if (g.wind_out_stale) {
      warnings.push(`Ignoring a stale wind reading at "${g.venue}" - park orientation is unverified.`);
    }
  }

  const { rows: pitchers } = await pool.query(
    'SELECT pitcher_id, trailing_era FROM pitcher_form WHERE game_date = $1',
    [gameDate]
  );
  const trailingEraByPitcherId = new Map(
    pitchers.map((p) => [p.pitcher_id, p.trailing_era !== null ? Number(p.trailing_era) : null])
  );

  const battersByTeam = new Map();
  for (const b of startingBatters) {
    if (!battersByTeam.has(b.team)) battersByTeam.set(b.team, []);
    battersByTeam.get(b.team).push(b);
  }

  const scored = [];
  for (const g of games) {
    const windOut = g.wind_out_verified === true;
    const oppByTeam = new Map([
      [g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name }],
      [g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name }],
    ]);

    for (const team of [g.home_team, g.away_team]) {
      const teamBatters = battersByTeam.get(team) || [];
      const opp = oppByTeam.get(team);
      const opponentTrailingEra =
        opp?.starterId != null ? trailingEraByPitcherId.get(opp.starterId) ?? null : null;

      for (const b of teamBatters) {
        const hrRate = b.trailing_15_hr_rate !== null ? Number(b.trailing_15_hr_rate) : null;
        if (hrRate === null || hrRate < hrRateThreshold) continue;
        const armScore = opponentTrailingEra !== null ? Math.max(0, opponentTrailingEra - WEAK_ARM_FLOOR) : 0;
        scored.push({
          mlbGameId: g.mlb_game_id,
          batterId: b.batter_id,
          batterName: b.batter_name,
          team,
          position: b.position ?? null,
          jerseyNumber: b.jersey_number ?? null,
          trailing15HrRate: hrRate,
          lineupConfirmed: b.lineup_confirmed,
          last5Results: b.last5_results ?? [],
          venue: g.venue,
          windBlowingOut: windOut,
          windSpeedMph: windOut && g.wind_speed_mph !== null ? Number(g.wind_speed_mph) : null,
          opposingStarterName: opp?.starterName ?? null,
          opposingStarterTrailingEra: opponentTrailingEra,
          weakerArm: opponentTrailingEra !== null && opponentTrailingEra >= WEAK_ARM_FLOOR,
          highConfidence: opponentTrailingEra !== null && opponentTrailingEra >= ERA_GATE,
          score: hrRate * 10 + armScore + (windOut ? 1.5 : 0),
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const watchList = scored.slice(0, MAX_WATCH).map(({ score, ...b }) => b);

  return {
    watchList,
    highConfidence: watchList.filter((r) => r.highConfidence),
    hrRateThreshold,
    warnings,
  };
}

const HIT_STREAK_GATE = 5;
const AVG_GATE = 0.32;
const ERA_GATE = 6.0;

export async function runHitStreakFilter(pool, gameDate) {
  const { rows: games } = await pool.query('SELECT * FROM games WHERE game_date = $1', [gameDate]);

  // Opponent starter for a given team's batters (the *other* team's starter).
  const opponentByTeam = new Map();
  for (const g of games) {
    opponentByTeam.set(g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name });
    opponentByTeam.set(g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name });
  }

  const { rows: pitchers } = await pool.query(
    'SELECT pitcher_id, trailing_era FROM pitcher_form WHERE game_date = $1',
    [gameDate]
  );
  const trailingEraByPitcherId = new Map(
    pitchers.map((p) => [p.pitcher_id, p.trailing_era !== null ? Number(p.trailing_era) : null])
  );

  const { rows: batters } = await pool.query(
    `SELECT * FROM batter_form WHERE game_date = $1 AND (hit_streak >= $2 OR trailing_15_avg >= $3)`,
    [gameDate, HIT_STREAK_GATE, AVG_GATE]
  );

  const watchList = batters.map((b) => {
    const opp = opponentByTeam.get(b.team);
    const opponentTrailingEra =
      opp?.starterId != null ? trailingEraByPitcherId.get(opp.starterId) ?? null : null;
    return {
      batterName: b.batter_name,
      team: b.team,
      hitStreak: b.hit_streak,
      trailing15Avg: b.trailing_15_avg !== null ? Number(b.trailing_15_avg) : null,
      lineupConfirmed: b.lineup_confirmed,
      last5Results: b.last5_results ?? [],
      opposingStarterName: opp?.starterName ?? null,
      opposingStarterTrailingEra: opponentTrailingEra,
      highConfidence: opponentTrailingEra !== null && opponentTrailingEra >= ERA_GATE,
    };
  });

  return {
    watchList,
    highConfidence: watchList.filter((r) => r.highConfidence),
  };
}

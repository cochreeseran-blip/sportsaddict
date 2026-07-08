const HIT_STREAK_GATE = 5;
const AVG_GATE = 0.32;
const ERA_GATE = 6.0;
// "Even a little bit weaker" arm: anything worse than a league-average-ish
// trailing ERA counts toward the matchup score, not just full meltdowns.
const WEAK_ARM_FLOOR = 4.5;
const MAX_WATCH = 10;

// Top 10 hitters projected to get a hit today: hot recent form (a 5+ game
// streak or .320+ over the last 15) ranked by how hot they are and how
// weak the arm they're facing is. The ERA_GATE still marks the prime
// matchups, but a merely below-average starter now boosts a hitter's rank
// instead of being ignored.
export async function runHitStreakFilter(pool, gameDate) {
  const { rows: games } = await pool.query('SELECT * FROM games WHERE game_date = $1', [gameDate]);

  // Opponent starter for a given team's batters (the *other* team's starter).
  const opponentByTeam = new Map();
  const gameIdByTeam = new Map();
  for (const g of games) {
    opponentByTeam.set(g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name });
    opponentByTeam.set(g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name });
    gameIdByTeam.set(g.home_team, g.mlb_game_id);
    gameIdByTeam.set(g.away_team, g.mlb_game_id);
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

  const scored = batters.map((b) => {
    const opp = opponentByTeam.get(b.team);
    const opponentTrailingEra =
      opp?.starterId != null ? trailingEraByPitcherId.get(opp.starterId) ?? null : null;
    const trailing15Avg = b.trailing_15_avg !== null ? Number(b.trailing_15_avg) : null;

    // Form: streak length plus how far above .300 the trailing average
    // sits. Matchup: every run of trailing ERA above the weak-arm floor
    // adds to the score, so a hot bat facing a slightly weak arm outranks
    // an equally hot bat facing an ace.
    const formScore = (b.hit_streak ?? 0) * 0.4 + Math.max(0, (trailing15Avg ?? 0) - 0.3) * 30;
    const armScore = opponentTrailingEra !== null ? Math.max(0, opponentTrailingEra - WEAK_ARM_FLOOR) : 0;

    return {
      mlbGameId: gameIdByTeam.get(b.team) ?? null,
      batterId: b.batter_id,
      batterName: b.batter_name,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jersey_number ?? null,
      hitStreak: b.hit_streak,
      trailing15Avg,
      lineupConfirmed: b.lineup_confirmed,
      last5Results: b.last5_results ?? [],
      opposingStarterName: opp?.starterName ?? null,
      opposingStarterTrailingEra: opponentTrailingEra,
      weakerArm: opponentTrailingEra !== null && opponentTrailingEra >= WEAK_ARM_FLOOR,
      highConfidence: opponentTrailingEra !== null && opponentTrailingEra >= ERA_GATE,
      score: formScore + armScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const watchList = scored.slice(0, MAX_WATCH).map(({ score, ...b }) => b);

  return {
    watchList,
    highConfidence: watchList.filter((r) => r.highConfidence),
  };
}

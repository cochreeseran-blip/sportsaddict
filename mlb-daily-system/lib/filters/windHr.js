const ERA_GATE = 6.0;

export async function runWindHrFilter(pool, gameDate) {
  const { rows: allBatters } = await pool.query('SELECT * FROM batter_form WHERE game_date = $1', [gameDate]);

  const hrRates = allBatters
    .map((b) => (b.trailing_15_hr_rate !== null ? Number(b.trailing_15_hr_rate) : null))
    .filter((v) => v !== null)
    .sort((a, b) => a - b);

  if (!hrRates.length) {
    return { watchList: [], highConfidence: [], hrRateThreshold: null };
  }

  // Top third of today's full batter set, computed dynamically rather than
  // a fixed rate cutoff.
  const cutoffIdx = Math.floor((2 / 3) * (hrRates.length - 1));
  const hrRateThreshold = hrRates[cutoffIdx];

  const { rows: windGames } = await pool.query(
    'SELECT * FROM games WHERE game_date = $1 AND wind_blowing_out = true',
    [gameDate]
  );

  const { rows: pitchers } = await pool.query(
    'SELECT pitcher_id, trailing_era FROM pitcher_form WHERE game_date = $1',
    [gameDate]
  );
  const trailingEraByPitcherId = new Map(
    pitchers.map((p) => [p.pitcher_id, p.trailing_era !== null ? Number(p.trailing_era) : null])
  );

  const battersByTeam = new Map();
  for (const b of allBatters) {
    if (!battersByTeam.has(b.team)) battersByTeam.set(b.team, []);
    battersByTeam.get(b.team).push(b);
  }

  const watchList = [];
  for (const g of windGames) {
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
        watchList.push({
          batterName: b.batter_name,
          team,
          trailing15HrRate: hrRate,
          lineupConfirmed: b.lineup_confirmed,
          last5Results: b.last5_results ?? [],
          venue: g.venue,
          windSpeedMph: g.wind_speed_mph !== null ? Number(g.wind_speed_mph) : null,
          opposingStarterName: opp?.starterName ?? null,
          opposingStarterTrailingEra: opponentTrailingEra,
          highConfidence: opponentTrailingEra !== null && opponentTrailingEra >= ERA_GATE,
        });
      }
    }
  }

  return {
    watchList,
    highConfidence: watchList.filter((r) => r.highConfidence),
    hrRateThreshold,
  };
}

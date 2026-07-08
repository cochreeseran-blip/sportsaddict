const ERA_GATE = 6.0;

export async function runWindHrFilter(pool, gameDate) {
  const warnings = [];
  const { rows: allBatters } = await pool.query('SELECT * FROM batter_form WHERE game_date = $1', [gameDate]);

  const hrRates = allBatters
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

  // Independent guard against unverified park orientation, on top of
  // pipeline.js already refusing to set wind_blowing_out=true for those
  // parks. This belt-and-suspenders check protects against stale
  // wind_blowing_out=true rows left over from before park orientations
  // were verified (see migration 004) — this filter should never trust
  // that flag without re-confirming the park's bearing is actually known.
  const { rows: windGames } = await pool.query(
    `SELECT g.*
     FROM games g
     LEFT JOIN park_orientations po ON lower(po.venue) = lower(g.venue)
     WHERE g.game_date = $1 AND g.wind_blowing_out = true AND po.out_bearing_degrees IS NOT NULL`,
    [gameDate]
  );

  const { rows: staleWindGames } = await pool.query(
    `SELECT g.venue
     FROM games g
     LEFT JOIN park_orientations po ON lower(po.venue) = lower(g.venue)
     WHERE g.game_date = $1 AND g.wind_blowing_out = true AND po.out_bearing_degrees IS NULL`,
    [gameDate]
  );
  for (const g of staleWindGames) {
    warnings.push(`Skipped wind/HR check at "${g.venue}" — park orientation is unverified, ignoring a stale wind_blowing_out flag.`);
  }

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
    warnings,
  };
}

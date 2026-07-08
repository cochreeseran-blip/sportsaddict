const BAND_LOW = -180;
const BAND_HIGH = -130;
const BAND_MID = (BAND_LOW + BAND_HIGH) / 2; // -155
const ERA_GATE = 6.0;
const MAX_PICKS = 2;

// Home favorite in the -130..-180 band whose away starter's trailing ERA
// (last 3 starts, not season ERA) is 6.00 or worse. Season ERA is carried
// through as informational context only, per spec.
export async function runMoneylineFilter(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT g.home_team, g.away_team, g.home_ml, g.away_starter_id, g.away_starter_name,
            pf.trailing_era AS away_trailing_era, pf.season_era AS away_season_era
     FROM games g
     LEFT JOIN pitcher_form pf
       ON pf.game_date = g.game_date AND pf.pitcher_id = g.away_starter_id
     WHERE g.game_date = $1
       AND g.home_ml IS NOT NULL
       AND g.home_ml BETWEEN $2 AND $3`,
    [gameDate, BAND_LOW, BAND_HIGH]
  );

  const qualifying = rows.filter(
    (r) => r.away_trailing_era !== null && Number(r.away_trailing_era) >= ERA_GATE
  );

  qualifying.sort(
    (a, b) => Math.abs(a.home_ml - BAND_MID) - Math.abs(b.home_ml - BAND_MID)
  );

  const picks = qualifying.slice(0, MAX_PICKS).map((r) => ({
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    homeMl: r.home_ml,
    awayStarterName: r.away_starter_name,
    awayStarterTrailingEra: Number(r.away_trailing_era),
    awayStarterSeasonEra: r.away_season_era !== null ? Number(r.away_season_era) : null,
  }));

  return picks.length ? { signal: 'PLAY', picks } : { signal: 'SIT', picks: [] };
}

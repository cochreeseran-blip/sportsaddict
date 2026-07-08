const BAND_LOW = -180;
const BAND_HIGH = -130;
const BAND_MID = (BAND_LOW + BAND_HIGH) / 2; // -155
const ERA_GATE = 6.0;
const MAX_PICKS = 2;
const MAX_OTHER_GAMES = 5;

function fmtOdds(ml) {
  return ml > 0 ? `+${ml}` : `${ml}`;
}

// Home favorite in the -130..-180 band whose away starter's trailing ERA
// (last 3 starts, not season ERA) is 6.00 or worse. Season ERA is carried
// through as informational context only, per spec.
//
// Every home-favorite game is evaluated and given a plain-English reason
// for why it did or didn't qualify, so a SIT day isn't a black box — the
// closest misses (and anything that qualified but got bumped by the
// 2-pick cap) are returned as `otherGames`.
export async function runMoneylineFilter(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT g.id AS game_id, g.home_team, g.away_team, g.home_ml, g.away_starter_id, g.away_starter_name,
            pf.trailing_era AS away_trailing_era, pf.season_era AS away_season_era
     FROM games g
     LEFT JOIN pitcher_form pf
       ON pf.game_date = g.game_date AND pf.pitcher_id = g.away_starter_id
     WHERE g.game_date = $1
       AND g.home_ml IS NOT NULL
       AND g.home_ml < 0`,
    [gameDate]
  );

  const evaluated = rows.map((r) => {
    const homeMl = r.home_ml;
    const trailingEra = r.away_trailing_era !== null ? Number(r.away_trailing_era) : null;
    const inBand = homeMl >= BAND_LOW && homeMl <= BAND_HIGH;
    const bandDistance = inBand ? 0 : Math.min(Math.abs(homeMl - BAND_LOW), Math.abs(homeMl - BAND_HIGH));
    const eraQualifies = trailingEra !== null && trailingEra >= ERA_GATE;
    const eraGap = trailingEra === null ? null : Math.max(0, ERA_GATE - trailingEra);
    const qualifies = inBand && eraQualifies;

    const reasons = [];
    if (!inBand) {
      const side = homeMl > BAND_HIGH ? 'too short a favorite' : 'too heavy a favorite';
      reasons.push(`home line ${fmtOdds(homeMl)} is ${side} for the -130/-180 band (off by ${bandDistance})`);
    }
    if (!eraQualifies) {
      reasons.push(
        trailingEra === null
          ? `no trailing ERA on file yet for ${r.away_starter_name ?? 'the away starter'}`
          : `${r.away_starter_name ?? 'away starter'}'s trailing ERA is ${trailingEra.toFixed(2)}, needs ≥ ${ERA_GATE.toFixed(2)}`
      );
    }

    return {
      gameId: r.game_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      homeMl,
      awayStarterName: r.away_starter_name,
      awayStarterTrailingEra: trailingEra,
      awayStarterSeasonEra: r.away_season_era !== null ? Number(r.away_season_era) : null,
      qualifies,
      // Lower = closer to qualifying. ERA gap dominates since it's usually
      // the harder gate to clear; band distance breaks ties.
      closeness: (eraGap ?? 99) * 100 + bandDistance,
      reason: reasons.join('; '),
    };
  });

  const qualifying = evaluated
    .filter((g) => g.qualifies)
    .sort((a, b) => Math.abs(a.homeMl - BAND_MID) - Math.abs(b.homeMl - BAND_MID));

  const picks = qualifying.slice(0, MAX_PICKS);
  const pickIds = new Set(picks.map((p) => p.gameId));

  const otherGames = evaluated
    .filter((g) => !pickIds.has(g.gameId))
    .map((g) =>
      g.qualifies
        ? { ...g, closeness: -1, reason: `Qualified, but capped at ${MAX_PICKS} picks/day and ranked further from the -155 midpoint.` }
        : g
    )
    .sort((a, b) => a.closeness - b.closeness)
    .slice(0, MAX_OTHER_GAMES)
    .map(({ gameId, qualifies, closeness, ...g }) => g);

  return {
    signal: picks.length ? 'PLAY' : 'SIT',
    picks: picks.map(({ gameId, qualifies, closeness, reason, ...p }) => p),
    otherGames,
  };
}

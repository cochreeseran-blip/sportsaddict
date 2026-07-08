import { fmtOdds } from '../util/format.js';

const BAND_LOW = -180;
const BAND_HIGH = -130;
const BAND_MID = (BAND_LOW + BAND_HIGH) / 2; // -155
const ERA_GATE = 6.0;
const MAX_PICKS = 2;
const MAX_OTHER_GAMES = 5;

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

    const pitcherLabel = r.away_starter_name ?? 'the away starter';
    const reasons = [];
    if (!inBand) {
      reasons.push(
        homeMl > BAND_HIGH
          ? `${r.home_team} is only a slight favorite (${fmtOdds(homeMl)}) — we want them favored more solidly than that (odds of -130 or shorter)`
          : `${r.home_team} is too big a favorite (${fmtOdds(homeMl)}) — betting on huge favorites doesn't pay well even when they win, so we cap it at -180`
      );
    }
    if (!eraQualifies) {
      reasons.push(
        trailingEra === null
          ? `no recent pitching data yet for ${pitcherLabel} — check back once he's made a start or two`
          : `${pitcherLabel} has actually pitched well lately (${trailingEra.toFixed(2)} ERA over his last 3 starts) — we're looking for a struggling pitcher (6.00 ERA or worse), and he isn't one`
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
        ? { ...g, closeness: -1, reason: `This one actually qualified too — we just only show the top ${MAX_PICKS} picks a day, and this game wasn't as close to the sweet spot as the others.` }
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

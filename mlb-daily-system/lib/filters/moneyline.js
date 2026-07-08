import { fmtOdds, fmtNum } from '../util/format.js';
import { breakevenPct } from '../breakeven.js';

export const BAND_LOW = -250;
export const BAND_HIGH = -100;
const MAX_PICKS = 3;
const MAX_OTHER_GAMES = 5;

// The moneyline screener, in the order the research is actually done:
//   1. all of today's games
//   2. home favorites only
//   3. odds between -100 and -250
//   4. both probable starters known (the same probables MLB publishes on
//      mlb.com/starting-lineups; the pipeline re-confirms them per game
//      before a pick locks)
//   5. the HOME starter has the better (lower) ERA than the visitor —
//      compared on each pitcher's last 5 starts, falling back to season
//      ERA when someone hasn't made 5 starts yet
// Picks are ranked by the size of the home starter's ERA advantage. Both
// pitchers' last-5 and season ERAs ride along so the card shows the full
// matchup, and every evaluated game gets a plain-English reason so a SIT
// day isn't a black box.

// Compare on last-5 form when both sides have it; otherwise fall back to
// season ERA so early-season/new arms still get evaluated instead of
// silently dropped. Returns null when there's nothing to compare.
function eraComparison(home, away) {
  if (home.trailingEra !== null && away.trailingEra !== null) {
    return { basis: 'last 5 starts', homeEra: home.trailingEra, awayEra: away.trailingEra };
  }
  if (home.seasonEra !== null && away.seasonEra !== null) {
    return { basis: 'season', homeEra: home.seasonEra, awayEra: away.seasonEra };
  }
  return null;
}

export async function runMoneylineFilter(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT g.id AS game_id, g.mlb_game_id, g.home_team, g.away_team, g.home_ml,
            g.home_starter_id, g.home_starter_name, g.away_starter_id, g.away_starter_name,
            hpf.trailing_era AS home_trailing_era, hpf.season_era AS home_season_era,
            apf.trailing_era AS away_trailing_era, apf.season_era AS away_season_era
     FROM games g
     LEFT JOIN pitcher_form hpf
       ON hpf.game_date = g.game_date AND hpf.pitcher_id = g.home_starter_id
     LEFT JOIN pitcher_form apf
       ON apf.game_date = g.game_date AND apf.pitcher_id = g.away_starter_id
     WHERE g.game_date = $1
       AND g.home_ml IS NOT NULL
       AND g.home_ml < 0`,
    [gameDate]
  );

  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);

  const evaluated = rows.map((r) => {
    const homeMl = r.home_ml;
    const home = { trailingEra: num(r.home_trailing_era), seasonEra: num(r.home_season_era) };
    const away = { trailingEra: num(r.away_trailing_era), seasonEra: num(r.away_season_era) };

    const inBand = homeMl >= BAND_LOW && homeMl <= BAND_HIGH;
    const bandDistance = inBand ? 0 : Math.min(Math.abs(homeMl - BAND_LOW), Math.abs(homeMl - BAND_HIGH));

    const startersKnown = r.home_starter_name !== null && r.away_starter_name !== null;
    const cmp = startersKnown ? eraComparison(home, away) : null;
    const homeHasBetterEra = cmp !== null && cmp.homeEra < cmp.awayEra;
    const eraEdge = cmp !== null ? cmp.awayEra - cmp.homeEra : null;

    const qualifies = inBand && homeHasBetterEra;

    const reasons = [];
    if (!inBand) {
      reasons.push(
        homeMl > BAND_HIGH
          ? `${r.home_team} is not favored strongly enough (${fmtOdds(homeMl)}) — the screener wants ${BAND_HIGH} to ${BAND_LOW}`
          : `${r.home_team} is too big a favorite (${fmtOdds(homeMl)}) — huge favorites don't pay, so we cap it at ${BAND_LOW}`
      );
    }
    if (!startersKnown) {
      reasons.push('a probable starter has not been announced yet for this game — check back once MLB posts it');
    } else if (cmp === null) {
      reasons.push(`no ERA data yet for ${home.trailingEra === null && home.seasonEra === null ? r.home_starter_name : r.away_starter_name} — check back after he has made a start`);
    } else if (!homeHasBetterEra) {
      reasons.push(
        `${r.away_starter_name} (${fmtNum(cmp.awayEra)} ERA, ${cmp.basis}) has the better arm than ${r.home_starter_name} (${fmtNum(cmp.homeEra)}) — the home pitcher has to hold the edge`
      );
    }

    return {
      gameId: r.game_id,
      mlbGameId: r.mlb_game_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      homeMl,
      breakevenPct: breakevenPct(homeMl),
      eraBasis: cmp?.basis ?? null,
      eraEdge,
      homeStarterName: r.home_starter_name,
      homeStarterTrailingEra: home.trailingEra,
      homeStarterSeasonEra: home.seasonEra,
      awayStarterName: r.away_starter_name,
      awayStarterTrailingEra: away.trailingEra,
      awayStarterSeasonEra: away.seasonEra,
      qualifies,
      // Lower = closer to qualifying, for ranking near misses. A game
      // whose home arm is nearly even ranks above a lopsided one.
      closeness: (eraEdge !== null ? Math.max(0, -eraEdge) : 99) * 100 + bandDistance,
      reason: reasons.join('; '),
    };
  });

  // Biggest home-pitcher ERA advantage first.
  const qualifying = evaluated
    .filter((g) => g.qualifies)
    .sort((a, b) => b.eraEdge - a.eraEdge);

  const picks = qualifying.slice(0, MAX_PICKS);
  const pickIds = new Set(picks.map((p) => p.gameId));

  const otherGames = evaluated
    .filter((g) => !pickIds.has(g.gameId))
    .map((g) =>
      g.qualifies
        ? { ...g, closeness: -1, reason: `Qualified too, but only the top ${MAX_PICKS} ERA edges make the card — this one's edge (${fmtNum(g.eraEdge)} runs) was smaller.` }
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

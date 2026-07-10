import { fmtOdds, fmtNum } from '../util/format.js';
import { breakevenPct } from '../breakeven.js';
import { gradeMoneyline } from '../grading.js';

// Qualifying price band for the home favorite: -115 to -180 inclusive.
// Both bounds are negative by construction, "home team is the favorite"
// is built into the band itself. Price is a pre-filter only: a game
// either clears the band or it doesn't. It never decides the grade or
// the ranking (see the sort below).
export const BAND_LOW = -180;
export const BAND_HIGH = -115;

// THE deciding check, per spec: the home starter's SEASON ERA (the
// official, on-the-books number you'd see on his roster page) must be at
// least this many runs BETTER (lower) than the away starter's SEASON ERA.
// Season, not trailing form: a 3-start window is too small and too noisy
// to gate a real pick on (one blow-up swings it a full run). Trailing
// ERA and Baseball Savant metrics still ride along and feed the GRADE
// (how good a qualifying pick is), but the pass/fail gate is season ERA,
// home vs away. No edge, no pick.
const SEASON_ERA_EDGE_MIN = 2.0;

export async function runMoneylineFilter(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT g.id AS game_id, g.mlb_game_id, g.home_team, g.away_team, g.home_ml,
            g.home_starter_id, g.home_starter_name, g.away_starter_id, g.away_starter_name,
            hpf.season_era AS home_season_era, hpf.trailing_era AS home_trailing_era,
            hpf.savant_era AS home_savant_era, hpf.savant_xera AS home_savant_xera,
            hpf.savant_k_pct AS home_k_pct, hpf.savant_bb_pct AS home_bb_pct,
            hpf.savant_whiff_pct AS home_whiff_pct, hpf.savant_hard_hit_pct AS home_hard_hit_pct,
            apf.season_era AS away_season_era, apf.trailing_era AS away_trailing_era,
            apf.trailing_starts AS away_trailing_starts,
            apf.savant_era AS away_savant_era, apf.savant_xera AS away_savant_xera,
            apf.savant_k_pct AS away_k_pct, apf.savant_bb_pct AS away_bb_pct,
            apf.savant_whiff_pct AS away_whiff_pct, apf.savant_hard_hit_pct AS away_hard_hit_pct
     FROM games g
     LEFT JOIN pitcher_form hpf
       ON hpf.game_date = g.game_date AND hpf.pitcher_id = g.home_starter_id
     LEFT JOIN pitcher_form apf
       ON apf.game_date = g.game_date AND apf.pitcher_id = g.away_starter_id
     WHERE g.game_date = $1`,
    [gameDate]
  );

  // Which teams have an officially posted lineup today. When both a game's
  // teams are in here, its starters are "confirmed"; otherwise we're on the
  // projected/probable starter MLB has published.
  const { rows: confirmedRows } = await pool.query(
    `SELECT DISTINCT team FROM batter_form WHERE game_date = $1 AND lineup_confirmed = true`,
    [gameDate]
  );
  const confirmedTeams = new Set(confirmedRows.map((r) => r.team));

  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  const savantOf = (r, side) => ({
    era: num(r[`${side}_savant_era`]),
    xera: num(r[`${side}_savant_xera`]),
    kPct: num(r[`${side}_k_pct`]),
    bbPct: num(r[`${side}_bb_pct`]),
    whiffPct: num(r[`${side}_whiff_pct`]),
    hardHitPct: num(r[`${side}_hard_hit_pct`]),
  });

  const evaluated = rows.map((r) => {
    const homeMl = r.home_ml;
    const hasLine = homeMl !== null && homeMl !== undefined;
    const homeSeasonEra = num(r.home_season_era);
    const homeTrailingEra = num(r.home_trailing_era);
    const awaySeasonEra = num(r.away_season_era);
    const awayTrailingEra = num(r.away_trailing_era);
    const awayTrailingStarts = r.away_trailing_starts ?? 0;
    const homeSavant = savantOf(r, 'home');
    const awaySavant = savantOf(r, 'away');

    // Pre-filter 1: home priced -115 to -180. A game with no price yet
    // can't be checked against a band, so a real price is required.
    const inBand = hasLine && homeMl >= BAND_LOW && homeMl <= BAND_HIGH;
    const bandDistance = inBand ? 0 : hasLine ? Math.min(Math.abs(homeMl - BAND_LOW), Math.abs(homeMl - BAND_HIGH)) : 999;

    // THE gate: home season ERA at least 2 runs lower than away season ERA.
    const startersKnown = r.home_starter_name !== null && r.away_starter_name !== null;
    const haveSeasonEras = homeSeasonEra !== null && awaySeasonEra !== null;
    const seasonEdge = haveSeasonEras ? awaySeasonEra - homeSeasonEra : null; // positive = home better
    const edgeGateMet = seasonEdge !== null && seasonEdge >= SEASON_ERA_EDGE_MIN;

    const lineStatus = inBand ? 'priced' : hasLine ? 'out-of-band' : 'no-line';
    const startersConfirmed = confirmedTeams.has(r.home_team) && confirmedTeams.has(r.away_team);

    const qualifies = inBand && edgeGateMet;
    const breakeven = hasLine ? breakevenPct(homeMl) : null;

    // Grade every qualifier: how strong is this pick, not just does it
    // pass. Bigger season-ERA edge, a sharper home arm, a more hittable
    // away arm (Baseball Savant), and better price all lift the grade.
    const graded = qualifies
      ? gradeMoneyline({
          seasonEdge,
          homeSeasonEra,
          awaySeasonEra,
          breakevenPct: breakeven,
          startersConfirmed,
          homeSavant,
          awaySavant,
        })
      : null;

    const reasons = [];
    if (!hasLine) {
      reasons.push('no home moneyline price posted yet, check back once odds are live');
    } else if (!inBand) {
      reasons.push(
        homeMl > BAND_HIGH
          ? `${r.home_team} isn't enough of a favorite (${fmtOdds(homeMl)}), the screener wants ${fmtOdds(BAND_HIGH)} to ${fmtOdds(BAND_LOW)}`
          : `${r.home_team} is too big a favorite (${fmtOdds(homeMl)}), the screener wants ${fmtOdds(BAND_HIGH)} to ${fmtOdds(BAND_LOW)}`
      );
    }
    if (!startersKnown) {
      reasons.push('a starter has not been announced yet for this game, check back once MLB posts it');
    } else if (!haveSeasonEras) {
      reasons.push(
        `no season ERA on file yet for ${homeSeasonEra === null ? r.home_starter_name : r.away_starter_name}, check back after he has made a start`
      );
    } else if (!edgeGateMet) {
      reasons.push(
        seasonEdge > 0
          ? `${r.home_starter_name}'s season ERA (${fmtNum(homeSeasonEra)}) is only ${fmtNum(seasonEdge)} runs better than ${r.away_starter_name}'s (${fmtNum(awaySeasonEra)}), the screener wants a ${SEASON_ERA_EDGE_MIN.toFixed(1)}+ run edge`
          : `${r.away_starter_name} (${fmtNum(awaySeasonEra)} season ERA) has the better arm on paper than ${r.home_starter_name} (${fmtNum(homeSeasonEra)}), the home starter has to be the better arm`
      );
    }

    return {
      gameId: r.game_id,
      mlbGameId: r.mlb_game_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      homeMl: hasLine ? homeMl : null,
      breakevenPct: breakeven,
      lineStatus,
      startersConfirmed,
      homeStarterName: r.home_starter_name,
      homeStarterSeasonEra: homeSeasonEra,
      homeStarterTrailingEra: homeTrailingEra,
      awayStarterName: r.away_starter_name,
      awayStarterSeasonEra: awaySeasonEra,
      awayStarterTrailingEra: awayTrailingEra,
      awayStarterTrailingStarts: awayTrailingStarts,
      seasonEraEdge: seasonEdge,
      grade: graded?.grade ?? null,
      gradeScore: graded?.score ?? null,
      gradeReasons: graded?.reasons ?? [],
      qualifies,
      bandDistance,
      reason: reasons.join('; '),
    };
  });

  // Rank qualifiers by the AWAY starter's TRAILING ERA, descending (the
  // worst arm first). Per spec, this is deliberate and NOT the grade:
  // "the top of the board" is the qualifying game facing the shakiest
  // recent pitching, that's the actual thesis of the bet, not a composite
  // score. The grade still gets computed and shown (it answers "how good
  // a qualifier is this", useful context for admin review and Research),
  // but it does not decide the order here. Ties (rare) fall back to the
  // season-ERA edge, then price.
  const qualifying = evaluated
    .filter((g) => g.qualifies)
    .sort((a, b) =>
      (b.awayStarterTrailingEra ?? -Infinity) - (a.awayStarterTrailingEra ?? -Infinity) ||
      (b.seasonEraEdge ?? 0) - (a.seasonEraEdge ?? 0) ||
      (a.homeMl ?? 0) - (b.homeMl ?? 0)
    );

  const pickIds = new Set(qualifying.map((p) => p.gameId));

  // Every game NOT qualifying, each with its plain-English why-not, closest
  // to the bar first.
  const otherGames = evaluated
    .filter((g) => !pickIds.has(g.gameId))
    .sort((a, b) => {
      const aEdge = a.seasonEraEdge ?? -99;
      const bEdge = b.seasonEraEdge ?? -99;
      return (b.bandDistance === a.bandDistance ? bEdge - aEdge : a.bandDistance - b.bandDistance);
    })
    .map(({ gameId, qualifies, bandDistance, ...g }) => g);

  return {
    // A first-class result: zero qualifying games today is "SIT", not a
    // data gap. Some days no home favorite has a 2-run season-ERA edge.
    signal: qualifying.length ? 'PLAY' : 'SIT',
    hasProjected: qualifying.some((p) => !p.startersConfirmed),
    // All qualifiers, best-graded first (Research shows all, Daily Slate
    // shows picks[0]).
    picks: qualifying.map(({ gameId, qualifies, bandDistance, reason, ...p }) => p),
    otherGames,
  };
}

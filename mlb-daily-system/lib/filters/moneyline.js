import { fmtOdds, fmtNum } from '../util/format.js';
import { breakevenPct } from '../breakeven.js';
import { gradeMoneyline } from '../grading.js';

// Qualifying price band for the home favorite: -115 to -180 inclusive.
// Both bounds are negative by construction, "home team is the favorite"
// is built into the band itself, not a separate check.
export const BAND_LOW = -180;
export const BAND_HIGH = -115;

// The away starter's TRAILING (last 3 starts) ERA is the sole pitching
// gate. Season ERA is still pulled and shown on every card, but purely
// as labeled context, it never decides qualification: a 3-start trailing
// window is what's actually predictive of "is this arm getting hit right
// now", a season number can hide a starter who's been rocked lately (or,
// the other direction, one bad month early that's long since corrected).
const AWAY_TRAILING_ERA_MIN = 6.0;

// Only the 2 best-value qualifying games make the board each day, cheapest
// break-even price first. Zero qualifying games is a real, displayed SIT
// result (see web/app.js sitStateHtml), not an empty state, sitting out
// is the system working as designed on a day nothing clears the bar.
const MAX_PICKS_PER_DAY = 2;

export async function runMoneylineFilter(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT g.id AS game_id, g.mlb_game_id, g.home_team, g.away_team, g.home_ml,
            g.home_starter_id, g.home_starter_name, g.away_starter_id, g.away_starter_name,
            hpf.trailing_era AS home_trailing_era, hpf.season_era AS home_season_era,
            apf.trailing_era AS away_trailing_era, apf.trailing_starts AS away_trailing_starts,
            apf.season_era AS away_season_era,
            apf.savant_era AS away_savant_era, apf.savant_xera AS away_savant_xera,
            apf.savant_k_pct AS away_savant_k_pct, apf.savant_bb_pct AS away_savant_bb_pct,
            apf.savant_whiff_pct AS away_savant_whiff_pct, apf.savant_hard_hit_pct AS away_savant_hard_hit_pct
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

  const evaluated = rows.map((r) => {
    const homeMl = r.home_ml;
    const hasLine = homeMl !== null && homeMl !== undefined;
    const homeSeasonEra = num(r.home_season_era);
    const homeTrailingEra = num(r.home_trailing_era);
    const awaySeasonEra = num(r.away_season_era);
    const awayTrailingEra = num(r.away_trailing_era);
    const awayTrailingStarts = r.away_trailing_starts ?? 0;

    // In band = home priced -115 to -180. Judgment call: a game with no
    // price yet can't be checked against a price band at all, so unlike
    // the old rule (which allowed a "no-line" pick through on pitching
    // alone), a real price is now required to qualify, this band IS the
    // favorite check, there's nothing to evaluate without it.
    const inBand = hasLine && homeMl >= BAND_LOW && homeMl <= BAND_HIGH;
    const bandDistance = inBand ? 0 : hasLine ? Math.min(Math.abs(homeMl - BAND_LOW), Math.abs(homeMl - BAND_HIGH)) : 999;

    const startersKnown = r.home_starter_name !== null && r.away_starter_name !== null;
    const awayEraGateMet = awayTrailingEra !== null && awayTrailingEra >= AWAY_TRAILING_ERA_MIN;

    const lineStatus = inBand ? 'priced' : hasLine ? 'out-of-band' : 'no-line';
    const startersConfirmed = confirmedTeams.has(r.home_team) && confirmedTeams.has(r.away_team);

    const qualifies = inBand && awayEraGateMet;

    const awaySavant = r.away_savant_era !== null && r.away_savant_era !== undefined
      ? {
          era: num(r.away_savant_era),
          xera: num(r.away_savant_xera),
          kPct: num(r.away_savant_k_pct),
          bbPct: num(r.away_savant_bb_pct),
          whiffPct: num(r.away_savant_whiff_pct),
          hardHitPct: num(r.away_savant_hard_hit_pct),
        }
      : null;
    const breakeven = hasLine ? breakevenPct(homeMl) : null;
    const graded = awayTrailingEra !== null ? gradeMoneyline({ awayTrailingEra, breakevenPct: breakeven, awaySavant }) : null;

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
    } else if (!awayEraGateMet) {
      reasons.push(
        awayTrailingEra === null
          ? `no trailing ERA on file yet for ${r.away_starter_name}, check back after he has made a start`
          : `${r.away_starter_name}'s trailing ERA is only ${fmtNum(awayTrailingEra)} over his last ${awayTrailingStarts} start(s), the screener wants ${AWAY_TRAILING_ERA_MIN.toFixed(2)}+`
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
      homeStarterTrailingEra: homeTrailingEra,
      homeStarterSeasonEra: homeSeasonEra,
      awayStarterName: r.away_starter_name,
      awayStarterTrailingEra: awayTrailingEra,
      awayStarterTrailingStarts: awayTrailingStarts,
      awayStarterSeasonEra: awaySeasonEra,
      grade: graded?.grade ?? null,
      gradeScore: graded?.score ?? null,
      gradeReasons: graded?.reasons ?? [],
      qualifies,
      bandDistance,
      reason: reasons.join('; '),
    };
  });

  // Cheapest break-even first among everything that clears both gates
  // (favorite price band + away trailing-ERA floor), then cap at 2/day.
  const qualifying = evaluated
    .filter((g) => g.qualifies)
    .sort((a, b) => (a.breakevenPct ?? 1) - (b.breakevenPct ?? 1));

  const picks = qualifying.slice(0, MAX_PICKS_PER_DAY);
  const pickIds = new Set(picks.map((p) => p.gameId));

  // Every game NOT on the board, each with its why-not sentence. A game
  // that actually qualified but lost out to the 2-per-day cap gets a
  // distinct reason from one that never cleared the gates, so "so close"
  // doesn't read the same as "way off".
  const otherGames = evaluated
    .filter((g) => !pickIds.has(g.gameId))
    .map((g) => (g.qualifies
      ? { ...g, reason: `Qualified today but only the top ${MAX_PICKS_PER_DAY} by cheapest break-even make the board.` }
      : g))
    .sort((a, b) => {
      if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
      if (a.qualifies) return (a.breakevenPct ?? 1) - (b.breakevenPct ?? 1);
      return a.bandDistance - b.bandDistance;
    })
    .map(({ gameId, qualifies, bandDistance, ...g }) => g);

  return {
    // A real, first-class result: zero qualifying games today is "SIT",
    // not a data gap, see MAX_PICKS_PER_DAY / web/app.js sitStateHtml.
    signal: picks.length ? 'PLAY' : 'SIT',
    hasProjected: picks.some((p) => !p.startersConfirmed),
    picks: picks.map(({ gameId, qualifies, bandDistance, reason, ...p }) => p),
    otherGames,
  };
}

import { fmtOdds, fmtNum } from '../util/format.js';
import { breakevenPct } from '../breakeven.js';

export const BAND_LOW = -250;
export const BAND_HIGH = 100;
// How many runs better (lower) the home starter's ERA must be than the
// visitor's to qualify. "Facing a worse ERA by 2 runs", per the sketch.
const ERA_EDGE_MIN = 2.0;
const MAX_OTHER_GAMES = 6;

// The moneyline screener, in the order the research is actually done:
//   1. all of today's games
//   2. the home team priced from +100 (even) to -250 (solid favorite),
//      skip home dogs bigger than +100 and huge -250+ chalk
//   3. both starters known, confirmed from the posted lineup when it's
//      out, otherwise the projected/probable starter MLB has published
//   4. the HOME starter's ERA is at least 2 runs better (lower) than the
//      visitor's, compared on last 5 starts (season ERA as fallback)
// Every qualifying home team is returned (ranked by ERA edge), not just a
// top few, so the full list feeds the Research tab and the daily email.
// The Daily Slate then shows only whichever land in the day's top 6.
//
// Every pick carries two honesty flags so the UI can be upfront:
//   lineStatus       'priced'  = a real betting line was available and in band
//                    'no-line' = no odds yet, shown on the pitching matchup
//                                alone (happens before odds post, or when
//                                ODDS_API_KEY isn't configured)
//   startersConfirmed true  = both teams' lineups are officially posted
//                     false = using projected/probable starters for now
// A no-line pick is still shown for the date, clearly labeled, rather than
// leaving the section empty.

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
     WHERE g.game_date = $1`,
    [gameDate]
  );

  // Which teams have an officially posted lineup today. When both a game's
  // teams are in here, its starters are "confirmed"; otherwise we're on the
  // projected/probable starters and say so.
  const { rows: confirmedRows } = await pool.query(
    `SELECT DISTINCT team FROM batter_form WHERE game_date = $1 AND lineup_confirmed = true`,
    [gameDate]
  );
  const confirmedTeams = new Set(confirmedRows.map((r) => r.team));

  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);

  const evaluated = rows.map((r) => {
    const homeMl = r.home_ml;
    const hasLine = homeMl !== null && homeMl !== undefined;
    const home = { trailingEra: num(r.home_trailing_era), seasonEra: num(r.home_season_era) };
    const away = { trailingEra: num(r.away_trailing_era), seasonEra: num(r.away_season_era) };

    // In band = the home team is priced anywhere from +100 to -250.
    const inBand = hasLine && homeMl >= BAND_LOW && homeMl <= BAND_HIGH;
    const bandDistance = inBand ? 0 : hasLine ? Math.min(Math.abs(homeMl - BAND_LOW), Math.abs(homeMl - BAND_HIGH)) : 0;

    const startersKnown = r.home_starter_name !== null && r.away_starter_name !== null;
    const cmp = startersKnown ? eraComparison(home, away) : null;
    const eraEdge = cmp !== null ? cmp.awayEra - cmp.homeEra : null;
    // Home starter's ERA at least 2 runs better than the visitor's.
    const homeEdgeEnough = eraEdge !== null && eraEdge >= ERA_EDGE_MIN;

    // No line yet? Show it on the pitching matchup alone (can't check the
    // band, but the home-ERA-edge rule still applies). A real line that's
    // out of band is a genuine disqualifier, not a missing-data case.
    const lineStatus = inBand ? 'priced' : hasLine ? 'out-of-band' : 'no-line';
    const startersConfirmed = confirmedTeams.has(r.home_team) && confirmedTeams.has(r.away_team);

    const qualifies = homeEdgeEnough && (inBand || (!hasLine));

    const reasons = [];
    if (hasLine && !inBand) {
      reasons.push(
        homeMl > BAND_HIGH
          ? `${r.home_team} is too big a home dog (${fmtOdds(homeMl)}), the screener wants ${fmtOdds(BAND_HIGH)} to ${BAND_LOW}`
          : `${r.home_team} is too big a favorite (${fmtOdds(homeMl)}), huge favorites don't pay, so we cap it at ${BAND_LOW}`
      );
    }
    if (!startersKnown) {
      reasons.push('a starter has not been announced yet for this game, check back once MLB posts it');
    } else if (cmp === null) {
      reasons.push(`no ERA data yet for ${home.trailingEra === null && home.seasonEra === null ? r.home_starter_name : r.away_starter_name}, check back after he has made a start`);
    } else if (!homeEdgeEnough) {
      reasons.push(
        eraEdge > 0
          ? `${r.home_starter_name}'s ERA edge over ${r.away_starter_name} is only ${fmtNum(eraEdge)} runs (${cmp.basis}), the screener wants a ${ERA_EDGE_MIN}+ run gap`
          : `${r.away_starter_name} (${fmtNum(cmp.awayEra)} ERA, ${cmp.basis}) has the better arm than ${r.home_starter_name} (${fmtNum(cmp.homeEra)}), the home pitcher has to hold the edge`
      );
    }

    return {
      gameId: r.game_id,
      mlbGameId: r.mlb_game_id,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      homeMl: hasLine ? homeMl : null,
      breakevenPct: hasLine ? breakevenPct(homeMl) : null,
      lineStatus,
      startersConfirmed,
      eraBasis: cmp?.basis ?? null,
      eraEdge,
      homeStarterName: r.home_starter_name,
      homeStarterTrailingEra: home.trailingEra,
      homeStarterSeasonEra: home.seasonEra,
      awayStarterName: r.away_starter_name,
      awayStarterTrailingEra: away.trailingEra,
      awayStarterSeasonEra: away.seasonEra,
      qualifies,
      closeness: (eraEdge !== null ? Math.max(0, -eraEdge) : 99) * 100 + bandDistance,
      reason: reasons.join('; '),
    };
  });

  // Biggest home-pitcher ERA advantage first. A priced/in-band pick ranks
  // above an equal-edge no-line one, so real lines lead when we have them.
  const qualifying = evaluated
    .filter((g) => g.qualifies)
    .sort((a, b) => {
      if (a.lineStatus !== b.lineStatus) return a.lineStatus === 'priced' ? -1 : 1;
      return b.eraEdge - a.eraEdge;
    });

  // Every qualifying home team is a pick, ranked, not just a top few.
  const picks = qualifying;
  const pickIds = new Set(picks.map((p) => p.gameId));

  const otherGames = evaluated
    .filter((g) => !pickIds.has(g.gameId))
    .sort((a, b) => a.closeness - b.closeness)
    .slice(0, MAX_OTHER_GAMES)
    .map(({ gameId, qualifies, closeness, ...g }) => g);

  return {
    signal: picks.length ? 'PLAY' : 'SIT',
    // True when at least one pick is riding on projected (not yet posted)
    // starters or has no betting line, lets the UI show one banner.
    hasProjected: picks.some((p) => !p.startersConfirmed || p.lineStatus === 'no-line'),
    picks: picks.map(({ gameId, qualifies, closeness, reason, ...p }) => p),
    otherGames,
  };
}

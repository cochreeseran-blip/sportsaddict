import { fmtNum } from './util/format.js';

const LEAGUE_AVG_ERA = 4.2;
const UNCONFIRMED_LINEUP_PENALTY = 2;

function lineupWarning(lineupConfirmed) {
  return lineupConfirmed === false
    ? " Today's lineup isn't posted yet, this is a projected regular, not a confirmed starter."
    : '';
}

// How bad the opposing starter's recent form is. A league-average-or-better
// arm contributes ~nothing; every run of ERA worse than that adds to the
// score, same idea as the "weak arm" signal elsewhere in the app.
function eraScore(era) {
  if (era === null || era === undefined) return 0;
  return Math.max(0, era - LEAGUE_AVG_ERA);
}

// Games actually hit safely, of his last 5, oldest-to-newest boolean array.
function last5HitCount(last5Results) {
  return (last5Results || []).filter(Boolean).length;
}

// Player-prop ranking for the Tracking tab: pools every qualifying hit
// prop and HR prop into one score so the strongest 8 across both
// categories, not just the strongest of each, make the ledger. Same
// explainable-heuristic spirit as the rest of the screener, not a model.
// Every term maps to something a bettor actually checks before taking a
// prop: how the opposing arm is throwing lately, the batter's own
// average, whether he's actually been hitting it the last 5 games, and
// for home run props, the park/wind today.
function hitPropCandidates(hitStreak) {
  return (hitStreak?.watchList || []).map((b) => {
    const penalty = b.lineupConfirmed === false ? UNCONFIRMED_LINEUP_PENALTY : 0;
    const score =
      eraScore(b.opposingStarterTrailingEra) * 1.4 +
      Math.max(0, (b.trailing15Avg ?? 0) - 0.25) * 22 +
      last5HitCount(b.last5Results) * 1.1 -
      penalty;
    return {
      type: 'hit_streak',
      key: `hit:${b.batterName}:${b.team}`,
      score,
      mlbGameId: b.mlbGameId ?? null,
      batterId: b.batterId ?? null,
      batterName: b.batterName,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jerseyNumber ?? null,
      lineupConfirmed: b.lineupConfirmed,
      last5Results: b.last5Results,
      headline: `${b.batterName} (${b.team}) to get a hit`,
      detail: `${b.hitStreak >= 5 ? `On a ${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 games`}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
    };
  });
}

function hrPropCandidates(windHr) {
  return (windHr?.watchList || []).map((b) => {
    const penalty = b.lineupConfirmed === false ? UNCONFIRMED_LINEUP_PENALTY : 0;
    // Stadium/wind: only a real factor once it's actually blowing out.
    const windBonus = b.windBlowingOut ? Math.max(0, (b.windSpeedMph ?? 0) - 8) * 0.5 : 0;
    const score =
      eraScore(b.opposingStarterTrailingEra) * 1.2 +
      (b.trailing15HrRate ?? 0) * 9 +
      last5HitCount(b.last5Results) * 0.6 +
      windBonus -
      penalty;
    return {
      type: 'wind_hr',
      key: `hr:${b.batterName}:${b.team}`,
      score,
      mlbGameId: b.mlbGameId ?? null,
      batterId: b.batterId ?? null,
      batterName: b.batterName,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jerseyNumber ?? null,
      lineupConfirmed: b.lineupConfirmed,
      last5Results: b.last5Results,
      headline: `${b.batterName} (${b.team}) to go deep`,
      detail: `Wind blowing out ${fmtNum(b.windSpeedMph, 1)} mph at ${b.venue}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
    };
  });
}

// Top 8 player props across both hit and HR watchlists, ranked by the
// composite score above. A batter who qualifies for both a hit prop and
// an HR prop can take two slots, they're different bets.
export function buildTopPicks({ hitStreak, windHr }, limit = 8) {
  const all = [...hitPropCandidates(hitStreak), ...hrPropCandidates(windHr)].sort((a, b) => b.score - a.score);

  const seen = new Set();
  const top = [];
  for (const c of all) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    top.push(c);
    if (top.length >= limit) break;
  }
  return top;
}

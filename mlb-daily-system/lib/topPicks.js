import { fmtOdds, fmtNum } from './util/format.js';

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

// Top 6 picks for the Tracking tab: moneyline calls and player props
// (hit or HR) pooled into one ranked list, same explainable-heuristic
// spirit as the rest of the screener, not a model. Every term maps to
// something a bettor actually checks: how the opposing arm is throwing
// lately, the batter's own average, whether he's actually been hitting
// it the last 5 games, stadium/wind for HR props, and for moneyline, how
// big the home starter's ERA edge really is.
function moneylineCandidates(moneyline) {
  return (moneyline?.picks || []).map((p) => {
    const edge = p.eraEdge ?? 0;
    const score = Math.max(0, edge) * 1.6 + 5;
    return {
      type: 'moneyline',
      key: `ml:${p.homeTeam}:${p.awayTeam}`,
      score,
      mlbGameId: p.mlbGameId ?? null,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      homeMl: p.homeMl ?? null,
      breakevenPct: p.breakevenPct ?? null,
      headline: `${p.homeTeam} (${fmtOdds(p.homeMl)}) to beat ${p.awayTeam}`,
      detail: `${p.homeStarterName ?? 'The home starter'} (${fmtNum(p.homeStarterTrailingEra ?? p.homeStarterSeasonEra)} ERA) holds the pitching edge over ${p.awayStarterName ?? 'the visitor'} (${fmtNum(p.awayStarterTrailingEra ?? p.awayStarterSeasonEra)}), ${p.eraBasis ?? 'recent form'}.`,
    };
  });
}

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
      trailing15Avg: b.trailing15Avg ?? null,
      headline: `${b.batterName} (${b.team}) to get a hit`,
      detail: `${b.hitStreak >= 5 ? `On a ${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 games`}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
    };
  });
}

function koCandidates(strikeouts) {
  return (strikeouts?.watchList || []).map((p) => {
    // Higher reliable K floor and more Ks per start are the signal; a
    // low ERA (a good arm, the sketch's emphasis) tilts it up.
    const score =
      p.strictFloorKs * 2 +
      (p.kPerStart ?? 0) * 0.5 +
      Math.max(0, 4.5 - (p.trailingEra ?? 4.5)) * 1.2 +
      (p.isHome ? 0.4 : 0);
    return {
      type: 'strikeout',
      key: `ko:${p.pitcherName}`,
      score,
      mlbGameId: p.mlbGameId ?? null,
      pitcherId: p.pitcherId ?? null,
      pitcherName: p.pitcherName,
      team: p.team,
      suggestedLine: p.suggestedLine,
      last5StartKs: p.last5StartKs,
      strictFloorKs: p.strictFloorKs,
      headline: `${p.pitcherName} over ${p.suggestedLine.toFixed(1)} strikeouts`,
      detail: `Reached ${p.strictFloorKs}+ Ks in every recent start (${fmtNum(p.kPerStart, 1)} per start${p.trailingEra !== null && p.trailingEra !== undefined ? `, ${fmtNum(p.trailingEra)} ERA` : ''}), ${p.isHome ? 'at home ' : ''}vs ${p.opponent}.`,
    };
  });
}

// Top 6 across moneyline + hit props + K/O picks, ranked by the composite
// scores above. Same player can appear in more than one bucket, they're
// different bets.
export function buildTopPicks({ moneyline, hitStreak, strikeouts }, limit = 6) {
  const all = [
    ...moneylineCandidates(moneyline),
    ...hitPropCandidates(hitStreak),
    ...koCandidates(strikeouts),
  ].sort((a, b) => b.score - a.score);

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

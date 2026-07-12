import { fmtOdds, fmtNum } from './util/format.js';

function lineupWarning(lineupConfirmed) {
  return lineupConfirmed === false
    ? " Today's lineup isn't posted yet, this is a projected regular, not a confirmed starter."
    : '';
}

// Top 6 pooled list for the daily email + console digest (NOT the site,
// the web moneyline board renders straight from the ledger). Moneyline
// calls and player props pooled into one ranked list. Prop candidates
// carry a real graded score from lib/grading.js; a moneyline pick has no
// grade (see the note in lib/grading.js), so its ordering key here is
// simply the away starter's trailing ERA, the actual reason for the bet,
// matching the board's own worst-arm-first sort. This is an internal
// ordering key only, never surfaced as a "grade" or score to a reader.
// Exported: the pipeline records every one of these moneyline calls in
// the tracked-picks ledger, not just the ones that crack the top 6.
export function moneylineCandidates(moneyline) {
  return (moneyline?.picks || []).map((p) => ({
    type: 'moneyline',
    key: `ml:${p.homeTeam}:${p.awayTeam}`,
    // The moneyline grade (lib/grading.js gradeMoneyline) is the ranking
    // key everywhere: the pooled top-6, the single best pick the Daily
    // Slate publishes, and the Research list order.
    score: p.gradeScore ?? 0,
    grade: p.grade ?? null,
    gradeScore: p.gradeScore ?? null,
    gradeReasons: p.gradeReasons ?? [],
    mlbGameId: p.mlbGameId ?? null,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    homeMl: p.homeMl ?? null,
    breakevenPct: p.breakevenPct ?? null,
    // Season ERA (home vs away) is the qualifying signal now (see
    // lib/filters/moneyline.js). Trailing ERA rides along as context.
    homeStarterName: p.homeStarterName ?? null,
    homeStarterSeasonEra: p.homeStarterSeasonEra ?? null,
    homeStarterTrailingEra: p.homeStarterTrailingEra ?? null,
    awayStarterName: p.awayStarterName ?? null,
    awayStarterSeasonEra: p.awayStarterSeasonEra ?? null,
    awayStarterTrailingEra: p.awayStarterTrailingEra ?? null,
    awayStarterTrailingStarts: p.awayStarterTrailingStarts ?? null,
    seasonEraEdge: p.seasonEraEdge ?? null,
    headline: `${p.homeTeam} (${fmtOdds(p.homeMl)}) to beat ${p.awayTeam}`,
    detail: `${p.homeStarterName ?? 'The home starter'} (${fmtNum(p.homeStarterSeasonEra)} season ERA) is ${fmtNum(p.seasonEraEdge)} runs better than ${p.awayStarterName ?? 'the away starter'} (${fmtNum(p.awayStarterSeasonEra)}).`,
  }));
}

function hitPropCandidates(hitStreak) {
  return (hitStreak?.watchList || []).map((b) => ({
    type: 'hit_streak',
    key: `hit:${b.batterName}:${b.team}`,
    score: b.gradeScore ?? 0,
    grade: b.grade ?? null,
    gradeReasons: b.gradeReasons ?? [],
    mlbGameId: b.mlbGameId ?? null,
    batterId: b.batterId ?? null,
    batterName: b.batterName,
    team: b.team,
    position: b.position ?? null,
    jerseyNumber: b.jerseyNumber ?? null,
    lineupConfirmed: b.lineupConfirmed,
    last5Results: b.last5Results,
    trailing15Avg: b.trailing15Avg ?? null,
    // Always carried alongside the average, a .345 on 58 at-bats and a
    // .345 on 12 at-bats are not the same claim, see lib/filters/hitStreak.js.
    trailing15Ab: b.trailing15Ab ?? 0,
    headline: `${b.batterName} (${b.team}) to get a hit`,
    detail: `${b.hitStreak >= 5 ? `On a ${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 games (${b.trailing15Ab ?? 0} AB)`}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
  }));
}

function koCandidates(strikeouts) {
  return (strikeouts?.watchList || []).map((p) => ({
    type: 'strikeout',
    key: `ko:${p.pitcherName}`,
    score: p.gradeScore ?? 0,
    grade: p.grade ?? null,
    gradeReasons: p.gradeReasons ?? [],
    mlbGameId: p.mlbGameId ?? null,
    pitcherId: p.pitcherId ?? null,
    pitcherName: p.pitcherName,
    team: p.team,
    suggestedLine: p.suggestedLine,
    last5StartKs: p.last5StartKs,
    strictFloorKs: p.strictFloorKs,
    headline: `${p.pitcherName} over ${p.suggestedLine.toFixed(1)} strikeouts`,
    detail: `Reached ${p.strictFloorKs}+ Ks in every recent start (${fmtNum(p.kPerStart, 1)} per start${p.trailingEra !== null && p.trailingEra !== undefined ? `, ${fmtNum(p.trailingEra)} ERA` : ''}), ${p.isHome ? 'at home ' : ''}vs ${p.opponent}.`,
  }));
}

// Top 6 across moneyline + hit props + K/O picks, ranked by the composite
// scores above. Same player can appear in more than one bucket, they're
// different bets. At least one moneyline pick is always in the slate: if
// none makes the natural cut, the best available ML takes the last slot.
//
// Takes an already-built moneyline candidate list (not the raw filter
// output) so the caller can pass either the live-computed candidates or,
// once the board is frozen for the day (see pipeline.js), the locked
// candidates read back from the tracked-picks ledger, the jumbotron and
// the moneyline board always agree on the same picks.
export function buildTopPicks({ moneylineCandidates: mlCandidates, hitStreak, strikeouts }, limit = 6) {
  const ranked = [];
  const seen = new Set();
  for (const c of [
    ...(mlCandidates || []),
    ...hitPropCandidates(hitStreak),
    ...koCandidates(strikeouts),
  ].sort((a, b) => b.score - a.score)) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    ranked.push(c);
  }

  const top = ranked.slice(0, limit);

  // Guarantee a moneyline pick in the daily slate. If none cracked the top
  // on score but a qualifying ML exists, swap the best one in for the
  // lowest-scoring pick, then re-sort so it lands where its score belongs.
  if (limit > 0 && !top.some((p) => p.type === 'moneyline')) {
    const bestMl = ranked.find((p) => p.type === 'moneyline');
    if (bestMl) {
      top[top.length - 1] = bestMl;
      top.sort((a, b) => b.score - a.score);
    }
  }
  return top;
}

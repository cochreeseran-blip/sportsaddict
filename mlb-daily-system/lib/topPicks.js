import { fmtOdds, fmtNum } from './util/format.js';

function lineupWarning(lineupConfirmed) {
  return lineupConfirmed === false
    ? " Today's lineup isn't posted yet, this is a projected regular, not a confirmed starter."
    : '';
}

// Candidate builders for the three signal types. Shared by the pooled
// top-6 (email/console) and by the pipeline's tracked-picks recording:
// every one of these candidates is written to the tracked_picks ledger
// (published = false) so the algorithm's untouched record exists
// independent of what an admin later chooses to publish.

// Moneyline calls. A moneyline pick has no grade (see the note in
// lib/grading.js): its ordering key here is simply the away starter's
// trailing ERA, the actual reason for the bet, matching the board's own
// worst-arm-first sort. Internal ordering only, never surfaced as a
// score.
export function moneylineCandidates(moneyline) {
  return (moneyline?.picks || []).map((p) => ({
    type: 'moneyline',
    key: `ml:${p.homeTeam}:${p.awayTeam}`,
    score: p.awayStarterTrailingEra ?? 0,
    mlbGameId: p.mlbGameId ?? null,
    homeTeam: p.homeTeam,
    awayTeam: p.awayTeam,
    homeMl: p.homeMl ?? null,
    breakevenPct: p.breakevenPct ?? null,
    // Away starter's TRAILING ERA is the qualifying signal (see
    // lib/filters/moneyline.js), always carried with the start count it
    // was computed from. Season ERA rides along too but is display-only
    // context, never re-derived as a gate downstream.
    awayStarterName: p.awayStarterName ?? null,
    awayStarterTrailingEra: p.awayStarterTrailingEra ?? null,
    awayStarterTrailingStarts: p.awayStarterTrailingStarts ?? null,
    awayStarterSeasonEra: p.awayStarterSeasonEra ?? null,
    homeStarterName: p.homeStarterName ?? null,
    homeStarterSeasonEra: p.homeStarterSeasonEra ?? null,
    headline: `${p.homeTeam} (${fmtOdds(p.homeMl)}) to beat ${p.awayTeam}`,
    detail: `${p.awayStarterName ?? 'The away starter'}'s trailing ERA is ${fmtNum(p.awayStarterTrailingEra)} over his last ${p.awayStarterTrailingStarts ?? 0} start(s) (season: ${fmtNum(p.awayStarterSeasonEra)}).`,
  }));
}

export function hitPropCandidates(hitStreak) {
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
    opposingStarterName: b.opposingStarterName ?? null,
    opposingStarterTrailingEra: b.opposingStarterTrailingEra ?? null,
    headline: `${b.batterName} (${b.team}) to get a hit`,
    detail: `${b.hitStreak >= 5 ? `On a ${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 games (${b.trailing15Ab ?? 0} AB)`}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
  }));
}

export function koCandidates(strikeouts) {
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
    kPerStart: p.kPerStart ?? null,
    trailingEra: p.trailingEra ?? null,
    isHome: p.isHome ?? null,
    opponent: p.opponent ?? null,
    headline: `${p.pitcherName} over ${p.suggestedLine.toFixed(1)} strikeouts`,
    detail: `Reached ${p.strictFloorKs}+ Ks in every recent start (${fmtNum(p.kPerStart, 1)} per start${p.trailingEra !== null && p.trailingEra !== undefined ? `, ${fmtNum(p.trailingEra)} ERA` : ''}), ${p.isHome ? 'at home ' : ''}vs ${p.opponent}.`,
  }));
}

// Top 6 pooled list for the daily email + console digest (NOT the site,
// the web moneyline board renders straight from the ledger). Moneyline
// calls and player props pooled into one ranked list.
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

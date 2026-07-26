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
    // The start count is only stated when it's actually known. Printing
    // "over his last 0 start(s)" reads as broken and undermines the one
    // number the whole pick rests on, so an unknown count says "recent
    // starts" instead of asserting a wrong quantity.
    detail: `${p.awayStarterName ?? 'The away starter'}'s trailing ERA is ${fmtNum(p.awayStarterTrailingEra)} over ${
      p.awayStarterTrailingStarts > 0
        ? `his last ${p.awayStarterTrailingStarts} start${p.awayStarterTrailingStarts === 1 ? '' : 's'}`
        : 'his recent starts'
    }${p.awayStarterSeasonEra !== null && p.awayStarterSeasonEra !== undefined ? ` (season: ${fmtNum(p.awayStarterSeasonEra)})` : ''}.`,
  }));
}

// Shared shape for both hit tiers. `tier` decides the signal type, the
// headline, and which probability is the pick's own score -- everything
// else about a 1+ and a 2+ candidate is identical, and they come from the
// same projection, so they must not drift apart in two copies of this.
function hitCandidate(b, tier) {
  const isMulti = tier === 'multi';
  const prob = isMulti ? b.pAtLeastTwo : b.pAtLeastOne;
  const pct = prob !== null && prob !== undefined ? `${(prob * 100).toFixed(0)}%` : '-';
  const abNote = b.expectedAtBats ? ` in a projected ${fmtNum(b.expectedAtBats, 1)} at-bats` : '';
  const slotNote = Number.isInteger(b.battingOrderSlot)
    ? `batting ${b.battingOrderSlot}`
    : 'lineup slot not posted yet';
  const historyNote = b.multiHitRate !== null && b.multiHitRate !== undefined
    ? ` He has a multi-hit game in ${(b.multiHitRate * 100).toFixed(0)}% of his last ${b.trailing15Games ?? 15}.`
    : '';

  return {
    type: isMulti ? 'multi_hit' : 'hit_streak',
    key: `${isMulti ? 'multihit' : 'hit'}:${b.batterName}:${b.team}`,
    // Score is the tier's own probability scaled to 0-100, so the pooled
    // top-6 ranks a 78% single-hit play against a 41% multi-hit play on
    // comparable footing with the other signals' 0-100 grade scores.
    score: prob !== null && prob !== undefined ? Math.round(prob * 100) : 0,
    grade: b.grade ?? null,
    gradeReasons: b.gradeReasons ?? [],
    mlbGameId: b.mlbGameId ?? null,
    batterId: b.batterId ?? null,
    batterName: b.batterName,
    team: b.team,
    position: b.position ?? null,
    jerseyNumber: b.jerseyNumber ?? null,
    battingOrderSlot: b.battingOrderSlot ?? null,
    lineupConfirmed: b.lineupConfirmed,
    last5Results: b.last5Results,
    trailing15Avg: b.trailing15Avg ?? null,
    // Always carried alongside the average, a .345 on 58 at-bats and a
    // .345 on 12 at-bats are not the same claim, see lib/filters/hitStreak.js.
    trailing15Ab: b.trailing15Ab ?? 0,
    xba: b.xba ?? null,
    xbaLuckFlag: b.xbaLuckFlag ?? null,
    // The projection, carried in full so a published pick's card can be
    // rebuilt from the ledger alone years later.
    expectedHits: b.expectedHits ?? null,
    expectedAtBats: b.expectedAtBats ?? null,
    hitProbPerAb: b.hitProbPerAb ?? null,
    pAtLeastOne: b.pAtLeastOne ?? null,
    pAtLeastTwo: b.pAtLeastTwo ?? null,
    projectionBasis: b.projectionBasis ?? null,
    multiHitRate: b.multiHitRate ?? null,
    trailing15Games: b.trailing15Games ?? null,
    opposingStarterName: b.opposingStarterName ?? null,
    opposingStarterTrailingEra: b.opposingStarterTrailingEra ?? null,
    opposingHitsPer9: b.opposingHitsPer9 ?? null,
    headline: isMulti
      ? `${b.batterName} (${b.team}) to get 2+ hits`
      : `${b.batterName} (${b.team}) to get a hit`,
    detail:
      `Projected ${fmtNum(b.expectedHits, 2)} hits${abNote}, ${pct} to reach ${isMulti ? '2+' : '1+'}. ` +
      `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 (${b.trailing15Ab ?? 0} AB)` +
      `${b.xba !== null && b.xba !== undefined ? `, xBA ${fmtNum(b.xba, 3)}` : ''}, ${slotNote}, ` +
      `facing ${b.opposingStarterName ?? 'today\'s starter'}` +
      `${b.opposingHitsPer9 !== null && b.opposingHitsPer9 !== undefined ? ` (${fmtNum(b.opposingHitsPer9, 1)} H/9)` : ''}.` +
      `${isMulti ? historyNote : ''}${lineupWarning(b.lineupConfirmed)}`,
  };
}

// The 1+ hit tier. Kept as signal_type 'hit_streak' so the existing ledger
// history, grading path, and public record stay continuous -- the pick
// being asked for is unchanged ("gets a hit"), only how it's selected and
// ranked has changed.
export function hitPropCandidates(hitStreak) {
  const source = hitStreak?.singleHit?.length ? hitStreak.singleHit : (hitStreak?.watchList || []);
  return source.map((b) => hitCandidate(b, 'single'));
}

// The 2+ hit tier, a new signal type with its own grading rule (see
// gradeOnePick in lib/trackedPicks.js) and its own line on the record.
export function multiHitCandidates(hitStreak) {
  return (hitStreak?.multiHit || []).map((b) => hitCandidate(b, 'multi'));
}

// Home run props. Ranked on the Statcast-based score (see scoreHomeRunProp
// in lib/grading.js), which is what makes this board worth surfacing at
// all now -- the old trailing-HR-rate version never was.
export function homeRunCandidates(windHr) {
  return (windHr?.watchList || []).map((b) => ({
    type: 'home_run',
    key: `hr:${b.batterName}:${b.team}`,
    score: b.gradeScore ?? 0,
    grade: b.grade ?? null,
    gradeReasons: b.gradeReasons ?? [],
    mlbGameId: b.mlbGameId ?? null,
    batterId: b.batterId ?? null,
    batterName: b.batterName,
    team: b.team,
    position: b.position ?? null,
    jerseyNumber: b.jerseyNumber ?? null,
    battingOrderSlot: b.battingOrderSlot ?? null,
    lineupConfirmed: b.lineupConfirmed,
    last5Results: b.last5Results,
    barrelPct: b.barrelPct ?? null,
    avgExitVelo: b.avgExitVelo ?? null,
    hardHitPct: b.hardHitPct ?? null,
    xslg: b.xslg ?? null,
    trailing15HrRate: b.trailing15HrRate ?? null,
    trailing15Games: b.trailing15Games ?? null,
    venue: b.venue ?? null,
    windBlowingOut: b.windBlowingOut ?? false,
    windSpeedMph: b.windSpeedMph ?? null,
    opposingStarterName: b.opposingStarterName ?? null,
    opposingHrPer9: b.opposingHrPer9 ?? null,
    opposingBarrelPct: b.opposingBarrelPct ?? null,
    headline: `${b.batterName} (${b.team}) to hit a home run`,
    detail:
      `${b.barrelPct !== null && b.barrelPct !== undefined ? `${fmtNum(b.barrelPct, 1)}% barrel rate` : 'Recent power form'}` +
      `${b.avgExitVelo !== null && b.avgExitVelo !== undefined ? `, ${fmtNum(b.avgExitVelo, 1)} mph average exit velocity` : ''}, ` +
      `facing ${b.opposingStarterName ?? 'today\'s starter'}` +
      `${b.opposingHrPer9 !== null && b.opposingHrPer9 !== undefined ? ` (${fmtNum(b.opposingHrPer9, 2)} HR/9 allowed)` : ''}` +
      `${b.windBlowingOut ? `, wind blowing out at ${b.venue}` : ''}.${lineupWarning(b.lineupConfirmed)}`,
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

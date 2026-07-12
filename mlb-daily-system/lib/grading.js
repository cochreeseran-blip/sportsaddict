import { fmtNum } from './util/format.js';

// Phase 1 research-dashboard scoring for the two prop signals (K props,
// hit props). Moneyline is deliberately not graded here (see the note at
// the bottom of this file) -- it stays two hard facts and a deterministic
// sort, unchanged.
//
// Every bucket below is a literal point scale, not a fitted/backtested
// model -- these are still hand-picked thresholds, same honesty caveat as
// before: nobody has validated "8+ Ks in every recent start is worth
// exactly 60 points" against outcome data. What changed from the old
// continuous formulas is that the INPUTS are now the right ones (the K
// prop score finally looks at the OPPOSING LINEUP's strikeout rate, the
// hit prop score finally looks at contact-quality metrics instead of ERA),
// not that the scoring is suddenly validated.
const GRADE_THRESHOLDS = [
  [90, 'A+'],
  [80, 'A'],
  [70, 'B+'],
  [60, 'B'],
  [50, 'C+'],
  [40, 'C'],
];
// Below the lowest threshold: not a grade, not surfaced at all (see
// runStrikeoutFilter / runHitStreakFilter, which drop these from the
// watchlist entirely rather than showing a low letter).
export const MIN_SURFACE_SCORE = 40;

export function letterGrade(score) {
  for (const [min, label] of GRADE_THRESHOLDS) {
    if (score >= min) return label;
  }
  return null; // below MIN_SURFACE_SCORE; caller should not surface this pick
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bucket(value, scale, fallback = 0) {
  // scale: array of [minInclusive, points], evaluated highest-first.
  if (value === null || value === undefined) return fallback;
  for (const [min, points] of scale) {
    if (value >= min) return points;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 2A. Strikeout props.
//
// DO NOT USE (per spec): ERA in any form, win/loss record, opposing team's
// batting average. This function accepts none of those as inputs on
// purpose -- there's no ERA parameter to be tempted to wire back in.
export function scoreStrikeoutProp({
  strictFloorKs,       // the K count he's hit in EVERY recent start (qualification input)
  softFloorKs,         // the K count he's hit in all but one recent start ("allows one dud")
  pitcherKPct,         // Savant, this pitcher's own K%
  opposingTeamKPct,    // team_batting_aggregates.team_k_pct for today's opponent -- THE key addition
  pitcherWhiffPct,     // Savant, this pitcher's own whiff%
  kPerStart,           // trailing average Ks/start
  last5StartKs,        // array, most-recent-first, for the consistency bonus
}) {
  const reasons = [];
  let score = 0;

  // Primary factors.
  //
  // BUG FIX: this used to bucket on strictFloorKs alone, which is the
  // count he's hit in EVERY recent start -- so a single bad night (5 Ks
  // in an otherwise 7-14 K stretch) drags an elite arm's score down to
  // whatever that one outlier says, even though softFloorKs (computed
  // right next to it, "allows one dud") already correctly identifies his
  // real level as 7+. The old code computed softFloorKs and only ever
  // used it for DISPLAY, never for scoring -- the fix is to actually
  // score off it. strictFloorKs still matters (see the reliability bonus
  // below and the qualification gate in runStrikeoutFilter), it just
  // isn't allowed to single-handedly crater an otherwise dominant stretch
  // anymore.
  const floorBasis = softFloorKs ?? strictFloorKs;
  const floorPts = bucket(floorBasis, [[8, 60], [7, 50], [6, 35], [5, 20], [4, 10]]);
  score += floorPts;
  reasons.push(`K floor of ${floorBasis}+ in all but at most one recent start (+${floorPts})`);

  // Reliability bonus: when the strict (every-start) floor is close to the
  // soft (allows-one-dud) floor, that's a genuinely more consistent arm,
  // worth a small bump on top. A wide gap between them isn't penalized --
  // that's exactly the "one bad night shouldn't define him" case this fix
  // exists for.
  if (Number.isFinite(strictFloorKs) && Number.isFinite(softFloorKs)) {
    const gap = softFloorKs - strictFloorKs;
    if (gap <= 1) {
      score += 5;
      reasons.push(`strict floor ${strictFloorKs} is right behind the soft floor, very consistent (+5)`);
    }
  }

  const kPctPts = bucket(pitcherKPct, [[30, 25], [25, 15], [20, 5]]);
  score += kPctPts;
  if (pitcherKPct !== null && pitcherKPct !== undefined) reasons.push(`${fmtNum(pitcherKPct, 0)}% own K rate (+${kPctPts})`);

  // The key addition: how strikeout-prone is the OPPONENT, not just how
  // good is the pitcher. A low-strikeout opposing lineup actively hurts
  // the pick (-10), reflected as a penalty, not just an absent bonus.
  let oppPts;
  if (opposingTeamKPct === null || opposingTeamKPct === undefined) {
    oppPts = 0;
  } else if (opposingTeamKPct >= 26) oppPts = 20;
  else if (opposingTeamKPct >= 23) oppPts = 10;
  else if (opposingTeamKPct >= 20) oppPts = 0;
  else oppPts = -10;
  score += oppPts;
  if (opposingTeamKPct !== null && opposingTeamKPct !== undefined) {
    reasons.push(`opponent strikes out ${fmtNum(opposingTeamKPct, 0)}% of the time (${oppPts >= 0 ? '+' : ''}${oppPts})`);
  }

  // Secondary factors.
  const whiffPts = bucket(pitcherWhiffPct, [[30, 10], [25, 5]]);
  score += whiffPts;
  if (pitcherWhiffPct !== null && pitcherWhiffPct !== undefined) reasons.push(`${fmtNum(pitcherWhiffPct, 0)}% whiff rate (+${whiffPts})`);

  const perStartPts = bucket(kPerStart, [[9, 15], [7, 10], [5, 5]]);
  score += perStartPts;
  if (kPerStart !== null && kPerStart !== undefined) reasons.push(`${fmtNum(kPerStart, 1)} Ks/start lately (+${perStartPts})`);

  // Consistency bonus: hit floor+2 in at least 4 of his last 5 starts.
  if (Array.isArray(last5StartKs) && last5StartKs.length && Number.isFinite(strictFloorKs)) {
    const recent5 = last5StartKs.slice(0, 5);
    const hitFloorPlus2 = recent5.filter((k) => k >= strictFloorKs + 2).length;
    if (recent5.length >= 5 && hitFloorPlus2 >= 4) {
      score += 5;
      reasons.push(`hit floor+2 in ${hitFloorPlus2}/${recent5.length} recent starts (+5)`);
    }
  }

  score = clampScore(score);
  return { score, grade: letterGrade(score), reasons, surfaced: score >= MIN_SURFACE_SCORE };
}

// ---------------------------------------------------------------------------
// 2B. Hit props.
//
// DO NOT USE (per spec): opposing pitcher's ERA (doesn't measure contact
// allowed -- replaced by H/9 below), batter-vs-specific-pitcher splits
// under 20 PA. This codebase has never computed per-pitcher splits (only
// batter-vs-TEAM, already gated at 20+ PA), so there's nothing to remove
// there; the ERA removal is the real change.
export function scoreHitProp({
  trailing15Avg,
  xba,                  // Savant expected batting average
  opposingHitsPer9,     // replaces opposing pitcher ERA
  hitStreak,
  hardHitPct,           // Savant, this batter's own hard-hit%
  battingOrderSlot,      // 1-9, from the confirmed lineup
  vsTeamPa,              // career PA against today's opponent
  vsTeamAvg,
}) {
  const reasons = [];
  let score = 0;

  // Primary factors.
  const avgPts = bucket(trailing15Avg, [[0.330, 35], [0.300, 25], [0.280, 15], [0.250, 5]]);
  score += avgPts;
  if (trailing15Avg !== null && trailing15Avg !== undefined) reasons.push(`batting ${fmtNum(trailing15Avg, 3)} over his last 15 (+${avgPts})`);

  let xbaPts;
  if (xba === null || xba === undefined) xbaPts = 0;
  else if (xba >= 0.280) xbaPts = 20;
  else if (xba >= 0.260) xbaPts = 10;
  else if (xba >= 0.240) xbaPts = 0;
  else xbaPts = -5;
  score += xbaPts;
  let xbaLuckFlag = null;
  if (xba !== null && xba !== undefined && trailing15Avg !== null && trailing15Avg !== undefined) {
    reasons.push(`xBA ${fmtNum(xba, 3)} (${xbaPts >= 0 ? '+' : ''}${xbaPts})`);
    // "If xBA is significantly higher than actual BA, that's a BUY signal
    // (unlucky but hitting the ball well)." Flagged for the dashboard,
    // separate from the score itself -- this is a note, not extra points.
    if (xba - trailing15Avg >= 0.03) {
      xbaLuckFlag = 'buy';
      reasons.push(`xBA running ${fmtNum(xba - trailing15Avg, 3)} above actual average, unlucky BABIP not bad contact`);
    } else if (trailing15Avg - xba >= 0.03) {
      xbaLuckFlag = 'sell';
      reasons.push(`actual average running ${fmtNum(trailing15Avg - xba, 3)} above xBA, results ahead of the underlying contact quality`);
    }
  }

  const h9Pts = bucket(opposingHitsPer9, [[9.5, 25], [8.5, 15], [7.5, 5]]);
  score += h9Pts;
  if (opposingHitsPer9 !== null && opposingHitsPer9 !== undefined) reasons.push(`opposing arm allows ${fmtNum(opposingHitsPer9, 1)} hits/9 (+${h9Pts})`);

  // Secondary factors.
  const streakPts = bucket(hitStreak, [[15, 20], [11, 15], [8, 10], [5, 5]]);
  score += streakPts;
  if (hitStreak >= 5) reasons.push(`${hitStreak}-game hit streak (+${streakPts})`);

  const hardHitPts = bucket(hardHitPct, [[43, 10], [35, 5]]);
  score += hardHitPts;
  if (hardHitPct !== null && hardHitPct !== undefined) reasons.push(`${fmtNum(hardHitPct, 0)}% hard-hit rate (+${hardHitPts})`);

  let orderPts = 0;
  if (Number.isInteger(battingOrderSlot)) {
    orderPts = battingOrderSlot <= 3 ? 10 : battingOrderSlot <= 5 ? 5 : 0;
    score += orderPts;
    reasons.push(`batting ${battingOrderSlot}${ordinalSuffix(battingOrderSlot)} (+${orderPts})`);
  }

  let vsTeamPts = 0;
  if (Number.isInteger(vsTeamPa) && vsTeamPa >= 20 && vsTeamAvg !== null && vsTeamAvg !== undefined) {
    vsTeamPts = bucket(vsTeamAvg, [[0.330, 10], [0.280, 5], [0.200, 0]], -5);
    score += vsTeamPts;
    reasons.push(`${fmtNum(vsTeamAvg, 3)} career vs this team in ${vsTeamPa} PA (${vsTeamPts >= 0 ? '+' : ''}${vsTeamPts})`);
  }

  score = clampScore(score);

  // Hard floors: a grade above B implies "this bat is actually hitting
  // well right now, against a beatable matchup" -- neither a cold streak
  // that only qualified via xBA, nor a batter with unimpressive expected
  // contact quality, gets to claim that regardless of matchup points.
  const B_TOP = 69; // top of the B band under GRADE_THRESHOLDS
  let flooredNote = null;
  if ((trailing15Avg === null || trailing15Avg === undefined || trailing15Avg < 0.28) && score > B_TOP) {
    score = B_TOP;
    flooredNote = 'capped at B: trailing average is below the .280 floor for a top grade';
  } else if ((xba === null || xba === undefined || xba < 0.25) && score > B_TOP) {
    score = B_TOP;
    flooredNote = 'capped at B: Savant xBA is below .250, results are running ahead of contact quality';
  }
  if (flooredNote) reasons.push(flooredNote);

  return { score, grade: letterGrade(score), reasons, surfaced: score >= MIN_SURFACE_SCORE, xbaLuckFlag };
}

function ordinalSuffix(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'st';
  if (n % 10 === 2 && n % 100 !== 12) return 'nd';
  if (n % 10 === 3 && n % 100 !== 13) return 'rd';
  return 'th';
}

// NOTE: there is deliberately no gradeMoneyline. A moneyline pick is
// defined by two hard facts, the -115/-180 favorite band and the away
// starter's 6.00+ trailing ERA (see lib/filters/moneyline.js), and with a
// 2-pick cap and a deterministic worst-ERA-first sort there is nothing
// left for a grade to decide. Any score blending "distance past the ERA
// gate" against "break-even price" would use coefficients never fit to
// outcome data, the same unvalidated blending removed elsewhere. The
// board shows the two qualifying facts and no letter. Per the Phase 1
// spec, moneyline gets richer DISPLAY data (Savant profiles, trailing
// offense) but no change to qualification or ranking.

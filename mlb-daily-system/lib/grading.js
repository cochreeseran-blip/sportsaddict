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
  // CALIBRATION NOTE: every bucket below is sized so the maximum
  // attainable total lands near 105, not far above it. An earlier version
  // summed to ~140, which meant any competent arm saturated the 0-100
  // clamp and graded A+ -- three different pitchers on the same slate all
  // scoring exactly 100 tells you nothing, and it silently destroys the
  // per-grade performance breakdown (lib/performance.js), whose entire
  // purpose is separating an A+ from an A. Points still aren't fitted to
  // outcome data; they're now at least scaled so the top of the range is
  // reachable only by a genuinely elite profile.
  const floorBasis = softFloorKs ?? strictFloorKs;
  const floorPts = bucket(floorBasis, [[8, 42], [7, 36], [6, 28], [5, 17], [4, 9]]);
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
      score += 4;
      reasons.push(`strict floor ${strictFloorKs} is right behind the soft floor, very consistent (+4)`);
    }
  }

  const kPctPts = bucket(pitcherKPct, [[30, 18], [25, 13], [20, 5]]);
  score += kPctPts;
  if (pitcherKPct !== null && pitcherKPct !== undefined) reasons.push(`${fmtNum(pitcherKPct, 0)}% own K rate (+${kPctPts})`);

  // The key addition: how strikeout-prone is the OPPONENT, not just how
  // good is the pitcher. A low-strikeout opposing lineup actively hurts
  // the pick (-10), reflected as a penalty, not just an absent bonus.
  let oppPts;
  if (opposingTeamKPct === null || opposingTeamKPct === undefined) {
    oppPts = 0;
  } else if (opposingTeamKPct >= 26) oppPts = 16;
  else if (opposingTeamKPct >= 23) oppPts = 9;
  else if (opposingTeamKPct >= 20) oppPts = 0;
  else oppPts = -10;
  score += oppPts;
  if (opposingTeamKPct !== null && opposingTeamKPct !== undefined) {
    reasons.push(`opponent strikes out ${fmtNum(opposingTeamKPct, 0)}% of the time (${oppPts >= 0 ? '+' : ''}${oppPts})`);
  }

  // Secondary factors.
  const whiffPts = bucket(pitcherWhiffPct, [[30, 9], [25, 5]]);
  score += whiffPts;
  if (pitcherWhiffPct !== null && pitcherWhiffPct !== undefined) reasons.push(`${fmtNum(pitcherWhiffPct, 0)}% whiff rate (+${whiffPts})`);

  const perStartPts = bucket(kPerStart, [[9, 12], [7, 8], [5, 4]]);
  score += perStartPts;
  if (kPerStart !== null && kPerStart !== undefined) reasons.push(`${fmtNum(kPerStart, 1)} Ks/start lately (+${perStartPts})`);

  // Consistency bonus: hit floor+2 in at least 4 of his last 5 starts.
  if (Array.isArray(last5StartKs) && last5StartKs.length && Number.isFinite(strictFloorKs)) {
    const recent5 = last5StartKs.slice(0, 5);
    const hitFloorPlus2 = recent5.filter((k) => k >= strictFloorKs + 2).length;
    if (recent5.length >= 5 && hitFloorPlus2 >= 4) {
      score += 4;
      reasons.push(`hit floor+2 in ${hitFloorPlus2}/${recent5.length} recent starts (+4)`);
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

  // Primary factors. Same calibration note as scoreStrikeoutProp above:
  // these buckets sum to about 104 at maximum so the 0-100 clamp is only
  // reached by an genuinely elite profile. Before rescaling, the maxima
  // summed to 130 and every surfaced hit prop graded A+, which makes both
  // the grade and the per-grade performance breakdown worthless.
  const avgPts = bucket(trailing15Avg, [[0.330, 30], [0.300, 22], [0.280, 13], [0.250, 4]]);
  score += avgPts;
  if (trailing15Avg !== null && trailing15Avg !== undefined) reasons.push(`batting ${fmtNum(trailing15Avg, 3)} over his last 15 (+${avgPts})`);

  let xbaPts;
  if (xba === null || xba === undefined) xbaPts = 0;
  else if (xba >= 0.280) xbaPts = 16;
  else if (xba >= 0.260) xbaPts = 9;
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

  const h9Pts = bucket(opposingHitsPer9, [[9.5, 20], [8.5, 12], [7.5, 4]]);
  score += h9Pts;
  if (opposingHitsPer9 !== null && opposingHitsPer9 !== undefined) reasons.push(`opposing arm allows ${fmtNum(opposingHitsPer9, 1)} hits/9 (+${h9Pts})`);

  // Secondary factors.
  const streakPts = bucket(hitStreak, [[15, 14], [11, 10], [8, 7], [5, 4]]);
  score += streakPts;
  if (hitStreak >= 5) reasons.push(`${hitStreak}-game hit streak (+${streakPts})`);

  const hardHitPts = bucket(hardHitPct, [[43, 8], [35, 4]]);
  score += hardHitPts;
  if (hardHitPct !== null && hardHitPct !== undefined) reasons.push(`${fmtNum(hardHitPct, 0)}% hard-hit rate (+${hardHitPts})`);

  let orderPts = 0;
  if (Number.isInteger(battingOrderSlot)) {
    orderPts = battingOrderSlot <= 3 ? 8 : battingOrderSlot <= 5 ? 4 : 0;
    score += orderPts;
    reasons.push(`batting ${battingOrderSlot}${ordinalSuffix(battingOrderSlot)} (+${orderPts})`);
  }

  let vsTeamPts = 0;
  if (Number.isInteger(vsTeamPa) && vsTeamPa >= 20 && vsTeamAvg !== null && vsTeamAvg !== undefined) {
    vsTeamPts = bucket(vsTeamAvg, [[0.330, 8], [0.280, 4], [0.200, 0]], -5);
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

// ---------------------------------------------------------------------------
// 2C. Home run props.
//
// The old wind/HR filter ranked almost entirely on trailing HR rate plus a
// wind bonus, which is the wrong shape for this market: over 15 games,
// home runs are so rare that the rate is mostly noise (one extra homer
// swings it by 7 points), and it says nothing about whether the contact
// underneath was real. Statcast is exactly what fixes that -- barrel rate
// and exit velocity are the most stable, most predictive HR inputs
// available, and they stabilize far faster than the HR rate itself.
//
// DO NOT USE: opposing pitcher ERA (same reason as hit props -- it doesn't
// measure the thing being asked). What matters from the arm is how often
// he actually gives up home runs and how hard he's being hit.
export function scoreHomeRunProp({
  barrelPct,           // Savant, batter's own barrel rate -- the single best HR input
  avgExitVelo,         // Savant, batter's average exit velocity
  hardHitPct,          // Savant, batter's own hard-hit rate
  xslg,                // Savant, expected slugging (power output the contact deserves)
  trailing15HrRate,    // HR per game over the trailing window (empirical, noisy on its own)
  opposingHrPer9,      // how often today's starter actually allows home runs
  opposingBarrelPct,   // Savant, barrel rate the opposing arm allows
  windBlowingOut,      // verified park orientation only (see lib/geo.js)
  windSpeedMph,
  battingOrderSlot,
}) {
  const reasons = [];
  let score = 0;

  // Primary: the batter's own contact quality. Barrel rate carries the
  // most weight because a barrel is, by Statcast's definition, the exact
  // batted-ball profile that becomes a home run.
  const barrelPts = bucket(barrelPct, [[14, 27], [11, 21], [8, 14], [6, 7]]);
  score += barrelPts;
  if (barrelPct !== null && barrelPct !== undefined) reasons.push(`${fmtNum(barrelPct, 1)}% barrel rate (+${barrelPts})`);

  const eloPts = bucket(avgExitVelo, [[93, 9], [91, 6], [89, 3]]);
  score += eloPts;
  if (avgExitVelo !== null && avgExitVelo !== undefined) reasons.push(`${fmtNum(avgExitVelo, 1)} mph average exit velocity (+${eloPts})`);

  const xslgPts = bucket(xslg, [[0.500, 8], [0.450, 6], [0.400, 3]]);
  score += xslgPts;
  if (xslg !== null && xslg !== undefined) reasons.push(`${fmtNum(xslg, 3)} expected slugging (+${xslgPts})`);

  const hardHitPts = bucket(hardHitPct, [[45, 5], [38, 3]]);
  score += hardHitPts;
  if (hardHitPct !== null && hardHitPct !== undefined) reasons.push(`${fmtNum(hardHitPct, 0)}% hard-hit rate (+${hardHitPts})`);

  // The matchup: an arm that gives up home runs, measured directly.
  let oppPts;
  if (opposingHrPer9 === null || opposingHrPer9 === undefined) oppPts = 0;
  else if (opposingHrPer9 >= 1.8) oppPts = 14;
  else if (opposingHrPer9 >= 1.3) oppPts = 10;
  else if (opposingHrPer9 >= 1.0) oppPts = 4;
  else oppPts = -8; // an arm that genuinely suppresses homers is a real negative
  score += oppPts;
  if (opposingHrPer9 !== null && opposingHrPer9 !== undefined) {
    reasons.push(`opposing arm allows ${fmtNum(opposingHrPer9, 2)} HR/9 (${oppPts >= 0 ? '+' : ''}${oppPts})`);
  }

  const oppBarrelPts = bucket(opposingBarrelPct, [[10, 5], [8, 3]]);
  score += oppBarrelPts;
  if (opposingBarrelPct !== null && opposingBarrelPct !== undefined && oppBarrelPts > 0) {
    reasons.push(`opposing arm allows ${fmtNum(opposingBarrelPct, 1)}% barrels (+${oppBarrelPts})`);
  }

  // Secondary: recent HR production. Deliberately small -- it's the noisy
  // input this rewrite exists to demote, kept only as corroboration that
  // the contact quality above is currently turning into actual home runs.
  const ratePts = bucket(trailing15HrRate, [[0.35, 5], [0.20, 3], [0.10, 2]]);
  score += ratePts;
  if (trailing15HrRate !== null && trailing15HrRate !== undefined && ratePts > 0) {
    reasons.push(`${fmtNum(trailing15HrRate * 100, 0)}% of recent games with a homer (+${ratePts})`);
  }

  // Wind, only at a park whose orientation is verified (an unverified
  // bearing can't tell "out" from "in", see runHomeRunFilter). Still a
  // bonus rather than a requirement -- a masher facing a batting-practice
  // arm indoors beats a mediocre bat in a gale -- but scaled by speed now
  // instead of a flat nudge, because 20 mph straight out is a different
  // park than a 6 mph drift and the old flat +6/+3 could not say so.
  let windPts = 0;
  if (windBlowingOut) {
    windPts = bucket(windSpeedMph, [[15, 10], [10, 7], [5, 4]], 3);
    score += windPts;
    reasons.push(`wind blowing out${windSpeedMph ? ` at ${fmtNum(windSpeedMph, 0)} mph` : ''} (+${windPts})`);
  }

  // The confluence bonus: a real power bat, an arm that gives up homers,
  // AND wind pushing the ball out. Scored above the sum of its parts on
  // purpose -- these three compound rather than add, because the same
  // batted ball that is a warning-track out in still air off a groundball
  // pitcher leaves the yard in this spot. This is the specific setup the
  // board exists to find, so it is worth naming rather than leaving the
  // reader to notice three separate lines happened to co-occur.
  const powerBat = barrelPct !== null && barrelPct !== undefined && barrelPct >= 11;
  const homerProneArm = opposingHrPer9 !== null && opposingHrPer9 !== undefined && opposingHrPer9 >= 1.3;
  if (windBlowingOut && powerBat && homerProneArm) {
    score += 7;
    reasons.push('power bat + homer-prone arm + wind out (+7)');
  }

  // More trips to the plate is more chances to run into one.
  if (Number.isInteger(battingOrderSlot)) {
    const orderPts = battingOrderSlot <= 5 ? 4 : 0;
    score += orderPts;
    if (orderPts) reasons.push(`batting ${battingOrderSlot}${ordinalSuffix(battingOrderSlot)} (+${orderPts})`);
  }

  score = clampScore(score);

  // Hard floor: a top grade on a home run pick has to be backed by
  // Statcast, not by a hot week. Without barrel data on file there is no
  // evidence the contact quality is real, so the pick cannot grade above
  // B no matter how many homers he happened to hit lately.
  const B_TOP = 69;
  if ((barrelPct === null || barrelPct === undefined) && score > B_TOP) {
    score = B_TOP;
    reasons.push('capped at B: no Savant barrel data on file, so the contact quality behind the recent homers is unverified');
  }

  return { score, grade: letterGrade(score), reasons, surfaced: score >= MIN_SURFACE_SCORE };
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

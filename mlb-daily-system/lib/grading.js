import { fmtNum } from './util/format.js';

// One shared 0-100 score and letter grade across every pick type
// (moneyline, hit prop, strikeout prop), so a user learns the scale once.
// Built entirely from data already on file: season/trailing ERA, K/hit
// form, plus Baseball Savant's Statcast metrics (xERA, whiff%, hard-hit%,
// K%, BB%) layered on top when we have them for that pitcher that day.
// Savant is best-effort (see lib/sources/savant.js): every field here is
// optional, and a pick with no Savant data on file still grades, just off
// fewer inputs.
const THRESHOLDS = [
  [90, 'A+'],
  [80, 'A'],
  [70, 'B+'],
  [58, 'B'],
  [45, 'C+'],
  [0, 'C'],
];

export function letterGrade(score) {
  for (const [min, label] of THRESHOLDS) {
    if (score >= min) return label;
  }
  return 'C';
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Statcast xERA vs. actual ERA: when xERA is well above ERA, the pitcher's
// results have been running hotter than his underlying stuff/contact
// quality, a real "he's due to get hit" signal, not survivorship. Below
// 0.3 runs of gap is noise, not treated as a signal either way.
function savantLuckNote(s, wantsBad) {
  if (!s || s.era === null || s.era === undefined || s.xera === null || s.xera === undefined) return null;
  const gap = s.xera - s.era; // positive = pitching worse than his ERA shows
  if (Math.abs(gap) < 0.3) return null;
  if (wantsBad && gap > 0) {
    return { bonus: Math.min(12, gap * 6), note: `xERA ${fmtNum(s.xera)} runs hotter than his ${fmtNum(s.era)} ERA, been getting away with contact` };
  }
  if (!wantsBad && gap < 0) {
    return { bonus: Math.min(10, -gap * 5), note: `xERA ${fmtNum(s.xera)} backs up the ${fmtNum(s.era)} ERA, this isn't a fluke` };
  }
  return null;
}

// wantsBad = true when a worse arm is the good outcome for this pick
// (hit props, moneyline-against); false when a better arm is (strikeouts).
// Shared so the same Savant fields read the same direction consistently
// across every pick type.
function savantArmNotes(s, wantsBad) {
  const notes = [];
  let bonus = 0;
  if (!s) return { bonus, notes };

  const luck = savantLuckNote(s, wantsBad);
  if (luck) {
    bonus += luck.bonus;
    notes.push(luck.note);
  }
  if (s.hardHitPct !== null && s.hardHitPct !== undefined) {
    if (wantsBad && s.hardHitPct >= 42) {
      bonus += 8;
      notes.push(`${s.hardHitPct.toFixed(0)}% hard-hit rate allowed (Statcast)`);
    } else if (!wantsBad && s.hardHitPct <= 32) {
      bonus += 6;
      notes.push(`${s.hardHitPct.toFixed(0)}% hard-hit rate allowed, well below average`);
    }
  }
  if (s.whiffPct !== null && s.whiffPct !== undefined) {
    if (wantsBad && s.whiffPct <= 20) {
      bonus += 5;
      notes.push(`${s.whiffPct.toFixed(0)}% whiff rate, hitters aren't missing`);
    } else if (!wantsBad && s.whiffPct >= 28) {
      bonus += 6;
      notes.push(`${s.whiffPct.toFixed(0)}% whiff rate, hitters are missing a lot`);
    }
  }
  if (s.kPct !== null && s.kPct !== undefined && !wantsBad && s.kPct >= 25) {
    bonus += 5;
    notes.push(`${s.kPct.toFixed(0)}% strikeout rate`);
  }
  if (s.bbPct !== null && s.bbPct !== undefined) {
    if (wantsBad && s.bbPct >= 10) {
      bonus += 4;
      notes.push(`${s.bbPct.toFixed(0)}% walk rate, control has been shaky`);
    } else if (!wantsBad && s.bbPct <= 6) {
      bonus += 3;
      notes.push(`${s.bbPct.toFixed(0)}% walk rate, throwing strikes`);
    }
  }
  return { bonus: Math.min(25, bonus), notes };
}

// Moneyline grade. The pick QUALIFIES on one hard gate (home season ERA
// 2+ runs better than away, see lib/filters/moneyline.js); the grade then
// answers "how strong a qualifier is it", so the Daily Slate can publish
// the single BEST moneyline and the Research tab can rank them all. Every
// term maps to something a bettor actually checks; it's an explainable
// heuristic, not a model fit to outcomes, and the reasons list says so by
// showing exactly what moved the score. Savant (xERA, whiff%, hard-hit%,
// K%, BB%) sharpens "the home arm is genuinely better" and "the away arm
// is genuinely hittable" beyond the two season-ERA numbers, and is
// optional: a pick with no Savant on file still grades, off fewer inputs.
export function gradeMoneyline({
  seasonEdge, homeSeasonEra, awaySeasonEra, breakevenPct: bePct,
  startersConfirmed, homeSavant, awaySavant,
}) {
  const reasons = [];
  // Base: a bare qualifier (exactly a 2.0 edge) lands mid-B and climbs.
  let score = 55;

  // 1. Size of the season-ERA edge past the 2.0 gate: the whole reason
  //    the pick exists. Each run beyond the threshold is worth ~11 pts.
  const edge = seasonEdge ?? 2.0;
  score += Math.min(26, Math.max(0, (edge - 2.0)) * 11);
  reasons.push(`home starter's season ERA is ${fmtNum(edge)} runs better (${fmtNum(homeSeasonEra)} vs ${fmtNum(awaySeasonEra)})`);

  // 2. Home starter's own quality in absolute terms: an ace anchoring the
  //    favorite is more trustworthy than a mediocre arm who only looks
  //    good next to a terrible one.
  if (homeSeasonEra !== null && homeSeasonEra !== undefined) {
    const q = Math.min(10, Math.max(0, 4.0 - homeSeasonEra) * 4);
    if (q > 0) { score += q; reasons.push(`home starter is strong on the year (${fmtNum(homeSeasonEra)} ERA)`); }
  }

  // 3. Baseball Savant, both directions: the away arm looking hittable
  //    (wantsBad = true) and the home arm looking legit (wantsBad = false).
  const awayNotes = savantArmNotes(awaySavant, true);
  if (awayNotes.bonus) { score += awayNotes.bonus; reasons.push(...awayNotes.notes.map((n) => `opposing arm: ${n}`)); }
  const homeNotes = savantArmNotes(homeSavant, false);
  if (homeNotes.bonus) { score += Math.min(12, homeNotes.bonus); reasons.push(...homeNotes.notes.map((n) => `home arm: ${n}`)); }

  // 4. Price value: a cheaper favorite is a better bet at the same edge.
  //    Small, deliberately, price is a filter first and a tie-breaker
  //    second, never the main driver.
  if (bePct !== null && bePct !== undefined) {
    const v = (0.60 - bePct) * 30; // ~ -115 => +2, -180 => -1.3
    score += Math.max(-4, Math.min(5, v));
  }

  // 5. Confirmed lineups: a small nudge for a pick riding on posted
  //    starters over projected ones.
  if (startersConfirmed) { score += 3; reasons.push('both lineups officially posted'); }

  score = clampScore(score);
  return { score, grade: letterGrade(score), reasons };
}

// Hard floor for hit props: a batter who isn't actually hitting well
// (below .280 trailing) cannot be graded above a B, no matter how hot
// his streak is or how bad the arm he's facing is. A grade should never
// imply "this is a great bat", only "this is a great matchup for a bat
// that's actually hitting" - those are different claims, and blending
// them is exactly how a .236 hitter on a lucky streak ends up graded A.
// Applied AFTER the normal score so it can clamp a score that would
// otherwise letter-grade above B back down, keeping the numeric score
// and the displayed letter in agreement.
const HIT_AVG_FLOOR = 0.28;
const HIT_AVG_FLOOR_CAP_SCORE = 69; // top of the 'B' band in THRESHOLDS

// Hit props: hot recent form (streak + trailing average) against a
// beatable arm. Savant on the opposing starter sharpens "beatable" beyond
// a single trailing-ERA number.
export function gradeHitProp({ hitStreak, trailing15Avg, opposingTrailingEra, opposingSavant }) {
  const formPart = (hitStreak ?? 0) * 2.2 + Math.max(0, (trailing15Avg ?? 0) - 0.28) * 90;
  const armPart = opposingTrailingEra !== null && opposingTrailingEra !== undefined
    ? Math.max(0, opposingTrailingEra - 4.2) * 6
    : 0;
  let score = 35 + formPart + armPart;
  const reasons = [];
  if (hitStreak >= 2) reasons.push(`${hitStreak}-game hit streak`);
  if (trailing15Avg !== null && trailing15Avg !== undefined) reasons.push(`batting ${fmtNum(trailing15Avg, 3)} over his last 15`);
  if (opposingTrailingEra !== null && opposingTrailingEra !== undefined) reasons.push(`opposing arm has a ${fmtNum(opposingTrailingEra)} ERA over his last starts`);
  const { bonus, notes } = savantArmNotes(opposingSavant, true);
  score += bonus;
  reasons.push(...notes);
  score = clampScore(score);

  if ((trailing15Avg === null || trailing15Avg === undefined || trailing15Avg < HIT_AVG_FLOOR) && score > HIT_AVG_FLOOR_CAP_SCORE) {
    score = HIT_AVG_FLOOR_CAP_SCORE;
    reasons.push(`capped at B: trailing average is below the ${HIT_AVG_FLOOR.toFixed(3)} floor for a top grade`);
  }

  return { score, grade: letterGrade(score), reasons };
}

// Strikeouts: a high, consistent K floor from his own recent starts, plus
// how many Ks per start and how sharp the arm's been. Savant on his OWN
// numbers (not the opponent's) adds K%/whiff%/BB% context.
export function gradeStrikeout({ strictFloorKs, kPerStart, trailingEra, ownSavant }) {
  let score = 30 + (strictFloorKs ?? 0) * 5 + (kPerStart ?? 0) * 2 + Math.max(0, 4.3 - (trailingEra ?? 4.3)) * 8;
  const reasons = [`${strictFloorKs}+ strikeouts in every recent start`];
  if (kPerStart !== null && kPerStart !== undefined) reasons.push(`${fmtNum(kPerStart, 1)} Ks per start lately`);
  if (trailingEra !== null && trailingEra !== undefined) reasons.push(`${fmtNum(trailingEra)} ERA over that stretch`);
  const { bonus, notes } = savantArmNotes(ownSavant, false);
  score += bonus;
  reasons.push(...notes);
  score = clampScore(score);
  return { score, grade: letterGrade(score), reasons };
}

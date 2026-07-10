import { fmtNum } from './util/format.js';

// One shared 0-100 score and letter grade for every pick type (moneyline,
// hit prop, strikeout prop), so a user learns the scale once. Built
// entirely from data already on file: season ERA, trailing ERA, K/hit
// form, plus Baseball Savant's Statcast metrics (xERA, whiff%, hard-hit%,
// K%, BB%) layered on top when we have them for that pitcher that day.
// Savant is best-effort (see lib/sources/savant.js): every field here is
// optional, and a pick with no Savant data on file still grades, just
// off fewer inputs.
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
// (hit props, moneyline-against); false when a better arm is (moneyline,
// strikeouts). Shared so the same Savant fields read the same direction
// consistently across every pick type.
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

// Moneyline: the home starter's season-ERA edge over the away starter is
// the qualifying bar (2+ runs, see filters/moneyline.js); the grade turns
// that single cutoff into a spectrum, and Savant on the away starter
// either confirms he's really that bad or flags his ERA as better luck
// than stuff.
export function gradeMoneyline({ eraEdge, awaySavant }) {
  let score = 50 + (eraEdge ?? 0) * 9;
  const reasons = [`${fmtNum(eraEdge)}-run season ERA edge, home starter over the visitor`];
  const { bonus, notes } = savantArmNotes(awaySavant, true);
  score += bonus;
  reasons.push(...notes);
  score = clampScore(score);
  return { score, grade: letterGrade(score), reasons };
}

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

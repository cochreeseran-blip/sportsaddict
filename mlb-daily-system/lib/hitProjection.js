// Expected-hits projection: how many hits a batter is likely to get today,
// not just whether he gets one.
//
// WHY THIS EXISTS: "will he get 1+ hit" is a weak question. Any regular
// facing a normal starter is somewhere around a coin flip to two-thirds,
// so nearly the whole league qualifies and the pick itself carries almost
// no information. "How many hits" separates the board: the batters with a
// real shot at 2+ are a much smaller group, and the same projection also
// says which 1+ plays are the genuinely safe ones. One model, two tiers,
// so the tiers can never contradict each other.
//
// THE MODEL: a binomial over the batter's expected at-bats.
//   p  = per-at-bat hit probability (blended, see hitProbability below)
//   n  = expected at-bats today (from lineup slot, see EXPECTED_AB_BY_SLOT)
//   P(0 hits)     = (1-p)^n
//   P(exactly 1)  = n * p * (1-p)^(n-1)
//   P(1+)         = 1 - P(0)
//   P(2+)         = 1 - P(0) - P(exactly 1)
//
// HONEST LIMITS, stated plainly because this is the number the whole hit
// board now rests on:
//   - At-bats are treated as independent trials with a constant p. They
//     aren't: a batter can face the starter twice and a lefty specialist
//     the third time, and a blowout changes how the last at-bat goes.
//   - p is a blend with hand-picked weights (see WEIGHTS). Those weights
//     are reasoned, not fitted to outcome data. Nobody has backtested
//     "trailing average should count 45%".
//   - Expected at-bats by lineup slot are league-typical values, not this
//     team's actual pace.
// What the model DOES do reliably is rank: two batters with the same
// inputs get the same number, and a better contact profile in a better
// lineup slot always projects higher. Treat the probabilities as a
// calibrated-ish ranking signal, not a betting-market price.

// League-typical plate appearances by lineup slot, converted to at-bats
// (PA minus the walks/HBP/sac that don't count as an AB, roughly 12%).
// A leadoff hitter really does get about one extra trip per game over the
// 9-hole, and that difference is most of why lineup position matters for
// a multi-hit projection at all.
const EXPECTED_AB_BY_SLOT = {
  1: 4.15,
  2: 4.05,
  3: 3.95,
  4: 3.90,
  5: 3.80,
  6: 3.70,
  7: 3.60,
  8: 3.50,
  9: 3.40,
};
// Used when the lineup hasn't posted yet, so a projection can still be
// made (flagged projected, not confirmed, everywhere it's shown). Sits
// near the middle of the order on purpose: assuming leadoff would inflate
// every unposted batter's multi-hit odds.
const DEFAULT_EXPECTED_AB = 3.75;

// Blend weights for the per-at-bat hit probability. Trailing average is
// the largest single input (it's the batter's actual recent production),
// xBA is the contact-quality check on it (catches both the lucky hot
// streak and the unlucky cold one), and the opposing arm's hits allowed
// per 9 is the matchup. They sum to 1 over whichever inputs are present.
const WEIGHTS = { trailingAvg: 0.45, xba: 0.35, opposing: 0.20 };

// League-average-ish batting average, the fallback when a component is
// missing and the anchor the opposing-pitcher adjustment works from.
const LEAGUE_AVG = 0.248;
// A starter allowing this many hits per 9 innings is league average; the
// matchup component scales around it.
const LEAGUE_H9 = 8.6;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Convert the opposing starter's hits-allowed rate into an implied batting
// average against. H/9 divided by roughly 3 at-bats faced per inning gives
// a batting-average-scaled number; anchored so LEAGUE_H9 maps to
// LEAGUE_AVG, and clamped because a two-start sample can produce absurd
// extremes that shouldn't swing a projection by 200 points of average.
function opposingImpliedAvg(hitsPer9) {
  if (hitsPer9 === null || hitsPer9 === undefined) return null;
  const implied = LEAGUE_AVG * (hitsPer9 / LEAGUE_H9);
  return clamp(implied, 0.18, 0.34);
}

// Per-at-bat hit probability. Returns { p, components } so the UI can show
// exactly which inputs produced the number rather than a bare percentage.
export function hitProbability({ trailing15Avg, xba, opposingHitsPer9 }) {
  const parts = [];
  if (trailing15Avg !== null && trailing15Avg !== undefined) {
    parts.push({ key: 'trailingAvg', value: Number(trailing15Avg), weight: WEIGHTS.trailingAvg });
  }
  if (xba !== null && xba !== undefined) {
    parts.push({ key: 'xba', value: Number(xba), weight: WEIGHTS.xba });
  }
  const impliedOpp = opposingImpliedAvg(opposingHitsPer9);
  if (impliedOpp !== null) {
    parts.push({ key: 'opposing', value: impliedOpp, weight: WEIGHTS.opposing });
  }

  // Nothing to go on at all: fall back to league average rather than
  // returning null, so a batter never silently disappears from the board
  // because one optional Savant field was missing.
  if (!parts.length) {
    return { p: LEAGUE_AVG, components: [], basis: 'league average (no inputs on file)' };
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const blended = parts.reduce((sum, part) => sum + part.value * part.weight, 0) / totalWeight;

  return {
    // Floor and ceiling: a real major-league hitter's per-AB hit
    // probability essentially never lives outside this range, and letting
    // a thin sample push past it would produce nonsense tier probabilities.
    p: clamp(blended, 0.15, 0.42),
    components: parts.map((part) => ({ key: part.key, value: part.value, weightPct: Math.round((part.weight / totalWeight) * 100) })),
    basis: parts.map((part) => part.key).join(' + '),
  };
}

export function expectedAtBats(battingOrderSlot) {
  if (Number.isInteger(battingOrderSlot) && EXPECTED_AB_BY_SLOT[battingOrderSlot]) {
    return EXPECTED_AB_BY_SLOT[battingOrderSlot];
  }
  return DEFAULT_EXPECTED_AB;
}

// The binomial itself. n is fractional (expected at-bats isn't a whole
// number), so this uses the continuous form: (1-p)^n for the zero-hit
// case and n*p*(1-p)^(n-1) for exactly one. That's an approximation of a
// binomial with non-integer trials, and it's the right kind of
// approximation here: it moves smoothly with lineup slot instead of
// jumping when expected at-bats crosses a whole number.
export function projectHits({ trailing15Avg, xba, opposingHitsPer9, battingOrderSlot }) {
  const { p, components, basis } = hitProbability({ trailing15Avg, xba, opposingHitsPer9 });
  const n = expectedAtBats(battingOrderSlot);

  const pZero = Math.pow(1 - p, n);
  const pExactlyOne = n * p * Math.pow(1 - p, n - 1);
  const pAtLeastOne = clamp(1 - pZero, 0, 1);
  const pAtLeastTwo = clamp(1 - pZero - pExactlyOne, 0, 1);

  return {
    hitProbPerAb: round3(p),
    expectedAtBats: round2(n),
    expectedHits: round2(p * n),
    pAtLeastOne: round3(pAtLeastOne),
    pAtLeastTwo: round3(pAtLeastTwo),
    lineupSlotKnown: Number.isInteger(battingOrderSlot),
    components,
    basis,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

// Break-even win probability implied by an American odds price, the
// rate a pick needs to hit just to come out flat, ignoring vig on the
// other side. Standard formula, correct for both favorites and dogs:
//   negative (favorite) odds: |odds| / (|odds| + 100)
//   positive (underdog) odds: 100 / (odds + 100)
// The spec for this only ever calls it on negative odds (this system
// only ever picks home favorites), where both forms are identical; this
// implementation is branched so it stays correct if it's ever reused for
// an underdog price.
export function breakevenPct(americanOdds) {
  if (americanOdds === null || americanOdds === undefined) return null;
  const abs = Math.abs(americanOdds);
  return americanOdds < 0 ? abs / (abs + 100) : 100 / (abs + 100);
}

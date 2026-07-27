// Per-team cap for player prop boards.
//
// The boards now show and grade EVERY qualifying batter rather than a
// fixed top-N, which is what makes the Finder a research tool instead of
// a highlight reel. The failure mode that opens up is concentration: on a
// day when one lineup is in a genuinely great spot (weak arm, hitter's
// park, wind out) that team can plausibly own the top ten rows of the
// board, and a board that is nine Dodgers is not a slate, it is one bet
// with nine names on it.
//
// So: rank globally, then walk the ranked list and take at most
// DEFAULT_PER_TEAM from any one team. Order is preserved, which matters --
// this keeps each team's BEST candidates and drops its marginal ones,
// rather than cutting off whoever happened to sort last.
//
// This is a display/selection cap, not a scoring change. Nothing is
// re-graded and nothing is hidden from the underlying scored list; the
// full set is still returned alongside so the Finder can show everything
// when the owner wants to see it.

export const DEFAULT_PER_TEAM = 5;

// `list` must already be sorted best-first. `teamOf` reads the team key
// off a row (defaults to `.team`).
export function capPerTeam(list, perTeam = DEFAULT_PER_TEAM, teamOf = (r) => r.team) {
  if (!Array.isArray(list) || perTeam <= 0) return [];
  const seen = new Map();
  const out = [];
  for (const row of list) {
    const key = teamOf(row) ?? '__unknown__';
    const n = seen.get(key) || 0;
    if (n >= perTeam) continue;
    seen.set(key, n + 1);
    out.push(row);
  }
  return out;
}

// How many rows each team contributed, for the Finder's "why is this
// board shaped like this" readout.
export function teamCounts(list, teamOf = (r) => r.team) {
  const counts = new Map();
  for (const row of list) {
    const key = teamOf(row) ?? '__unknown__';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

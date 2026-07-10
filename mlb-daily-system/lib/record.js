// The dual public record (/record): two W-L lines, both public, both
// always visible, neither ever hidden or pruned. ALGORITHM is every
// moneyline pick the pipeline ever generated (published or not) —
// answers "does the filter work". PUBLISHED is only the picks an admin
// actually put in front of people — answers "what did I actually call".
// Conflating them would let a good filter's record get diluted by
// picks nobody ever saw, or let a curated record hide how often the
// filter itself whiffs. Both get shown, on purpose.

// Below this many graded (win+loss) picks, a win rate is more noise than
// signal, shown as raw W-L with an explicit note instead. Same threshold
// and the same reasoning as the Daily Slate's yesterday-strip (see
// web/app.js MIN_GRADED_FOR_RATE) — one number, reused everywhere a
// record shows up, so the bar for "this percentage means something"
// never quietly differs between two parts of the same product.
export const MIN_GRADED_FOR_RATE = 50;

function summarize(rows) {
  let wins = 0, losses = 0, pushes = 0, pending = 0;
  let breakevenSum = 0, breakevenCount = 0;
  for (const r of rows) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else if (r.result === 'push') pushes++;
    else pending++;
    if ((r.result === 'win' || r.result === 'loss') && r.breakeven_pct !== null && r.breakeven_pct !== undefined) {
      breakevenSum += Number(r.breakeven_pct);
      breakevenCount++;
    }
  }
  const graded = wins + losses;
  return {
    wins, losses, pushes, pending, graded,
    winRate: graded >= MIN_GRADED_FOR_RATE ? wins / graded : null,
    sampleTooSmall: graded < MIN_GRADED_FOR_RATE,
    avgRequiredBreakeven: breakevenCount ? breakevenSum / breakevenCount : null,
  };
}

export async function buildDualRecord(pool) {
  const { rows } = await pool.query(
    `SELECT result, breakeven_pct, published FROM tracked_picks WHERE signal_type = 'moneyline'`
  );
  return {
    algorithm: summarize(rows), // every row: published or not
    published: summarize(rows.filter((r) => r.published)),
  };
}

import { fetchMoneylines, normalizeTeam } from './sources/odds.js';
import { breakevenPct } from './breakeven.js';

// See scripts/closing.js for the original CLI entry point and the sign-
// convention note on computeClvPct; extracted here unchanged so
// server.js can also run this once a day on a timer (the second of the
// two allowed Odds API calls per day, see the fetchOdds note on
// runPipeline in lib/pipeline.js) without shelling out to the script.
function computeClvPct(lockedPrice, lockedBreakeven, closingPrice) {
  const locked = lockedBreakeven !== null && lockedBreakeven !== undefined ? Number(lockedBreakeven) : breakevenPct(lockedPrice);
  const closing = breakevenPct(closingPrice);
  if (locked === null || closing === null) return null;
  return closing - locked;
}

export async function pullClosingLines(pool, gameDate) {
  if (!process.env.ODDS_API_KEY) return { skipped: 'ODDS_API_KEY not set' };

  const { rows: picks } = await pool.query(
    `SELECT * FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline' AND closing_price IS NULL`,
    [gameDate]
  );
  if (!picks.length) return { updated: 0, total: 0 };

  const moneylines = await fetchMoneylines(process.env.ODDS_API_KEY);
  let updated = 0;
  for (const pick of picks) {
    const homeTeam = pick.qualifying_metrics?.homeTeam;
    const awayTeam = pick.qualifying_metrics?.awayTeam;
    const match = moneylines.find(
      (o) => normalizeTeam(o.homeTeam) === normalizeTeam(homeTeam) && normalizeTeam(o.awayTeam) === normalizeTeam(awayTeam)
    );
    if (!match || match.homeMl === null) continue;
    const clvPct = computeClvPct(pick.locked_price, pick.breakeven_pct, match.homeMl);
    // Allowed on a published row: the trigger only guards description/
    // locked_price/breakeven_pct/qualifying_metrics, not closing_price/clv_pct.
    await pool.query('UPDATE tracked_picks SET closing_price = $1, clv_pct = $2 WHERE id = $3', [
      match.homeMl, clvPct, pick.id,
    ]);
    updated++;
  }
  return { updated, total: picks.length };
}

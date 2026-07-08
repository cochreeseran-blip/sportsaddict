import 'dotenv/config';
import { pool } from '../lib/db.js';
import { fetchMoneylines, normalizeTeam } from '../lib/sources/odds.js';
import { breakevenPct } from '../lib/breakeven.js';
import { todayIsoDate } from '../lib/pipeline.js';

// JUDGMENT CALL (flagged for review): the spec defines
//   clv_pct = breakeven_pct(locked_price) - breakeven_pct(closing_price)
// and says "positive means the market moved toward the picked side after
// the lock." Those two statements contradict each other. Example: locked
// at -140 (breakeven 58.3%), closes at -160 (breakeven 61.5%) because the
// market agreed more with the pick. That IS "the market moving toward the
// picked side" — but locked-minus-closing on those numbers is negative
// (58.3 - 61.5), not positive. The literal formula's sign is backwards
// from its own description, and also backwards from the conventional
// sports-betting meaning of "positive CLV" (you got a better price than
// the closing market). This implementation matches the STATED meaning
// (positive = market moved toward the picked side = you beat the close),
// i.e. clv_pct = breakeven_pct(closing) - breakeven_pct(locked). If the
// formula as literally written was actually intended and the prose is
// what's wrong, this is a one-line sign flip to fix.
function computeClvPct(lockedPrice, lockedBreakeven, closingPrice) {
  const locked = lockedBreakeven !== null && lockedBreakeven !== undefined ? Number(lockedBreakeven) : breakevenPct(lockedPrice);
  const closing = breakevenPct(closingPrice);
  if (locked === null || closing === null) return null;
  return closing - locked;
}

async function main() {
  const gameDate = process.argv[2] || todayIsoDate();

  if (!process.env.ODDS_API_KEY) {
    console.error('ODDS_API_KEY is not set — cannot pull closing lines.');
    process.exitCode = 1;
    return;
  }

  const { rows: picks } = await pool.query(
    `SELECT * FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline' AND closing_price IS NULL`,
    [gameDate]
  );

  if (!picks.length) {
    console.log(`No moneyline picks for ${gameDate} still need a closing price.`);
    return;
  }

  console.log(`Pulling closing odds for ${gameDate}...`);
  const moneylines = await fetchMoneylines(process.env.ODDS_API_KEY);

  let updated = 0;
  for (const pick of picks) {
    const homeTeam = pick.qualifying_metrics?.homeTeam;
    const awayTeam = pick.qualifying_metrics?.awayTeam;
    const match = moneylines.find(
      (o) => normalizeTeam(o.homeTeam) === normalizeTeam(homeTeam) && normalizeTeam(o.awayTeam) === normalizeTeam(awayTeam)
    );
    if (!match || match.homeMl === null) {
      console.warn(`  No closing line found for ${awayTeam} @ ${homeTeam} — skipping (game may have started/finished already).`);
      continue;
    }
    const clvPct = computeClvPct(pick.locked_price, pick.breakeven_pct, match.homeMl);
    await pool.query('UPDATE tracked_picks SET closing_price = $1, clv_pct = $2 WHERE id = $3', [
      match.homeMl,
      clvPct,
      pick.id,
    ]);
    console.log(
      `  ${awayTeam} @ ${homeTeam}: locked ${pick.locked_price} -> closing ${match.homeMl}` +
        (clvPct !== null ? ` (CLV ${clvPct >= 0 ? '+' : ''}${(clvPct * 100).toFixed(1)} pts)` : '')
    );
    updated++;
  }
  console.log(`\nUpdated ${updated}/${picks.length} moneyline pick(s) with a closing price for ${gameDate}.`);
}

main()
  .catch((err) => {
    console.error('Closing line pull failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

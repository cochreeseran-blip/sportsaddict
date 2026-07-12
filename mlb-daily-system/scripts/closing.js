import 'dotenv/config';
import { pool } from '../lib/db.js';
import { pullClosingLines } from '../lib/closingLine.js';
import { todayIsoDate } from '../lib/pipeline.js';

async function main() {
  const gameDate = process.argv[2] || todayIsoDate();

  if (!process.env.ODDS_API_KEY) {
    console.error('ODDS_API_KEY is not set — cannot pull closing lines.');
    process.exitCode = 1;
    return;
  }

  console.log(`Pulling closing odds for ${gameDate}...`);
  const result = await pullClosingLines(pool, gameDate);
  if (result.total === 0) {
    console.log(`No moneyline picks for ${gameDate} still need a closing price.`);
    return;
  }
  console.log(`\nUpdated ${result.updated}/${result.total} moneyline pick(s) with a closing price for ${gameDate}.`);
}

main()
  .catch((err) => {
    console.error('Closing line pull failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

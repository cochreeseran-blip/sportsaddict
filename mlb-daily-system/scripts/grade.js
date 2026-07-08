import 'dotenv/config';
import { pool } from '../lib/db.js';
import { gradePendingPicks } from '../lib/trackedPicks.js';

async function main() {
  console.log('Grading pending tracked picks against final MLB scores/box scores...');
  const summary = await gradePendingPicks(pool);
  console.log(
    `\nChecked ${summary.total} pending pick(s): ${summary.graded} graded, ` +
      `${summary.stillPending} still pending (game not final yet), ${summary.errors} error(s).`
  );
  if (summary.total === 0) {
    console.log('Nothing to grade yet — that\'s expected right after this feature ships. Run `npm run job` daily and check back once games have finished.');
  }
}

main()
  .catch((err) => {
    console.error('Grading failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

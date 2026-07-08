// Manually send (or dry-run) the daily newsletter: `npm run newsletter`.
// Optional date arg: `node scripts/newsletter.js 2026-07-08`.
import 'dotenv/config';
import { pool } from '../lib/db.js';
import { todayIsoDate } from '../lib/pipeline.js';
import { sendDailyNewsletter } from '../lib/newsletter.js';

const gameDate = process.argv[2] || todayIsoDate();

sendDailyNewsletter(pool, gameDate)
  .then((r) => console.log('Newsletter result:', r))
  .catch((err) => {
    console.error('Newsletter failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

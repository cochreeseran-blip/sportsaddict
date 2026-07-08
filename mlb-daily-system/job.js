import 'dotenv/config';
import { pool } from './lib/db.js';
import { runPipeline, todayIsoDate } from './lib/pipeline.js';
import { printDigest } from './lib/digest.js';

// Optional CLI override: `node job.js 2026-07-08`. Defaults to today (UTC
// calendar date, which is what the MLB schedule endpoint expects).
const gameDate = process.argv[2] || todayIsoDate();

runPipeline(gameDate)
  .then((result) => printDigest(result))
  .catch((err) => {
    console.error('Job failed with an unexpected error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

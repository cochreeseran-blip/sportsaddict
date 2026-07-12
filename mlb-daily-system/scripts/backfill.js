import 'dotenv/config';
import { pool } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';
import { runFullBackfill } from '../lib/data/backfill.js';

// One-time (resumable) historical pull: `npm run backfill` or
// `npm run backfill -- 2023 2024` to scope specific seasons. Safe to
// interrupt (Ctrl+C) and re-run -- backfill_progress checkpoints per
// player, see lib/data/backfill.js. This will take a while: per the spec,
// potentially hours for 500k+ game log rows across 3 seasons.
async function main() {
  const argSeasons = process.argv.slice(2).map(Number).filter(Number.isFinite);
  const seasons = argSeasons.length ? argSeasons : [2023, 2024, 2025];
  await runMigrations(pool);
  console.log(`Starting historical backfill for season(s): ${seasons.join(', ')}`);
  await runFullBackfill(pool, seasons);
  console.log('\nBackfill run complete.');
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

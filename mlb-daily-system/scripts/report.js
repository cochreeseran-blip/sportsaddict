import 'dotenv/config';
import { pool } from '../lib/db.js';

const MIN_SAMPLE_FOR_SIGNAL = 20;

async function main() {
  const { rows } = await pool.query(`
    SELECT
      signal_type,
      count(*) FILTER (WHERE result IN ('win', 'loss')) AS graded,
      count(*) FILTER (WHERE result = 'win') AS wins,
      count(*) FILTER (WHERE result = 'loss') AS losses,
      count(*) FILTER (WHERE result = 'push') AS pushes,
      count(*) FILTER (WHERE result = 'pending') AS pending,
      avg(breakeven_pct) FILTER (WHERE result IN ('win', 'loss') AND breakeven_pct IS NOT NULL) AS avg_breakeven
    FROM tracked_picks
    GROUP BY signal_type
    ORDER BY signal_type
  `);

  console.log('\n' + '='.repeat(60));
  console.log('TRACKED PICKS REPORT — actual results vs. break-even');
  console.log('='.repeat(60));

  if (!rows.length) {
    console.log('\nNo tracked picks yet. Run `npm run job` a few times to start\naccumulating, then `npm run grade` once those games are final.\n');
    return;
  }

  for (const r of rows) {
    const graded = Number(r.graded);
    const wins = Number(r.wins);
    const winRate = graded > 0 ? wins / graded : null;

    console.log(`\n--- ${r.signal_type} ---`);
    console.log(`  Graded: ${graded} (${wins}W / ${r.losses}L / ${r.pushes} push) — ${r.pending} still pending`);

    if (winRate === null) {
      console.log('  Actual win rate: n/a (nothing graded yet)');
    } else {
      console.log(`  Actual win rate: ${(winRate * 100).toFixed(1)}%`);
    }

    if (r.avg_breakeven !== null) {
      const avgBe = Number(r.avg_breakeven);
      console.log(`  Avg break-even needed: ${(avgBe * 100).toFixed(1)}%`);
      if (winRate !== null) {
        const edgePts = (winRate - avgBe) * 100;
        console.log(`  Edge: ${edgePts >= 0 ? '+' : ''}${edgePts.toFixed(1)} points ${edgePts >= 0 ? '(beating break-even)' : '(below break-even)'}`);
      }
    } else {
      console.log('  Avg break-even needed: n/a (not a fixed-odds pick type)');
    }

    if (graded > 0 && graded < MIN_SAMPLE_FOR_SIGNAL) {
      console.log(`  NOTE: Only ${graded} graded — statistically meaningless below ~${MIN_SAMPLE_FOR_SIGNAL}+ per category. This is expected while the ledger is young, not a bug.`);
    }
  }
  console.log('\n' + '='.repeat(60) + '\n');
}

main()
  .catch((err) => {
    console.error('Report failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import 'dotenv/config';
import { pool } from '../lib/db.js';

async function main() {
  const { rows } = await pool.query(
    'SELECT venue, out_bearing_degrees, confidence, source FROM park_orientations ORDER BY venue'
  );

  const verified = rows.filter((r) => r.out_bearing_degrees !== null);
  const unverified = rows.filter((r) => r.out_bearing_degrees === null);

  console.log('\n' + '='.repeat(100));
  console.log(`PARK ORIENTATION VERIFICATION — ${rows.length} parks (${verified.length} bearing-verified, ${unverified.length} unverified)`);
  console.log('='.repeat(100));
  console.log(
    `${'Park'.padEnd(32)} | ${'Bearing'.padEnd(8)} | ${'Confidence'.padEnd(20)} | Source`
  );
  console.log('-'.repeat(100));
  for (const r of rows) {
    const bearing = r.out_bearing_degrees !== null ? `${Number(r.out_bearing_degrees).toFixed(0)}°` : 'NULL';
    console.log(`${r.venue.padEnd(32)} | ${bearing.padEnd(8)} | ${(r.confidence ?? 'n/a').padEnd(20)} | ${r.source ?? ''}`);
  }
  console.log('-'.repeat(100));
  console.log(`\n${verified.length}/${rows.length} parks have a verified bearing. The wind/HR filter skips every game at an unverified park.\n`);
}

main()
  .catch((err) => {
    console.error('Park report failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

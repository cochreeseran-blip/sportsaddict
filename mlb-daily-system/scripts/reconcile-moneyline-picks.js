import 'dotenv/config';
import { pool } from '../lib/db.js';

// The moneyline screener used to gate on trailing (last 3-5 starts) ERA
// when it was available, falling back to season ERA only when trailing
// was missing. That rule is gone: qualification is season ERA only now
// (see lib/filters/moneyline.js). Anything locked into tracked_picks
// under the old rule needs re-checking, since a pick that looked good on
// a hot trailing stretch can be sitting on the board (and in the W/L
// record) despite never having a real season-ERA edge.
//
// Re-derives the verdict from data still on file rather than guessing:
// tracked_picks -> games (by game_date + mlb_game_id) for the starter
// ids, then -> pitcher_form (by game_date + pitcher_id) for each
// starter's season_era exactly as it stood on the pick's date. If either
// season ERA can't be found, the pick is left alone and reported as
// unverifiable rather than guessed at.
//
// Dry-run by default: prints what it would remove. Pass --confirm to
// actually delete. Pass --date=YYYY-MM-DD to scope to one day; omit for
// every date in the ledger.

const ERA_EDGE_MIN = 2.0;

function parseArgs(argv) {
  const args = { confirm: false, date: null };
  for (const a of argv) {
    if (a === '--confirm') args.confirm = true;
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
  }
  return args;
}

async function main() {
  const { confirm, date } = parseArgs(process.argv.slice(2));

  const { rows: picks } = await pool.query(
    `SELECT tp.id, tp.game_date, tp.mlb_game_id, tp.description, tp.result,
            g.home_team, g.away_team, g.home_starter_id, g.away_starter_id
     FROM tracked_picks tp
     LEFT JOIN games g ON g.game_date = tp.game_date AND g.mlb_game_id = tp.mlb_game_id
     WHERE tp.signal_type = 'moneyline'
       ${date ? 'AND tp.game_date = $1' : ''}
     ORDER BY tp.game_date, tp.id`,
    date ? [date] : []
  );

  console.log(`Checking ${picks.length} moneyline pick(s)${date ? ` for ${date}` : ' across all dates'} against the season-ERA rule...\n`);

  const bad = [];
  const unverifiable = [];
  let ok = 0;

  for (const p of picks) {
    if (!p.home_starter_id || !p.away_starter_id) {
      unverifiable.push({ ...p, why: 'game row or starters missing' });
      continue;
    }
    const { rows: eraRows } = await pool.query(
      `SELECT pitcher_id, season_era FROM pitcher_form
       WHERE game_date = $1 AND pitcher_id = ANY($2)`,
      [p.game_date, [p.home_starter_id, p.away_starter_id]]
    );
    const eraById = new Map(eraRows.map((r) => [r.pitcher_id, r.season_era !== null ? Number(r.season_era) : null]));
    const homeEra = eraById.get(p.home_starter_id) ?? null;
    const awayEra = eraById.get(p.away_starter_id) ?? null;

    if (homeEra === null || awayEra === null) {
      unverifiable.push({ ...p, why: 'no season ERA on file for that date' });
      continue;
    }

    const edge = awayEra - homeEra;
    if (edge >= ERA_EDGE_MIN) {
      ok++;
      continue;
    }
    bad.push({ ...p, homeEra, awayEra, edge });
  }

  console.log(`OK (real season-ERA edge): ${ok}`);
  console.log(`Unverifiable (left alone): ${unverifiable.length}`);
  for (const u of unverifiable) {
    console.log(`  #${u.id} ${u.game_date.toISOString?.().slice(0, 10) ?? u.game_date} ${u.home_team ?? '?'} vs ${u.away_team ?? '?'} - ${u.why}`);
  }

  console.log(`\nWrongly qualified under the old rule: ${bad.length}`);
  for (const b of bad) {
    const d = b.game_date.toISOString?.().slice(0, 10) ?? b.game_date;
    console.log(
      `  #${b.id} ${d} ${b.home_team} vs ${b.away_team} - home ${b.homeEra.toFixed(2)} ERA, away ${b.awayEra.toFixed(2)} ERA ` +
        `(edge ${b.edge.toFixed(2)}, needs ${ERA_EDGE_MIN}+), result=${b.result}`
    );
  }

  if (!bad.length) {
    console.log('\nNothing to remove.');
  } else if (!confirm) {
    console.log(`\nDry run only, nothing deleted. Re-run with --confirm to remove these ${bad.length} row(s).`);
  } else {
    const ids = bad.map((b) => b.id);
    await pool.query('DELETE FROM tracked_picks WHERE id = ANY($1)', [ids]);
    console.log(`\nDeleted ${ids.length} row(s): ${ids.join(', ')}`);
  }
}

main()
  .catch((err) => {
    console.error('Reconciliation failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

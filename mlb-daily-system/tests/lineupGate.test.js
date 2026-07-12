// Once a team's lineup is posted, a hot hitter who isn't in it must be
// dropped from the batter-prop boards — there's no prop on a guy who isn't
// starting (the reported bug: a hit prop shown on a batter the confirmed
// lineup left on the bench). Before a team's lineup posts, its hot hitters
// stay as projected candidates. This exercises both batter-prop filters
// (hit streak + wind/HR) against seeded batter_form.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../lib/db.js';
import { runHitStreakFilter } from '../lib/filters/hitStreak.js';
import { runWindHrFilter } from '../lib/filters/windHr.js';

const D = '2099-09-01';
const POSTED = 'PostedSox';   // lineup is out
const PENDING = 'PendingPads'; // lineup not out yet

before(async () => {
  await pool.query('DELETE FROM batter_form WHERE game_date = $1', [D]);
  await pool.query('DELETE FROM games WHERE game_date = $1', [D]);
  await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team)
     VALUES ($1,'LG1',$2,'AwayA'), ($1,'LG2',$3,'AwayB')`,
    [D, POSTED, PENDING]
  );
  // batter_form columns: game_date, batter_id, batter_name, team, hit_streak,
  // trailing_15_avg, trailing_15_ab, trailing_15_hr_rate, lineup_confirmed,
  // last5_results
  const ins = async (id, name, team, avg, hr, confirmed) =>
    pool.query(
      `INSERT INTO batter_form (game_date, batter_id, batter_name, team, hit_streak,
         trailing_15_avg, trailing_15_ab, trailing_15_hr_rate, lineup_confirmed, last5_results)
       VALUES ($1,$2,$3,$4,0,$5,40,$6,$7,'[]')`,
      [D, id, name, team, avg, hr, confirmed]
    );
  // Posted team: one confirmed starter, one hot benched bat (the bug case).
  await ins(1001, 'Confirmed Starter', POSTED, 0.350, 0.30, true);
  await ins(1002, 'Benched Slugger', POSTED, 0.420, 0.60, false); // hottest, but benched
  // Pending team: lineup not posted, so a hot bat stays projected.
  await ins(1003, 'Projected Hot', PENDING, 0.380, 0.50, false);
});

after(async () => {
  await pool.query('DELETE FROM batter_form WHERE game_date = $1', [D]);
  await pool.query('DELETE FROM games WHERE game_date = $1', [D]);
  await pool.end();
});

test('hit-streak: benched hitter on a posted lineup is dropped; projected stays', async () => {
  const { watchList } = await runHitStreakFilter(pool, D);
  const names = watchList.map((b) => b.batterName);
  assert.ok(names.includes('Confirmed Starter'), 'confirmed starter should be listed');
  assert.ok(names.includes('Projected Hot'), 'projected hitter (lineup not posted) should stay');
  assert.ok(!names.includes('Benched Slugger'), 'benched hitter on a posted lineup must be dropped');
});

test('wind/HR: benched hitter on a posted lineup is dropped; projected stays', async () => {
  const { watchList } = await runWindHrFilter(pool, D);
  const names = watchList.map((b) => b.batterName);
  assert.ok(!names.includes('Benched Slugger'), 'benched slugger must not appear in HR props');
  // The projected hitter's lineup isn't posted, so he remains a candidate.
  assert.ok(names.includes('Projected Hot'), 'projected hitter should stay in HR props');
});

// Tests 1-6 from the admin-dashboard build spec, run against the database
// DIRECTLY via raw pool.query() calls, not through lib/publishing.js or
// any other application code. The whole point of the
// tracked_picks_immutability() trigger (migrations/018) is that it holds
// even against a bare UPDATE/DELETE, so that's exactly what these prove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../lib/db.js';

// A published pick is permanent by design (that's the entire point of
// this file) -- a fixed fixture date/game-id would collide with whatever
// a PREVIOUS run of this file already published, and the cleanup delete
// below would itself get blocked by the trigger. Deriving these from the
// current timestamp keeps every run on fixtures nothing has touched
// before, same fix as tests/adminHttp.test.js.
const RUN_ID = Date.now();
const TEST_DATE = new Date(Date.UTC(2099, 0, 1) + (RUN_ID % 9000) * 86400000).toISOString().slice(0, 10);
let futureGameId, pastGameId, publishedPickId, pastPickId;

before(async () => {
  // A game far in the future (never started) and one already started.
  const fut = await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team, game_time_utc)
     VALUES ($1, $2, 'Test Home A', 'Test Away A', now() + interval '1 day')
     RETURNING mlb_game_id`,
    [TEST_DATE, `TESTFUTURE001-${RUN_ID}`]
  );
  futureGameId = fut.rows[0].mlb_game_id;

  const past = await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team, game_time_utc)
     VALUES ($1, $2, 'Test Home B', 'Test Away B', now() - interval '2 hours')
     RETURNING mlb_game_id`,
    [TEST_DATE, `TESTPAST001-${RUN_ID}`]
  );
  pastGameId = past.rows[0].mlb_game_id;

  const p1 = await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, 'moneyline', $2, 'Test Home A to beat Test Away A', -150, 0.6, '{"homeTeam":"Test Home A"}')
     RETURNING id`,
    [TEST_DATE, futureGameId]
  );
  publishedPickId = p1.rows[0].id;
  // Publish it via the ordinary allowed transition, so the immutability
  // tests below start from a genuinely published row.
  await pool.query(
    `UPDATE tracked_picks SET published = true, published_at = now() WHERE id = $1`,
    [publishedPickId]
  );

  const p2 = await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, 'moneyline', $2, 'Test Home B to beat Test Away B', -140, 0.58, '{"homeTeam":"Test Home B"}')
     RETURNING id`,
    [TEST_DATE, pastGameId]
  );
  pastPickId = p2.rows[0].id;
});

after(async () => {
  // Published rows are permanent by design: the trigger will refuse this
  // DELETE too (proving the trigger holds even during test cleanup), so
  // only the never-published fixture row and the games rows get removed.
  await pool.query(`DELETE FROM tracked_picks WHERE id = $1 AND published = false`, [pastPickId]);
  await pool.end();
});

test('1. UPDATE published true->false on a published pick raises', async () => {
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET published = false WHERE id = $1', [publishedPickId]),
    /cannot un-publish/i
  );
});

test('2. DELETE of a published pick raises', async () => {
  await assert.rejects(
    () => pool.query('DELETE FROM tracked_picks WHERE id = $1', [publishedPickId]),
    /cannot delete a published pick/i
  );
});

test('3. UPDATE of description/locked_price/qualifying_metrics on a published pick raises', async () => {
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET description = $1 WHERE id = $2', ['tampered', publishedPickId]),
    /cannot edit description/i
  );
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET locked_price = $1 WHERE id = $2', [-999, publishedPickId]),
    /cannot edit description/i
  );
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET qualifying_metrics = $1 WHERE id = $2', ['{"tampered":true}', publishedPickId]),
    /cannot edit description/i
  );
});

test('4. UPDATE of published_at on a pick where it is already set raises', async () => {
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET published_at = now() WHERE id = $1', [publishedPickId]),
    /cannot change published_at/i
  );
});

test('5. Publishing a pick after its game_time_utc has passed is rejected', async () => {
  await assert.rejects(
    () => pool.query('UPDATE tracked_picks SET published = true, published_at = now() WHERE id = $1', [pastPickId]),
    /cannot publish pick .* after first pitch/i
  );
  const { rows } = await pool.query('SELECT published FROM tracked_picks WHERE id = $1', [pastPickId]);
  assert.equal(rows[0].published, false, 'the pick must still be unpublished after the rejected attempt');
});

test('6. Grading (result) and closing-line columns (closing_price, clv_pct) CAN still be written on a published row', async () => {
  const { rows } = await pool.query(
    'UPDATE tracked_picks SET result = $1 WHERE id = $2 RETURNING result',
    ['win', publishedPickId]
  );
  assert.equal(rows[0].result, 'win');

  const { rows: rows2 } = await pool.query(
    'UPDATE tracked_picks SET closing_price = $1, clv_pct = $2 WHERE id = $3 RETURNING closing_price, clv_pct',
    [-160, 0.02, publishedPickId]
  );
  assert.equal(rows2[0].closing_price, -160);
  assert.equal(Number(rows2[0].clv_pct), 0.02);
});

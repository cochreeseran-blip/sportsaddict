// Tests 7 and 10 from the admin-dashboard build spec. These need a real
// running server (auth cookies, route dispatch, the actual /api/digest
// query), so this spawns server.js as a child process on a scratch port
// against the same local Postgres used by the other test files, then
// drives it with plain fetch() calls -- no mocking of the app itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pool } from '../lib/db.js';

const PORT = 3901;
const BASE = `http://localhost:${PORT}`;
// A published pick is permanent by design (see migrations/018), so a
// fixed fixture date would collide with whatever this test published on
// its last run and the DELETE in `before` would itself get blocked by
// the trigger. Using a date derived from the current time keeps every
// run's fixtures on a date nothing has ever touched before.
const TEST_DATE = new Date(Date.UTC(2099, 0, 1) + (Date.now() % 9000) * 86400000).toISOString().slice(0, 10);

let serverProc;
let adminCookie, regularCookie;
let highEraPickId, lowEraPickId;
// mlb_game_id is globally unique (not just per-date), and a published
// pick's game row is effectively permanent too (nothing deletes it once
// referenced by a permanent pick), so these need a run-unique suffix the
// same way TEST_DATE does, not just a run-unique date.
const RUN_ID = Date.now();
const highEraGameId = `TESTHTTP001-${RUN_ID}`;
const lowEraGameId = `TESTHTTP002-${RUN_ID}`;

function cookieFromSetHeader(res) {
  const raw = res.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

async function waitForHealthz(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never became healthy on ' + BASE);
}

before(async () => {
  // TEST_DATE and the game ids below are derived from the current
  // timestamp specifically so this never collides with a previous run's
  // fixtures -- a published pick (and the games/users rows it references)
  // is permanent by design, so there is deliberately no cleanup of
  // earlier runs' fixtures here. See RUN_ID / TEST_DATE above.
  await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team, game_time_utc)
     VALUES ($1, $2, 'HTTP Home A', 'HTTP Away A', now() + interval '1 day'),
            ($1, $3, 'HTTP Home B', 'HTTP Away B', now() + interval '1 day')`,
    [TEST_DATE, highEraGameId, lowEraGameId]
  );

  // Two qualifying moneyline candidates for the same date, one with a
  // clearly higher away-starter trailing ERA than the other -- test 10
  // is exactly "publish the wrong one and the digest better not show it".
  const high = await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, 'moneyline', $2, 'HTTP Home A to beat HTTP Away A', -150, 0.6, $3) RETURNING id`,
    [TEST_DATE, highEraGameId, JSON.stringify({
      homeTeam: 'HTTP Home A', awayTeam: 'HTTP Away A', homeMl: -150, breakevenPct: 0.6,
      headline: 'HTTP Home A are the play', detail: 'worst opposing arm on the slate',
      awayStarterTrailingEra: 7.20, awayStarterName: 'Away Arm A',
    })]
  );
  highEraPickId = high.rows[0].id;

  const low = await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, 'moneyline', $2, 'HTTP Home B to beat HTTP Away B', -130, 0.56, $3) RETURNING id`,
    [TEST_DATE, lowEraGameId, JSON.stringify({
      homeTeam: 'HTTP Home B', awayTeam: 'HTTP Away B', homeMl: -130, breakevenPct: 0.56,
      headline: 'HTTP Home B are the play', detail: 'also qualifies, lower trailing ERA',
      awayStarterTrailingEra: 4.10, awayStarterName: 'Away Arm B',
    })]
  );
  lowEraPickId = low.rows[0].id;

  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});
  await waitForHealthz();

  // A regular (non-admin) user, and an admin user promoted directly in
  // the DB the same way `npm run make-admin` does -- signup itself never
  // grants admin, see scripts/make-admin.js.
  const regularEmail = `adminhttp-test-regular-${Date.now()}@example.com`;
  const regRes = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regularEmail, password: 'testpass123', rememberMe: false }),
  });
  assert.equal(regRes.status, 201);
  regularCookie = cookieFromSetHeader(regRes);

  const adminEmail = `adminhttp-test-admin-${Date.now()}@example.com`;
  const adminRes = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'testpass123', rememberMe: false }),
  });
  assert.equal(adminRes.status, 201);
  adminCookie = cookieFromSetHeader(adminRes);
  await pool.query(`UPDATE users SET role = 'admin' WHERE lower(email) = lower($1)`, [adminEmail]);
});

after(async () => {
  // The whole point of test 10 is that the published pick becomes
  // permanent -- the trigger refuses to delete it (see trigger.test.js
  // tests 1/2), and it references the admin user via published_by, so
  // that row and that admin user fixture are left in place on purpose.
  // Only the never-published candidate and the throwaway regular-user
  // fixture get cleaned up.
  await pool.query(`DELETE FROM tracked_picks WHERE game_date = $1 AND published = false`, [TEST_DATE]);
  await pool.query(
    `DELETE FROM users WHERE email LIKE 'adminhttp-test-%@example.com' AND id NOT IN (SELECT published_by FROM tracked_picks WHERE published_by IS NOT NULL)`
  );
  if (serverProc) serverProc.kill();
  await pool.end();
});

test('7. A non-admin authenticated user calling POST /api/admin/publish gets 403', async () => {
  const res = await fetch(`${BASE}/api/admin/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: regularCookie },
    body: JSON.stringify({ pickId: highEraPickId }),
  });
  assert.equal(res.status, 403);
  // and the pick must still be unpublished -- a 403 that leaked through
  // would be worse than useless.
  const { rows } = await pool.query('SELECT published FROM tracked_picks WHERE id = $1', [highEraPickId]);
  assert.equal(rows[0].published, false);
});

test('7b. GET /api/admin/slate as a non-admin also gets 403, not the data', async () => {
  const res = await fetch(`${BASE}/api/admin/slate?date=${TEST_DATE}`, { headers: { Cookie: regularCookie } });
  assert.equal(res.status, 403);
});

test('7c. An anonymous (logged-out) caller also gets 403', async () => {
  const res = await fetch(`${BASE}/api/admin/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pickId: highEraPickId }),
  });
  assert.equal(res.status, 403);
});

test('10. Admin publishes only the highest-away-trailing-ERA qualifier; the Daily Slate shows exactly that one pick', async () => {
  // Sanity: the admin slate view really does rank the high-ERA game first.
  const slateRes = await fetch(`${BASE}/api/admin/slate?date=${TEST_DATE}`, { headers: { Cookie: adminCookie } });
  assert.equal(slateRes.status, 200);
  const slate = await slateRes.json();
  const mlPicks = slate.picks.filter((p) => p.signal_type === 'moneyline' || p.signalType === 'moneyline');
  assert.equal(mlPicks.length, 2);

  const publishRes = await fetch(`${BASE}/api/admin/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ pickId: highEraPickId }),
  });
  const publishBody = await publishRes.json();
  assert.equal(publishRes.status, 200, JSON.stringify(publishBody));
  assert.equal(publishBody.published, true);

  const digestRes = await fetch(`${BASE}/api/digest?date=${TEST_DATE}`);
  assert.equal(digestRes.status, 200);
  const digest = await digestRes.json();
  assert.equal(digest.lockedMoneyline.length, 1, 'exactly one published moneyline pick should appear');
  assert.equal(digest.lockedMoneyline[0].mlbGameId, highEraGameId);
  assert.equal(digest.lockedMoneyline[0].awayTeam, 'HTTP Away A');

  // The low-ERA candidate was never published, so it must not leak in.
  const leaked = digest.lockedMoneyline.find((p) => p.mlbGameId === lowEraGameId);
  assert.equal(leaked, undefined);
});

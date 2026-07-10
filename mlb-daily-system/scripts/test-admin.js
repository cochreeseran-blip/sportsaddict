import 'dotenv/config';
import http from 'node:http';
import pg from 'pg';
import { pool } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { verifyEmailCompliance } from '../lib/emailCompliance.js';
import { renderAdminEmail } from '../lib/adminEmail.js';

// Admin / publishing / tier test suite. Tests 1-5 (the immutability
// trigger) run against the database DIRECTLY through a raw pg client, not
// the app layer: if the trigger only holds when called through the API,
// it doesn't hold. Tests 6-10 exercise the app (grading writes, the HTTP
// authz path, the email compliance gate, tier access, and free-slate
// selection).
//
// LOCAL ONLY: refuses to run against a non-local DATABASE_URL.

const DBURL = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:\/]/.test(DBURL)) {
  console.error('REFUSING TO RUN: DATABASE_URL is not local. This suite mutates data and must only touch local Postgres.');
  process.exit(1);
}

const results = [];
function record(n, name, passed, detail) {
  results.push({ n, name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${n}. ${name}${detail ? `  — ${detail}` : ''}`);
}
async function expectRaise(client, sql, params, label) {
  try {
    await client.query(sql, params);
    return { raised: false };
  } catch (err) {
    return { raised: true, message: err.message };
  }
}

const TEST_DATE = '2099-07-15'; // far-future sentinel date, easy to clean up
let adminId, userId;
let gameFuturePk = 'TESTGAME_FUTURE', gamePastPk = 'TESTGAME_PAST';

async function cleanup() {
  // Delete test rows. Published test rows can't be deleted through the
  // app path or a normal DELETE (that's the whole point), so drop the
  // trigger's protection only for this targeted cleanup by disabling the
  // trigger inside a transaction, remove our sentinel rows, re-enable.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tracked_picks DISABLE TRIGGER USER');
    await c.query('DELETE FROM tracked_picks WHERE game_date = $1', [TEST_DATE]);
    await c.query('ALTER TABLE tracked_picks ENABLE TRIGGER USER');
    await c.query('DELETE FROM games WHERE game_date = $1', [TEST_DATE]);
    await c.query(`DELETE FROM email_sends WHERE admin_user_id IN (SELECT id FROM users WHERE email LIKE 'admintest+%@example.com')`);
    await c.query(`DELETE FROM users WHERE email LIKE 'admintest+%@example.com'`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function seed() {
  await cleanup();
  // Two games: one starting well in the future, one already started.
  const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team, game_time_utc, venue, home_ml, away_ml, home_starter_name, away_starter_name)
     VALUES ($1,$2,'Home A','Away A',$3,'Park',-140,120,'HP','AP'), ($1,$4,'Home B','Away B',$5,'Park',-150,130,'HP2','AP2')`,
    [TEST_DATE, gameFuturePk, future, gamePastPk, past]
  );

  const admin = await pool.query(
    `INSERT INTO users (email, username, avatar_seed, password_hash, role, tier, email_verified, marketing_opt_in)
     VALUES ('admintest+admin@example.com','admintest_admin',1,$1,'admin','member',true,true) RETURNING id`,
    [hashPassword('password123')]
  );
  adminId = admin.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, username, avatar_seed, password_hash, role, tier)
     VALUES ('admintest+user@example.com','admintest_user',2,$1,'user','free') RETURNING id`,
    [hashPassword('password123')]
  );
  userId = user.rows[0].id;
}

// Inserts an unpublished pick and returns its id.
async function insertPick(mlbGameId, { published = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1,'moneyline',$2,'Test pick',-140,0.583,$3) RETURNING id`,
    [TEST_DATE, mlbGameId, JSON.stringify({ homeTeam: 'Home A', awayTeam: 'Away A', headline: 'Home A to win', detail: 'test' })]
  );
  const id = rows[0].id;
  if (published) {
    await pool.query('UPDATE tracked_picks SET published = true WHERE id = $1', [id]);
  }
  return id;
}

// A minimal HTTP request helper for the authz test (test 7).
function httpRequest(port, method, path, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      Host: 'localhost',
    } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await seed();

  const raw = new pg.Client({ connectionString: DBURL });
  await raw.connect();

  // --- Tests 1-5: the immutability trigger, DIRECT to the database -------
  {
    const id = await insertPick(gameFuturePk, { published: true });
    const r = await expectRaise(raw, 'UPDATE tracked_picks SET published = false WHERE id = $1', [id]);
    record(1, 'UPDATE published true->false raises', r.raised, r.raised ? r.message.split('\n')[0] : 'no exception');
  }
  {
    const id = await insertPick(gameFuturePk, { published: true });
    const r = await expectRaise(raw, 'DELETE FROM tracked_picks WHERE id = $1', [id]);
    record(2, 'DELETE of a published row raises', r.raised, r.raised ? r.message.split('\n')[0] : 'no exception');
  }
  {
    const id = await insertPick(gameFuturePk, { published: true });
    const r1 = await expectRaise(raw, `UPDATE tracked_picks SET description = 'edited' WHERE id = $1`, [id]);
    const r2 = await expectRaise(raw, 'UPDATE tracked_picks SET locked_price = -999 WHERE id = $1', [id]);
    const r3 = await expectRaise(raw, `UPDATE tracked_picks SET qualifying_metrics = '{"x":1}' WHERE id = $1`, [id]);
    const all = r1.raised && r2.raised && r3.raised;
    record(3, 'UPDATE of description/locked_price/qualifying_metrics on published row raises', all,
      all ? 'all three rejected' : `description:${r1.raised} price:${r2.raised} metrics:${r3.raised}`);
  }
  {
    // published_at is set at publish time; changing it afterward must raise.
    const id = await insertPick(gameFuturePk, { published: true });
    const r = await expectRaise(raw, 'UPDATE tracked_picks SET published_at = now() + interval \'1 day\' WHERE id = $1', [id]);
    record(4, 'UPDATE of published_at once set raises', r.raised, r.raised ? r.message.split('\n')[0] : 'no exception');
  }
  {
    // Publishing a pick whose game already started must be rejected by the
    // trigger, even via a direct SQL UPDATE.
    const id = await insertPick(gamePastPk, { published: false });
    const r = await expectRaise(raw, 'UPDATE tracked_picks SET published = true WHERE id = $1', [id]);
    record(5, 'Publishing after game_time_utc has passed is rejected (DB trigger)', r.raised, r.raised ? r.message.split('\n')[0] : 'no exception');
  }

  // --- Test 6: grading CAN still write result and clv_pct on a published row
  {
    const id = await insertPick(gameFuturePk, { published: true });
    let ok = true, detail = '';
    try {
      await raw.query(`UPDATE tracked_picks SET result = 'win' WHERE id = $1`, [id]);
      await raw.query('UPDATE tracked_picks SET closing_price = -150, clv_pct = 0.03 WHERE id = $1', [id]);
      const { rows } = await raw.query('SELECT result, closing_price, clv_pct FROM tracked_picks WHERE id = $1', [id]);
      ok = rows[0].result === 'win' && rows[0].closing_price === -150 && Number(rows[0].clv_pct) === 0.03;
      detail = `result=${rows[0].result} closing=${rows[0].closing_price} clv=${rows[0].clv_pct}`;
    } catch (err) {
      ok = false; detail = err.message.split('\n')[0];
    }
    record(6, 'Grading can write result and clv_pct to a published row', ok, detail);
  }

  await raw.end();

  // --- Test 7: non-admin authenticated user -> POST /api/admin/publish 403
  {
    // Boot a throwaway server instance on a random port with the app's
    // real handler. Import server module? It self-starts on import, which
    // would bind PORT and run the pipeline. Instead we spin the real
    // server via a child-free approach: set PORT and import once.
    const port = 34600 + Math.floor(Math.random() * 400);
    process.env.PORT = String(port);
    process.env.ADMIN_HOST = '';
    process.env.APP_HOST = '';
    // Give the non-admin user a session row and hit the endpoint.
    const crypto = await import('node:crypto');
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + interval '1 day')`, [token, userId]);

    let srv;
    try {
      srv = await import(`../server.js?admin-test=${Date.now()}`);
      await new Promise((r) => setTimeout(r, 800)); // let it bind + kick off boot work
      const res = await httpRequest(port, 'POST', '/api/admin/publish', { cookie: `sf_session=${token}`, body: { pickId: 1 } });
      record(7, 'Non-admin authenticated POST /api/admin/publish returns 403', res.status === 403, `status ${res.status}`);
    } catch (err) {
      record(7, 'Non-admin authenticated POST /api/admin/publish returns 403', false, err.message);
    }
  }

  // --- Test 8: email send refuses when the unsubscribe link is missing ---
  {
    const postal = '123 Test St, Testville, TS 00000';
    const withLink = renderAdminEmail({ intro: 'hi', picks: [{ headline: 'h', detail: 'd' }], unsubscribeUrl: 'https://x/email/unsubscribe?token=abc', postalAddress: postal });
    const withoutLink = withLink.replace(/https:\/\/x\/email\/unsubscribe\?token=abc/g, '#');
    const good = verifyEmailCompliance(withLink, { unsubscribePath: '/email/unsubscribe', postalAddress: postal });
    const bad = verifyEmailCompliance(withoutLink, { unsubscribePath: '/email/unsubscribe', postalAddress: postal });
    const ok = good.ok === true && bad.ok === false && bad.missing.some((m) => m.includes('unsubscribe'));
    record(8, 'Email send refuses when the unsubscribe link is removed', ok,
      ok ? 'compliant email passes, tampered email blocked' : `good.ok=${good.ok} bad.ok=${bad.ok} missing=${bad.missing.join('|')}`);
  }

  // --- Test 9: PAYWALL_ENABLED=false, free-tier user reaches research ----
  {
    // researchAccess is defined in server.js and not exported; test the
    // documented behavior via the /api/digest response for a free user
    // while the paywall is off (the server we booted for test 7 has
    // PAYWALL_ENABLED unset => false).
    const crypto = await import('node:crypto');
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + interval '1 day')`, [token, userId]);
    const port = Number(process.env.PORT);
    try {
      const res = await httpRequest(port, 'GET', `/api/digest?date=${TEST_DATE}`, { cookie: `sf_session=${token}` });
      const parsed = JSON.parse(res.body);
      // research access true AND the research-only keys are present.
      const ok = res.status === 200 && parsed.access?.research === true && 'ledger' in parsed && 'hitStreak' in parsed;
      record(9, 'PAYWALL_ENABLED=false: free-tier user reaches every research surface', ok,
        `access.research=${parsed.access?.research} hasLedger=${'ledger' in parsed}`);
    } catch (err) {
      record(9, 'PAYWALL_ENABLED=false: free-tier user reaches every research surface', false, err.message);
    }
  }

  // --- Test 10: Daily Slate renders exactly one published moneyline pick,
  //             the highest away-starter trailing ERA -----------------------
  {
    // Publish two moneyline picks on the future game with different away
    // trailing ERAs; the free pick must be the worse arm (higher ERA).
    const mk = async (era) => {
      const { rows } = await pool.query(
        `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
         VALUES ($1,'moneyline',$2,$3,-140,0.583,$4) RETURNING id`,
        [TEST_DATE, gameFuturePk, `pick era ${era}`, JSON.stringify({ homeTeam: 'Home A', awayTeam: 'Away A', headline: `Home A (era ${era})`, detail: 'x', awayStarterTrailingEra: era, awayStarterTrailingStarts: 3 })]
      );
      await pool.query('UPDATE tracked_picks SET published = true WHERE id = $1', [rows[0].id]);
      return rows[0].id;
    };
    const lowId = await mk(6.2);
    const highId = await mk(9.8);
    const port = Number(process.env.PORT);
    try {
      // Anonymous digest still carries freeMoneyline (public surface).
      const res = await httpRequest(port, 'GET', `/api/digest?date=${TEST_DATE}`);
      const parsed = JSON.parse(res.body);
      const free = parsed.freeMoneyline;
      const ok = free && free.awayStarterTrailingEra === 9.8 && free.id === highId;
      record(10, 'Daily Slate free pick = the single published ML with the highest away trailing ERA', ok,
        free ? `chosen ERA ${free.awayStarterTrailingEra} (id ${free.id}); expected 9.8 (id ${highId})` : 'no freeMoneyline');
    } catch (err) {
      record(10, 'Daily Slate free pick = the single published ML with the highest away trailing ERA', false, err.message);
    }
    void lowId;
  }

  // --- Tests 11-13: host-based gating (the two-domain split) -------------
  // Boot a SECOND server instance with ADMIN_HOST/APP_HOST configured and
  // confirm: admin routes 404 on the customer host (undiscoverable), and
  // require an admin account (403) on the admin host.
  {
    const port2 = 34200 + Math.floor(Math.random() * 300);
    process.env.PORT = String(port2);
    process.env.ADMIN_HOST = 'slatefinder.lol';
    process.env.APP_HOST = 'slateaddict.com';
    const reqHost = (host, path, opts = {}) => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: port2, method: opts.method || 'GET', path, headers: { Host: host, ...(opts.cookie ? { Cookie: opts.cookie } : {}) } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.on('error', reject); r.end();
    });
    try {
      await import(`../server.js?host-test=${Date.now()}`);
      await new Promise((r) => setTimeout(r, 800));

      const custPage = await reqHost('slateaddict.com', '/admin');
      const custApi = await reqHost('slateaddict.com', '/api/admin/slate');
      record(11, 'Admin routes return 404 (not 403) on the customer host', custPage.status === 404 && custApi.status === 404,
        `/admin=${custPage.status} /api/admin/slate=${custApi.status}`);

      // Admin host, no session -> 403 (route exists, account required).
      const adminNoAuth = await reqHost('slatefinder.lol', '/api/admin/slate');
      record(12, 'Admin API requires an admin account on the admin host (403 without one)', adminNoAuth.status === 403, `status ${adminNoAuth.status}`);

      // Admin host, admin session -> 200.
      const crypto = await import('node:crypto');
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + interval '1 day')`, [token, adminId]);
      // Use today's date: the endpoint caps look-ahead at one day, so the
      // far-future sentinel would (correctly) 400 after passing auth.
      const todayStr = new Date().toISOString().slice(0, 10);
      const adminAuth = await reqHost('slatefinder.lol', `/api/admin/slate?date=${todayStr}`, { cookie: `sf_session=${token}` });
      record(13, 'Admin account on the admin host reaches the admin API (200)', adminAuth.status === 200, `status ${adminAuth.status}`);
    } catch (err) {
      record(11, 'Admin host-gating tests', false, err.message);
    }
  }

  // --- summary + cleanup ---
  await cleanup();
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} tests passed.`);
  await pool.end();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error('Test harness crashed:', err);
  try { await cleanup(); } catch { /* */ }
  await pool.end().catch(() => {});
  process.exit(1);
});

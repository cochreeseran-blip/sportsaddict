import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { runPipeline, todayIsoDate } from './lib/pipeline.js';
import * as mlb from './lib/sources/mlbStats.js';
import { createBet, listBets, settleBet, reopenBet, deleteBet, gradePendingBets } from './lib/bets.js';
import { listManualPicks, addManualPick, deleteManualPick } from './lib/manualPicks.js';
import { addSubscriber, unsubscribe, sendDailyNewsletter } from './lib/newsletter.js';
import { createUser, authenticate, createSession, destroySession, userForSession, parseCookies, sessionCookie, ensureAuthSchema } from './lib/auth.js';
import { ensureInsertSafety } from './lib/schemaGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway injects PORT dynamically — binding to a fixed port would fail.
const PORT = process.env.PORT || 3000;

// Which code is actually running. Railway sets RAILWAY_GIT_COMMIT_SHA on
// every deploy; surfaced in /api/status and the site footer so "did the
// deploy actually land?" is answerable at a glance.
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_SHA || 'dev').slice(0, 7);

// MLB teams usually don't post the actual starting lineup until 1-3 hours
// before that specific game's first pitch, and games are staggered all
// day, so no single fixed time catches everyone. Instead we run a few
// times a day: once in the morning for schedule/odds/pitcher data (which
// IS known well ahead of time), then twice more in the afternoon/evening
// as lineups trickle in. Defaults: 9am, 4pm, 7pm ET. Override with a
// comma-separated list of UTC hours, e.g. DIGEST_REFRESH_HOURS_UTC=13,20,23.
const REFRESH_HOURS_UTC = (process.env.DIGEST_REFRESH_HOURS_UTC || '13,20,23')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);

let isRefreshing = false;
let refreshStartedAt = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunWarnings = [];
let lastRunDate = null;

async function triggerPipelineRun(gameDate = todayIsoDate()) {
  if (isRefreshing) return { skipped: true };
  isRefreshing = true;
  refreshStartedAt = new Date();
  try {
    const result = await runPipeline(gameDate);
    lastRunAt = new Date();
    lastRunDate = gameDate;
    lastRunError = null;
    lastRunWarnings = result?.warnings || [];
  } catch (err) {
    console.error('Pipeline run failed:', err);
    lastRunError = err.message;
    lastRunWarnings = [];
  } finally {
    isRefreshing = false;
    refreshStartedAt = null;
  }
  return { skipped: false };
}

function msUntilNextRun(hourUtc) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

// Human-friendly ET label for a UTC hour, computed against today's actual
// date so it accounts for daylight saving automatically.
function etLabel(hourUtc) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(d);
}

function scheduleDailyRunAt(hourUtc) {
  const delay = msUntilNextRun(hourUtc);
  console.log(`Next scheduled pipeline run at ${hourUtc}:00 UTC (~${etLabel(hourUtc)} ET) in ${(delay / 3600000).toFixed(1)}h.`);
  setTimeout(async () => {
    await triggerPipelineRun();
    // Yesterday's games are final by any of these run times — settle
    // whatever auto-gradable bets are still pending.
    try {
      const { graded, checked } = await gradePendingBets(pool);
      if (checked) console.log(`Bets: auto-graded ${graded}/${checked} pending.`);
    } catch (err) {
      console.warn(`Bet grading pass failed: ${err.message}`);
    }
    // The earliest run of the day doubles as the newsletter send. No-op
    // until RESEND_API_KEY / NEWSLETTER_FROM are configured.
    if (hourUtc === Math.min(...REFRESH_HOURS_UTC)) {
      try {
        await sendDailyNewsletter(pool, todayIsoDate());
      } catch (err) {
        console.warn(`Newsletter send failed: ${err.message}`);
      }
    }
    scheduleDailyRunAt(hourUtc);
  }, delay);
}

function scheduleDailyRuns() {
  for (const hourUtc of REFRESH_HOURS_UTC) {
    scheduleDailyRunAt(hourUtc);
  }
}

// ---------------------------------------------------------------------------
// Tiny TTL cache for live MLB Stats API proxying. The slate/game endpoints
// are hit on every client navigation; without this each click would fan a
// request out to the free MLB API. Entries also serve stale data while a
// background refresh is in flight (simple: we just cache the promise).
const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = producer().catch((err) => {
    cache.delete(key); // don't cache failures
    throw err;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function shiftIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function listDigestDates() {
  const { rows } = await pool.query(
    'SELECT DISTINCT game_date FROM daily_digest ORDER BY game_date DESC LIMIT 30'
  );
  return rows.map((r) => r.game_date.toISOString().slice(0, 10));
}

async function loadDigest(gameDate) {
  const { rows } = await pool.query(
    'SELECT signal_type, details, created_at FROM daily_digest WHERE game_date = $1',
    [gameDate]
  );
  const byType = Object.fromEntries(rows.map((r) => [r.signal_type, r.details]));
  // Newest created_at across every signal for the date — lets the client
  // show "as of HH:MM" next to a signal so it's obvious whether what's on
  // screen is from the latest pipeline run or older/stale data, instead of
  // silently trusting an empty section is correct.
  const updatedAt = rows.length ? new Date(Math.max(...rows.map((r) => new Date(r.created_at).getTime()))) : null;
  return {
    updatedAt,
    topPicks: byType.top_picks?.picks || [],
    moneyline: byType.moneyline || { signal: 'SIT', picks: [] },
    hitStreak: byType.hit_streak || { watchList: [], highConfidence: [] },
    windHr: byType.wind_hr || { watchList: [], highConfidence: [], hrRateThreshold: null },
    strikeouts: byType.strikeouts || { watchList: [] },
    warnings: byType.warnings?.warnings || [],
  };
}

// Per-team lineup confirmation for a date, from what the pipeline saw:
// whether the lineup was confirmed and the first moment we saw it posted.
async function lineupStatusByTeam(gameDate) {
  const { rows } = await pool.query(
    `SELECT team,
            bool_or(lineup_confirmed) AS confirmed,
            min(lineup_confirmed_at) FILTER (WHERE lineup_confirmed) AS confirmed_at
     FROM batter_form
     WHERE game_date = $1
     GROUP BY team`,
    [gameDate]
  );
  return Object.fromEntries(
    rows.map((r) => [r.team, { confirmed: r.confirmed === true, confirmedAt: r.confirmed_at }])
  );
}

// One day of the interactive slate: live MLB schedule (statuses, scores,
// probables, lineups-posted flags) merged with our own pipeline knowledge
// (odds, wind, lineup confirmation timestamps) where we have it.
async function buildSlate(dateStr) {
  const [byDate, dbStatus, dbGames] = await Promise.all([
    cached(`sched:${dateStr}`, 3 * 60 * 1000, () => mlb.fetchScheduleRange(dateStr, dateStr)),
    lineupStatusByTeam(dateStr),
    pool.query(
      'SELECT mlb_game_id, home_ml, away_ml, wind_speed_mph, wind_blowing_out FROM games WHERE game_date = $1',
      [dateStr]
    ).then((r) => new Map(r.rows.map((g) => [g.mlb_game_id, g]))),
  ]);

  const games = (byDate[dateStr] || []).map((g) => {
    const db = dbGames.get(String(g.gamePk));
    const homeDb = dbStatus[g.home.name];
    const awayDb = dbStatus[g.away.name];
    return {
      ...g,
      homeMl: db?.home_ml ?? null,
      awayMl: db?.away_ml ?? null,
      windSpeedMph: db?.wind_speed_mph !== null && db?.wind_speed_mph !== undefined ? Number(db.wind_speed_mph) : null,
      windBlowingOut: db?.wind_blowing_out ?? null,
      lineups: {
        home: {
          posted: g.lineupsPosted.home || homeDb?.confirmed === true,
          confirmedAt: homeDb?.confirmedAt ?? null,
        },
        away: {
          posted: g.lineupsPosted.away || awayDb?.confirmed === true,
          confirmedAt: awayDb?.confirmedAt ?? null,
        },
      },
    };
  });
  return { date: dateStr, games };
}

// Game detail: boxscore lineups (order, jersey, position, day's line)
// merged with our stored batter form (streak, trailing avg/HR rate) and
// pitcher form for the probable starters.
async function buildGameDetail(gamePk, dateStr) {
  const lineups = await cached(`box:${gamePk}`, 2 * 60 * 1000, () => mlb.fetchBoxscoreLineups(gamePk));

  const [batterRows, pitcherRows, gameRow] = await Promise.all([
    pool.query(
      `SELECT batter_id, hit_streak, trailing_15_avg, trailing_15_hr_rate, last5_results,
              lineup_confirmed, lineup_confirmed_at, position, jersey_number
       FROM batter_form WHERE game_date = $1`,
      [dateStr]
    ),
    pool.query(
      'SELECT pitcher_id, pitcher_name, season_era, trailing_era, trailing_starts FROM pitcher_form WHERE game_date = $1',
      [dateStr]
    ),
    pool.query('SELECT * FROM games WHERE mlb_game_id = $1', [String(gamePk)]),
  ]);

  const formById = new Map(batterRows.rows.map((b) => [b.batter_id, b]));
  const pitcherById = new Map(pitcherRows.rows.map((p) => [p.pitcher_id, p]));
  const g = gameRow.rows[0] || null;

  const decorate = (side) => ({
    ...side,
    batters: side.batters.map((b) => {
      const f = formById.get(b.id);
      return {
        ...b,
        // Prefer live boxscore jersey/position; fall back to what the
        // pipeline stored from the roster earlier in the day.
        jerseyNumber: b.jerseyNumber ?? f?.jersey_number ?? null,
        position: b.position ?? f?.position ?? null,
        hitStreak: f?.hit_streak ?? null,
        trailing15Avg: f?.trailing_15_avg !== null && f?.trailing_15_avg !== undefined ? Number(f.trailing_15_avg) : null,
        trailing15HrRate: f?.trailing_15_hr_rate !== null && f?.trailing_15_hr_rate !== undefined ? Number(f.trailing_15_hr_rate) : null,
        last5Results: f?.last5_results ?? null,
      };
    }),
  });

  const starter = (id, name) => {
    const p = id != null ? pitcherById.get(id) : null;
    return {
      id: id ?? null,
      name: p?.pitcher_name ?? name ?? null,
      seasonEra: p?.season_era !== null && p?.season_era !== undefined ? Number(p.season_era) : null,
      trailingEra: p?.trailing_era !== null && p?.trailing_era !== undefined ? Number(p.trailing_era) : null,
      trailingStarts: p?.trailing_starts ?? null,
    };
  };

  return {
    gamePk: Number(gamePk),
    date: dateStr,
    venue: g?.venue ?? null,
    homeMl: g?.home_ml ?? null,
    awayMl: g?.away_ml ?? null,
    windSpeedMph: g?.wind_speed_mph !== null && g?.wind_speed_mph !== undefined ? Number(g.wind_speed_mph) : null,
    windBlowingOut: g?.wind_blowing_out ?? null,
    homeStarter: starter(g?.home_starter_id, g?.home_starter_name),
    awayStarter: starter(g?.away_starter_id, g?.away_starter_name),
    home: decorate(lineups.home),
    away: decorate(lineups.away),
  };
}

async function buildPerformance() {
  const [summary, recent] = await Promise.all([
    pool.query(`
      SELECT signal_type,
             count(*) FILTER (WHERE result IN ('win', 'loss')) AS graded,
             count(*) FILTER (WHERE result = 'win') AS wins,
             count(*) FILTER (WHERE result = 'loss') AS losses,
             count(*) FILTER (WHERE result = 'push') AS pushes,
             count(*) FILTER (WHERE result = 'pending') AS pending,
             avg(breakeven_pct) FILTER (WHERE result IN ('win', 'loss') AND breakeven_pct IS NOT NULL) AS avg_breakeven
      FROM tracked_picks
      GROUP BY signal_type
      ORDER BY signal_type
    `),
    pool.query(`
      SELECT game_date, signal_type, description, locked_price, breakeven_pct, result
      FROM tracked_picks
      ORDER BY game_date DESC, id DESC
      LIMIT 40
    `),
  ]);
  return {
    summary: summary.rows.map((r) => ({
      signalType: r.signal_type,
      graded: Number(r.graded),
      wins: Number(r.wins),
      losses: Number(r.losses),
      pushes: Number(r.pushes),
      pending: Number(r.pending),
      winRate: Number(r.graded) > 0 ? Number(r.wins) / Number(r.graded) : null,
      avgBreakeven: r.avg_breakeven !== null ? Number(r.avg_breakeven) : null,
    })),
    recent: recent.rows.map((r) => ({
      gameDate: r.game_date.toISOString().slice(0, 10),
      signalType: r.signal_type,
      description: r.description,
      lockedPrice: r.locked_price,
      breakevenPct: r.breakeven_pct !== null ? Number(r.breakeven_pct) : null,
      result: r.result,
    })),
  };
}

// ---------------------------------------------------------------------------
// Static assets: the SlateFinder single-page app. Whitelisted files only —
// no directory traversal surface.
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}


const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    const staticEntry = STATIC_FILES[url.pathname];
    if (staticEntry && req.method === 'GET') {
      const filePath = path.join(__dirname, 'web', staticEntry.file);
      res.writeHead(200, { 'Content-Type': staticEntry.type, 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(filePath));
      return;
    }

    if ((url.pathname === '/api/refresh' || url.pathname === '/refresh') && req.method === 'POST') {
      triggerPipelineRun(); // fire-and-forget; client polls /api/status
      sendJson(res, 202, { started: true });
      return;
    }

    // --- accounts ---------------------------------------------------------
    // The account gate lives in the frontend; the data API stays open so a
    // broken auth flow can never brick the research pages.
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      const { email, password, rememberMe } = await readJsonBody(req);
      const cleanEmail = String(email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return sendJson(res, 400, { error: 'That email does not look right.' });
      if (typeof password !== 'string' || password.length < 8) return sendJson(res, 400, { error: 'Password needs at least 8 characters.' });
      try {
        const user = await createUser(pool, cleanEmail, password);
        const token = await createSession(pool, user.id);
        res.setHeader('Set-Cookie', sessionCookie(token, req, { remember: rememberMe !== false }));
        sendJson(res, 201, { user });
      } catch (err) {
        if (err.code === '23505') return sendJson(res, 409, { error: 'That email already has an account. Log in instead.' });
        throw err;
      }
      return;
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const { email, password, rememberMe } = await readJsonBody(req);
      const user = await authenticate(pool, String(email || '').trim(), String(password || ''));
      if (!user) return sendJson(res, 401, { error: 'Wrong email or password.' });
      const token = await createSession(pool, user.id);
      res.setHeader('Set-Cookie', sessionCookie(token, req, { remember: rememberMe !== false }));
      sendJson(res, 200, { user });
      return;
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      await destroySession(pool, parseCookies(req).sf_session);
      res.setHeader('Set-Cookie', sessionCookie('', req, { clear: true }));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/auth/me') {
      const user = await userForSession(pool, parseCookies(req).sf_session);
      sendJson(res, 200, { user });
      return;
    }

    if (url.pathname === '/api/status' || url.pathname === '/status.json') {
      sendJson(res, 200, {
        isRefreshing,
        refreshStartedAt,
        lastRunAt,
        lastRunDate,
        lastRunError,
        lastRunWarnings,
        refreshHoursEt: REFRESH_HOURS_UTC.map(etLabel),
        today: todayIsoDate(),
        build: BUILD,
      });
      return;
    }

    if (url.pathname === '/api/digest') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      const [digest, availableDates, manualPicks] = await Promise.all([
        loadDigest(date),
        listDigestDates(),
        listManualPicks(pool, date),
      ]);
      sendJson(res, 200, { date, availableDates, ...digest, manualPicks });
      return;
    }

    if (url.pathname === '/api/slate') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      // Guardrail so the live proxy can't be used to crawl arbitrary
      // history — the app itself only navigates a +/- 15 day window.
      const today = todayIsoDate();
      if (date < shiftIso(today, -15) || date > shiftIso(today, 15)) {
        return sendJson(res, 400, { error: 'date outside the supported slate window' });
      }
      sendJson(res, 200, await buildSlate(date));
      return;
    }

    if (url.pathname === '/api/game') {
      const gamePk = url.searchParams.get('gamePk');
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!/^\d+$/.test(gamePk || '') || !ISO_DATE_RE.test(date)) {
        return sendJson(res, 400, { error: 'bad gamePk/date' });
      }
      sendJson(res, 200, await buildGameDetail(gamePk, date));
      return;
    }

    if (url.pathname === '/api/performance') {
      sendJson(res, 200, await buildPerformance());
      return;
    }

    // --- personal bet tracker ------------------------------------------
    if (url.pathname === '/api/bets' && req.method === 'GET') {
      sendJson(res, 200, await listBets(pool));
      return;
    }

    if (url.pathname === '/api/bets' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const stake = Number(b.stake);
      const description = String(b.description || '').trim();
      const gameDate = b.gameDate || todayIsoDate();
      if (!description || description.length > 300) return sendJson(res, 400, { error: 'Description is required.' });
      if (!Number.isFinite(stake) || stake <= 0 || stake > 1000000) return sendJson(res, 400, { error: 'Stake must be a positive number.' });
      if (!ISO_DATE_RE.test(gameDate)) return sendJson(res, 400, { error: 'bad date' });
      const odds = b.odds === null || b.odds === undefined || b.odds === '' ? null : Number(b.odds);
      if (odds !== null && (!Number.isInteger(odds) || Math.abs(odds) < 100 || Math.abs(odds) > 100000)) {
        return sendJson(res, 400, { error: 'Odds must be American style, e.g. -150 or +120.' });
      }
      const bet = await createBet(pool, {
        gameDate,
        description,
        odds,
        stake,
        book: b.book ? String(b.book).slice(0, 60) : null,
        betKind: b.betKind,
        mlbGameId: b.mlbGameId ? String(b.mlbGameId).slice(0, 20) : null,
        batterId: Number.isInteger(b.batterId) ? b.batterId : null,
      });
      sendJson(res, 201, bet);
      return;
    }

    if (url.pathname === '/api/bets/grade' && req.method === 'POST') {
      sendJson(res, 200, await gradePendingBets(pool));
      return;
    }

    const betAction = url.pathname.match(/^\/api\/bets\/(\d+)(?:\/(settle|reopen))?$/);
    if (betAction) {
      const id = Number(betAction[1]);
      if (betAction[2] === 'settle' && req.method === 'POST') {
        const { result } = await readJsonBody(req);
        const bet = await settleBet(pool, id, result);
        return bet ? sendJson(res, 200, bet) : sendJson(res, 404, { error: 'not found' });
      }
      if (betAction[2] === 'reopen' && req.method === 'POST') {
        const bet = await reopenBet(pool, id);
        return bet ? sendJson(res, 200, bet) : sendJson(res, 404, { error: 'not found' });
      }
      if (!betAction[2] && req.method === 'DELETE') {
        return (await deleteBet(pool, id))
          ? sendJson(res, 200, { deleted: true })
          : sendJson(res, 404, { error: 'not found' });
      }
    }

    // --- manual moneyline picks -------------------------------------------
    // A direct publish path for a pick you've researched yourself (e.g. in
    // a separate Claude project) without waiting on or depending on the
    // automated odds/schedule pipeline.
    if (url.pathname === '/api/manual-picks' && req.method === 'POST') {
      const b = await readJsonBody(req);
      const gameDate = b.gameDate || todayIsoDate();
      const homeTeam = String(b.homeTeam || '').trim();
      // Optional: the game matcher fills the opponent in from the slate.
      const awayTeam = String(b.awayTeam || '').trim() || 'TBD';
      const homeMl = Number(b.homeMl);
      if (!ISO_DATE_RE.test(gameDate)) return sendJson(res, 400, { error: 'bad date' });
      if (!homeTeam) return sendJson(res, 400, { error: 'Team is required.' });
      if (!Number.isInteger(homeMl) || Math.abs(homeMl) < 100 || Math.abs(homeMl) > 100000) {
        return sendJson(res, 400, { error: 'Odds must be American style, e.g. -150 or +120.' });
      }
      const reason = b.reason ? String(b.reason).trim().slice(0, 500) : null;
      const created = await addManualPick(pool, { gameDate, homeTeam, awayTeam, homeMl, reason });
      sendJson(res, 201, created);
      return;
    }

    if (url.pathname.match(/^\/api\/manual-picks\/\d+$/) && req.method === 'DELETE') {
      const id = Number(url.pathname.split('/').pop());
      await deleteManualPick(pool, id);
      sendJson(res, 200, { deleted: true });
      return;
    }

    // --- newsletter ------------------------------------------------------
    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const { email } = await readJsonBody(req);
      try {
        await addSubscriber(pool, email);
        sendJson(res, 200, { subscribed: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (url.pathname === '/unsubscribe') {
      const ok = await unsubscribe(pool, url.searchParams.get('token') || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#101216;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:24px"><p style="font-size:16px;font-weight:600">${ok ? "You're unsubscribed." : 'That link has already been used or is invalid.'}</p>
        <p style="color:#9ba3b0;font-size:13px">${ok ? 'No more daily emails. You can re-subscribe on the site any time.' : ''}</p>
        <p><a href="/" style="color:#5b9cff;font-size:13px">Back to Slatefinder</a></p></div></body>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Request failed:', err);
    sendJson(res, 500, { error: err.message });
  }
});

async function start() {
  await runMigrations(pool);
  // Never trust migration-file state for auth: re-assert the users/sessions
  // schema (incl. avatar_seed) on every boot. Idempotent and fast.
  await ensureAuthSchema(pool);
  // And guard every table we insert into against legacy NOT NULL columns
  // left behind by older apps sharing this database (see lib/schemaGuard.js).
  await ensureInsertSafety(pool);

  // Bind the port immediately so Railway's healthcheck passes right away —
  // don't make first boot wait on a full pipeline run (batter form alone
  // can take ~a minute against ~400 hitters).
  server.listen(PORT, () => {
    console.log(`SlateFinder listening on :${PORT}`);
  });

  triggerPipelineRun(); // fire-and-forget initial populate
  scheduleDailyRuns();
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

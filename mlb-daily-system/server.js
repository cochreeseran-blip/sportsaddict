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
import { unsubscribeAccount, sendDailyNewsletter } from './lib/newsletter.js';
import {
  createUser, authenticate, createSession, destroySession, userForSession, touchLastSeen,
  parseCookies, sessionCookie, ensureAuthSchema,
} from './lib/auth.js';
import { listMessages, postMessage } from './lib/chat.js';
import { ensureInsertSafety } from './lib/schemaGuard.js';
import { gradePendingPicks } from './lib/trackedPicks.js';
import { requireAdmin } from './lib/adminAuth.js';
import { listAlgorithmPicks, publishPick } from './lib/publishing.js';
import { buildDualRecord, MIN_GRADED_FOR_RATE } from './lib/record.js';
import { applyTierGate } from './lib/tierGate.js';
import { pullClosingLines } from './lib/closingLine.js';
import {
  marketingAudience, marketingAudienceCount, audienceToCsv, publishedPicksForDate,
  sendAdminEmail, unsubscribeMarketing,
} from './lib/adminEmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway injects PORT dynamically, binding to a fixed port would fail.
const PORT = process.env.PORT || 3000;

// Which code is actually running. Railway sets RAILWAY_GIT_COMMIT_SHA on
// every deploy; surfaced in /api/status and the site footer so "did the
// deploy actually land?" is answerable at a glance.
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_SHA || 'dev').slice(0, 7);

// The daily research email still goes out once a day, after this hour.
// There's no more "go-live"/freeze tied to this — publishing is now a
// manual admin decision (see /admin/slate), not something that happens
// automatically at a clock time, so this constant now controls exactly
// one thing: when the automated research digest fires.
const NEWSLETTER_HOUR_UTC = Number(process.env.NEWSLETTER_HOUR_UTC || 13); // 13 UTC = 9am ET

// The Odds API free tier is 500 requests/month. Odds get fetched at most
// TWICE a day, on a clock, full stop:
//   1. MORNING_ODDS_HOUR_UTC: the day's opening line, feeds the moneyline
//      screen for the rest of the day. Default 10 UTC = 6am ET, well
//      before a typical 9am-ish review — "leaving real review time
//      before anything publishes" is now mostly automatic anyway, since
//      NOTHING auto-publishes anymore, but an early, fully-populated
//      board still matters for the admin actually having something
//      worth reviewing that early.
//   2. CLOSING_LINE_HOUR_UTC: one pull near typical evening first pitches
//      for closing-line value on published picks (see lib/closingLine.js).
//      This is a once-a-day approximation, not per-game-precise — MLB
//      games start anywhere from early afternoon to 10pm ET, and a
//      twice-a-day budget doesn't allow chasing each one individually.
//      Default 23 UTC = 7pm ET/6pm EDT, mid-pack for a typical slate.
// Every hourly run in between passes fetchOdds:false to runPipeline and
// never touches the Odds API, see the fetchOdds note on runPipeline.
const MORNING_ODDS_HOUR_UTC = Number(process.env.MORNING_ODDS_HOUR_UTC || 10);
const CLOSING_LINE_HOUR_UTC = Number(process.env.CLOSING_LINE_HOUR_UTC || 23);

let isRefreshing = false;
let refreshStartedAt = null;
let lastRunAt = null;
let lastRunError = null;
let lastRunWarnings = [];
let lastRunDate = null;

async function triggerPipelineRun(gameDate = todayIsoDate(), { fetchOdds = false } = {}) {
  if (isRefreshing) return { skipped: true };
  isRefreshing = true;
  refreshStartedAt = new Date();
  try {
    const result = await runPipeline(gameDate, { fetchOdds });
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

// Top of every hour: the full MLB-Stats-only sync (schedule, pitcher/
// batter form, lineups, Savant, the moneyline screen re-evaluated against
// whatever price is already on file). fetchOdds is true only at
// MORNING_ODDS_HOUR_UTC, see the budget note above. The research
// newsletter fires once a day, after the NEWSLETTER_HOUR_UTC run.
function scheduleHourlyRuns() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0));
  const delay = next - now;
  console.log(`Next hourly pipeline run in ${(delay / 60000).toFixed(0)}m.`);
  setTimeout(async () => {
    const hourUtc = new Date().getUTCHours();
    await triggerPipelineRun(todayIsoDate(), { fetchOdds: hourUtc === MORNING_ODDS_HOUR_UTC });
    try {
      const { graded, checked } = await gradePendingBets(pool);
      if (checked) console.log(`Bets: auto-graded ${graded}/${checked} pending.`);
    } catch (err) {
      console.warn(`Bet grading pass failed: ${err.message}`);
    }
    // No-op until RESEND_API_KEY / NEWSLETTER_FROM are configured.
    if (hourUtc === NEWSLETTER_HOUR_UTC) {
      try {
        await sendDailyNewsletter(pool, todayIsoDate());
      } catch (err) {
        console.warn(`Newsletter send failed: ${err.message}`);
      }
    }
    if (hourUtc === CLOSING_LINE_HOUR_UTC) {
      try {
        const r = await pullClosingLines(pool, todayIsoDate());
        console.log(`Closing line: ${JSON.stringify(r)}`);
      } catch (err) {
        console.warn(`Closing line pull failed: ${err.message}`);
      }
    }
    scheduleHourlyRuns();
  }, delay);
}

// Between pipeline runs, keep the record moving: every 10 minutes grade
// whatever tracked picks and bets have gone final, so a call flips to W/L
// shortly after the game ends instead of at the next hourly sync. This
// never touches the Odds API (see gradePendingPicks / mlb.fetchGameResult,
// both MLB-Stats-only), so it isn't part of the twice-a-day odds budget.
function startGradingLoop() {
  setInterval(async () => {
    try {
      await gradePendingPicks(pool);
      await gradePendingBets(pool);
    } catch (err) {
      console.warn(`Grading loop: ${err.message}`);
    }
  }, 10 * 60 * 1000);
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
  // Newest created_at across every signal for the date, lets the client
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
  const [lineups, live] = await Promise.all([
    cached(`box:${gamePk}`, 2 * 60 * 1000, () => mlb.fetchBoxscoreLineups(gamePk)),
    // At-bat marker data. Short cache so the baseball moves batter to
    // batter; best-effort because a Preview game has no linescore worth
    // showing and the panel must never fail over a marker.
    cached(`line:${gamePk}`, 25 * 1000, () => mlb.fetchLinescore(gamePk)).catch(() => null),
  ]);

  const [batterRows, pitcherRows, gameRow] = await Promise.all([
    pool.query(
      `SELECT batter_id, hit_streak, trailing_15_avg, trailing_15_ab, trailing_15_hr_rate, last5_results,
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
        trailing15Ab: f?.trailing_15_ab ?? 0,
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
    live,
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
      WHERE published = true
      GROUP BY signal_type
      ORDER BY signal_type
    `),
    pool.query(`
      SELECT game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, result
      FROM tracked_picks
      WHERE published = true
      ORDER BY game_date DESC, id DESC
      LIMIT 100
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
      mlbGameId: r.mlb_game_id,
      description: r.description,
      lockedPrice: r.locked_price,
      breakevenPct: r.breakeven_pct !== null ? Number(r.breakeven_pct) : null,
      result: r.result,
    })),
  };
}

// ---------------------------------------------------------------------------
// Static assets: the SlateFinder single-page app. Whitelisted files only -
// no directory traversal surface. admin.html/admin.js are NOT in this map:
// they're gated by an admin-session check, see the /admin route below,
// not served as a plain static file to anyone who asks.
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/admin.js': { file: 'admin.js', type: 'text/javascript; charset=utf-8' },
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Security helpers.

// Per-IP sliding-window rate limiter for the abuse-prone endpoints (login
// brute force, signup spam, publish/send spam). In-memory is fine for a
// single Railway instance; entries expire as they age out of the window.
const rateBuckets = new Map();
function rateLimited(req, key, maxHits, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(bucketKey, hits);
  if (rateBuckets.size > 10000) {
    // Cheap global cleanup so the map can't grow unbounded.
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
    }
  }
  return hits.length > maxHits;
}

// Mutating endpoints (bets, refresh) require a logged-in session, without
// this, anyone on the internet could delete bets or force a refresh.
// Read-only research data stays public. Touches last_seen_at (throttled
// server-side to 1/hr, see lib/auth.js) so every authenticated call also
// counts as activity for the admin Users panel, not just page loads.
async function requireUser(req, res) {
  const user = await userForSession(pool, parseCookies(req).sf_session);
  if (!user) {
    sendJson(res, 401, { error: 'Log in to do that.' });
    return null;
  }
  touchLastSeen(pool, user.id).catch(() => {});
  return user;
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

// ---------------------------------------------------------------------------
// /record: the dual public track record, server-rendered (not part of the
// SPA bundle) since it's meant to be a shareable, self-contained trust
// page. See lib/record.js for what ALGORITHM vs PUBLISHED means and why
// both are shown, always, unfiltered.
function fmtPct(n) {
  return n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`;
}
function recordBlockHtml(title, blurb, s) {
  const rateLine = s.sampleTooSmall
    ? `<span class="rec-note">(sample too small for a rate, ${s.graded}/${MIN_GRADED_FOR_RATE} graded)</span>`
    : `<span class="rec-rate">${fmtPct(s.winRate)} win rate</span>`;
  return `
    <div class="rec-block">
      <h2>${title}</h2>
      <p class="rec-blurb">${blurb}</p>
      <div class="rec-line"><b>${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ''}</b> ${rateLine}</div>
      <div class="rec-meta">${s.graded} graded &middot; ${s.pending} pending${s.avgRequiredBreakeven !== null ? ` &middot; avg required win rate to break even: ${fmtPct(s.avgRequiredBreakeven)}` : ''}</div>
    </div>`;
}
function renderRecordPage(record) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Slatefinder — Track Record</title>
  <style>
    body{margin:0;padding:32px 16px 60px;background:#101216;color:#e7e9ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
    .wrap{max-width:640px;margin:0 auto}
    h1{font-size:22px;margin:0 0 6px}
    .sub{color:#9ba3b0;font-size:13px;margin:0 0 28px;line-height:1.5}
    .rec-block{background:#16181d;border:1px solid #262a32;border-radius:10px;padding:20px 22px;margin-bottom:16px}
    .rec-block h2{font-size:15px;margin:0 0 6px}
    .rec-blurb{color:#9ba3b0;font-size:12.5px;margin:0 0 14px;line-height:1.5}
    .rec-line{font-size:20px;margin-bottom:6px}
    .rec-rate{color:#5b9cff;font-size:14px;margin-left:8px}
    .rec-note{color:#6b7380;font-size:12.5px;margin-left:8px}
    .rec-meta{color:#6b7380;font-size:12px}
    .disclaim{color:#6b7380;font-size:11.5px;margin-top:24px;line-height:1.6}
    a{color:#5b9cff}
  </style></head><body><div class="wrap">
    <h1>Track Record</h1>
    <p class="sub">Two records, both always visible, neither one hidden or pruned. This is the whole point of the product.</p>
    ${recordBlockHtml('Picks I actually called', 'Only the moneyline picks an admin chose to publish. This is what Slatefinder actually told people to bet.', record.published)}
    ${recordBlockHtml('Every pick the screener generated, including ones I passed on', 'Every moneyline the algorithm flagged as qualifying, published or not. This is the only honest way to check whether the filter itself works, independent of editorial judgment.', record.algorithm)}
    <p class="disclaim">Research signals only, not betting advice. Win rates below a ${MIN_GRADED_FOR_RATE}-pick sample are shown as raw win-loss with no percentage, a small sample isn't a real rate. <a href="/">Back to Slatefinder</a></p>
  </div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Baseline security headers on every response. The CSP allows exactly
    // what the app uses: self-hosted assets, MLB's logo/headshot CDNs,
    // Google Fonts, and same-origin fetches.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data: https://www.mlbstatic.com https://img.mlbstatic.com; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );

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

    // --- admin dashboard shell ---------------------------------------------
    // Not linked from anywhere in the public UI. Gated server-side same as
    // every /api/admin/* route: a non-admin (or logged-out visitor) gets a
    // plain 403, not the page, not a redirect to login.
    if (url.pathname === '/admin' && req.method === 'GET') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(__dirname, 'web', 'admin.html')));
      return;
    }

    if ((url.pathname === '/api/refresh' || url.pathname === '/refresh') && req.method === 'POST') {
      if (!(await requireUser(req, res))) return;
      if (rateLimited(req, 'refresh', 6, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Slow down, refresh is already running on a schedule.' });
      // A manual click is a deliberate, infrequent human action (rate-
      // limited above), not the unbounded hourly loop the odds budget is
      // protecting against, so this is allowed to pull fresh odds.
      triggerPipelineRun(todayIsoDate(), { fetchOdds: true }); // fire-and-forget; client polls /api/status
      sendJson(res, 202, { started: true });
      return;
    }

    // --- accounts ---------------------------------------------------------
    // The account gate lives in the frontend; the data API stays open so a
    // broken auth flow can never brick the research pages.
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      if (rateLimited(req, 'signup', 10, 60 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many signups from this address, try again later.' });
      const { email, password, rememberMe, marketingOptIn } = await readJsonBody(req);
      const cleanEmail = String(email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return sendJson(res, 400, { error: 'That email does not look right.' });
      if (typeof password !== 'string' || password.length < 8) return sendJson(res, 400, { error: 'Password needs at least 8 characters.' });
      try {
        // marketingOptIn defaults false unless the signup form's checkbox
        // was explicitly checked, see web/index.html's #authMarketing.
        const user = await createUser(pool, cleanEmail, password, marketingOptIn === true);
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
      if (rateLimited(req, 'login', 20, 15 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many login attempts, wait a few minutes and try again.' });
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
      if (user) touchLastSeen(pool, user.id).catch(() => {});
      sendJson(res, 200, { user });
      return;
    }

    // --- live chat --------------------------------------------------------
    if (url.pathname === '/api/chat' && req.method === 'GET') {
      const sinceId = Number(url.searchParams.get('since') || 0) || 0;
      const messages = await listMessages(pool, sinceId);
      sendJson(res, 200, { messages });
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const user = await requireUser(req, res);
      if (!user) return;
      if (rateLimited(req, 'chat', 30, 60 * 1000)) return sendJson(res, 429, { error: 'Easy on the spam. Give it a second.' });
      const { body } = await readJsonBody(req);
      try {
        const message = await postMessage(pool, user, body);
        sendJson(res, 201, { message });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
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
        today: todayIsoDate(),
        build: BUILD,
      });
      return;
    }

    if (url.pathname === '/api/digest') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      const viewer = await userForSession(pool, parseCookies(req).sf_session);
      const [digest, availableDates, lockedMoneyline] = await Promise.all([
        loadDigest(date),
        listDigestDates(),
        // The Daily Slate's Moneyline Board renders from THIS: only rows
        // an admin has actually PUBLISHED (see lib/publishing.js), not
        // the live re-screen and not every algorithm candidate. This is
        // the free-tier surface's "exactly one published moneyline pick"
        // — the query doesn't hardcode a LIMIT 1 (an admin could in
        // principle publish more than one; the UI just doesn't encourage
        // it), it shows whatever is actually published for the date.
        pool.query(
          `SELECT mlb_game_id, locked_price, breakeven_pct, qualifying_metrics, result
           FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline' AND published = true
           ORDER BY published_at`,
          [date]
        ).then((r) => r.rows.map((p) => {
          const m = p.qualifying_metrics || {};
          return {
            mlbGameId: p.mlb_game_id,
            homeTeam: m.homeTeam ?? null,
            awayTeam: m.awayTeam ?? null,
            homeMl: m.homeMl ?? p.locked_price,
            breakevenPct: m.breakevenPct ?? (p.breakeven_pct !== null ? Number(p.breakeven_pct) : null),
            headline: m.headline ?? null,
            detail: m.detail ?? null,
            grade: m.grade ?? null,
            gradeScore: m.gradeScore ?? null,
            gradeReasons: m.gradeReasons ?? [],
            homeStarterName: m.homeStarterName ?? null,
            homeStarterSeasonEra: m.homeStarterSeasonEra ?? null,
            awayStarterName: m.awayStarterName ?? null,
            awayStarterSeasonEra: m.awayStarterSeasonEra ?? null,
            seasonEraEdge: m.seasonEraEdge ?? null,
            result: p.result,
          };
        })),
      ]);
      sendJson(res, 200, { date, availableDates, ...applyTierGate(digest, viewer), lockedMoneyline });
      return;
    }

    if (url.pathname === '/api/slate') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      // Guardrail so the live proxy can't be used to crawl arbitrary
      // history, the app itself only navigates a +/- 15 day window.
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

    // Grades Slatefinder's own tracked picks against final MLB results,
    // same idea as the periodic pipeline refresh but on demand.
    if (url.pathname === '/api/tracked-picks/grade' && req.method === 'POST') {
      if (!(await requireUser(req, res))) return;
      if (rateLimited(req, 'tracked-picks-grade', 10, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: 'Slow down, try again in a bit.' });
      }
      sendJson(res, 200, await gradePendingPicks(pool));
      return;
    }

    // --- public track record ------------------------------------------
    if (url.pathname === '/api/record') {
      sendJson(res, 200, await buildDualRecord(pool));
      return;
    }
    if (url.pathname === '/record' && req.method === 'GET') {
      const record = await buildDualRecord(pool);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(renderRecordPage(record));
      return;
    }

    // --- personal bet tracker ------------------------------------------
    if (url.pathname === '/api/bets' && req.method === 'GET') {
      sendJson(res, 200, await listBets(pool));
      return;
    }

    if (url.pathname === '/api/bets' && req.method === 'POST') {
      if (!(await requireUser(req, res))) return;
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
      if (!(await requireUser(req, res))) return;
      sendJson(res, 200, await gradePendingBets(pool));
      return;
    }

    const betAction = url.pathname.match(/^\/api\/bets\/(\d+)(?:\/(settle|reopen))?$/);
    if (betAction) {
      if (!(await requireUser(req, res))) return;
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

    // --- admin: slate review + publish ------------------------------------
    if (url.pathname === '/api/admin/slate' && req.method === 'GET') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      sendJson(res, 200, { date, picks: await listAlgorithmPicks(pool, date) });
      return;
    }

    if (url.pathname === '/api/admin/publish' && req.method === 'POST') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      if (rateLimited(req, 'admin-publish', 30, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Slow down.' });
      const { pickId } = await readJsonBody(req);
      if (!Number.isInteger(pickId)) return sendJson(res, 400, { error: 'pickId is required.' });
      try {
        const row = await publishPick(pool, pickId, admin.id);
        sendJson(res, 200, { published: true, ...row });
      } catch (err) {
        // Trigger rejections (already published, game started) and the
        // app-level "no such pick" all land here as a 409: the request
        // was well-formed, the state just won't allow it.
        sendJson(res, 409, { error: err.message });
      }
      return;
    }

    // --- admin: users panel -------------------------------------------
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      const [totalRow, activeRow, sparkRows] = await Promise.all([
        pool.query('SELECT count(*)::int AS n FROM users'),
        pool.query(`SELECT count(*)::int AS n FROM users WHERE last_seen_at > now() - interval '7 days'`),
        pool.query(`
          SELECT to_char(d.day, 'YYYY-MM-DD') AS date, count(u.id)::int AS signups
          FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d(day)
          LEFT JOIN users u ON u.created_at::date = d.day
          GROUP BY d.day ORDER BY d.day
        `),
      ]);
      sendJson(res, 200, {
        totalUsers: totalRow.rows[0].n,
        activeLast7Days: activeRow.rows[0].n,
        signupsLast30Days: sparkRows.rows,
      });
      return;
    }

    // --- admin: email panel --------------------------------------------
    if (url.pathname === '/api/admin/email/audience-count' && req.method === 'GET') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      sendJson(res, 200, { count: await marketingAudienceCount(pool) });
      return;
    }

    // CSV export as a file download from a POST, per spec: never GET, never
    // in a URL/query string, so an email address can't end up in access
    // logs, browser history, or a shared link the way a GET would risk.
    if (url.pathname === '/api/admin/email/export' && req.method === 'POST') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      const rows = await marketingAudience(pool);
      const csv = audienceToCsv(rows);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="slatefinder-marketing-audience-${todayIsoDate()}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv);
      return;
    }

    if (url.pathname === '/api/admin/email/published-picks' && req.method === 'GET') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      sendJson(res, 200, { picks: await publishedPicksForDate(pool, date) });
      return;
    }

    if (url.pathname === '/api/admin/email/send' && req.method === 'POST') {
      const admin = await requireAdmin(pool, req, res, sendJson);
      if (!admin) return;
      if (rateLimited(req, 'admin-email-send', 10, 60 * 60 * 1000)) return sendJson(res, 429, { error: 'Slow down.' });
      const { gameDate, pickIds, intro, subject } = await readJsonBody(req);
      const date = gameDate || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      try {
        const result = await sendAdminEmail(pool, {
          adminUserId: admin.id,
          gameDate: date,
          pickIds: Array.isArray(pickIds) ? pickIds : [],
          intro: String(intro || '').slice(0, 4000),
          subject: subject ? String(subject).slice(0, 200) : null,
        });
        sendJson(res, 200, result);
      } catch (err) {
        // Compliance-footer failures, unpublished-pick selection, no
        // configured Resend key, no audience — all real, all 400s, none
        // of them silently swallowed or downgraded to a "best effort" send.
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    // --- newsletter unsubscribe (from the daily research digest) --------
    if (url.pathname === '/unsubscribe') {
      const ok = await unsubscribeAccount(pool, url.searchParams.get('token') || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#101216;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:24px"><p style="font-size:16px;font-weight:600">${ok ? "You're unsubscribed." : 'That link has already been used or is invalid.'}</p>
        <p style="color:#9ba3b0;font-size:13px">${ok ? "No more daily emails. Your account still works, this only turns off the morning digest." : ''}</p>
        <p><a href="/" style="color:#5b9cff;font-size:13px">Back to Slatefinder</a></p></div></body>`);
      return;
    }

    // --- marketing-list unsubscribe (from an admin-composed send) -------
    // Deliberately separate from /unsubscribe above: this only clears
    // marketing_opt_in, the daily research digest keeps sending unless
    // that's separately turned off. No login required — a signed,
    // expiring token in the URL is the whole auth, see lib/emailCompliance.js.
    if (url.pathname === '/unsubscribe-marketing') {
      const ok = await unsubscribeMarketing(pool, url.searchParams.get('token') || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#101216;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:24px"><p style="font-size:16px;font-weight:600">${ok ? "You're unsubscribed." : 'That link has expired or is invalid.'}</p>
        <p style="color:#9ba3b0;font-size:13px">${ok ? "You won't get any more emails from this list." : ''}</p>
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

  // Bind the port immediately so Railway's healthcheck passes right away -
  // don't make first boot wait on a full pipeline run (batter form alone
  // can take ~a minute against ~400 hitters).
  server.listen(PORT, () => {
    console.log(`SlateFinder listening on :${PORT}`);
  });

  // Boot-time populate. Doesn't fetch odds (see the budget note above) —
  // whatever the server picks up at whatever hour it happens to (re)start
  // isn't one of the two scheduled odds slots, and a restart shouldn't be
  // able to spend odds-API budget just by happening.
  triggerPipelineRun(todayIsoDate(), { fetchOdds: false });
  scheduleHourlyRuns();
  startGradingLoop();
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

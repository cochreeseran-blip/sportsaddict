import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { todayIsoDate } from './lib/pipeline.js';
import * as mlb from './lib/sources/mlbStats.js';
import { createBet, listBets, settleBet, reopenBet, deleteBet, gradePendingBets } from './lib/bets.js';
import { unsubscribeAccount } from './lib/newsletter.js';
import { createUser, authenticate, createSession, destroySession, userForSession, parseCookies, sessionCookie, ensureAuthSchema } from './lib/auth.js';
import { listMessages, postMessage } from './lib/chat.js';
import { ensureInsertSafety } from './lib/schemaGuard.js';
import { gradePendingPicks, publishPick } from './lib/trackedPicks.js';
import { renderAdminEmail, sendAdminEmail, marketingRecipients, loadPublishedPicks, marketingUnsubscribe } from './lib/adminEmail.js';
import { verifyUnsubscribeToken, makeUnsubscribeToken } from './lib/emailTokens.js';
import { readSystemStatus, requestRefresh } from './lib/systemStatus.js';
import { buildDashboardData } from './lib/dashboard/api.js';
import { liveMonitorSnapshot } from './lib/dashboard/live.js';
import { buildPerformanceBreakdown } from './lib/performance.js';

// This is the WEB app only: it serves slatefinder.lol (admin/finder) and
// slateaddict.com (customer), and the JSON API. It does NOT run the
// research pipeline - that's the engine (worker.js), a separate service
// sharing this same database. The web app reads what the engine writes
// (system_status for /api/status; the ledger, digests, and slate for
// everything else) and signals the engine for a manual refresh.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway injects PORT dynamically, binding to a fixed port would fail.
const PORT = process.env.PORT || 3000;

// Which code is actually running. Railway sets RAILWAY_GIT_COMMIT_SHA on
// every deploy; surfaced in /api/status and the site footer so "did the
// deploy actually land?" is answerable at a glance.
const BUILD = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.BUILD_SHA || 'dev').slice(0, 7);

// Content tiers: structured now, gated later. While false, every
// authenticated user sees everything regardless of tier; flipping this
// env var on is what makes users.tier ('free' | 'member') take effect.
const PAYWALL_ENABLED = String(process.env.PAYWALL_ENABLED || '').toLowerCase() === 'true';

// Two same-origin apps on two hosts, NOT cross-origin: no shared session,
// no shared cookie, each host is its own app.
//   ADMIN_HOST (slatefinder.lol) - the admin surface, my account only.
//   APP_HOST   (slateaddict.com) - the customer app.
// Gating is by the request's Host header. On the admin host, /admin* and
// /api/admin/* are served (and still require an admin account). On the
// customer host those routes return 404, not 403, so their existence
// isn't even discoverable there. For local dev there's only one host, so
// when neither env var is configured we fall back to "this one host is
// both" and let the path decide - that's the only way to exercise both
// surfaces on http://localhost. Set ADMIN_HOST / APP_HOST locally (e.g.
// via /etc/hosts + these vars) to simulate the real split.
const ADMIN_HOST = (process.env.ADMIN_HOST || '').trim().toLowerCase();
const APP_HOST = (process.env.APP_HOST || '').trim().toLowerCase();
const HOSTS_CONFIGURED = Boolean(ADMIN_HOST || APP_HOST);

function hostname(req) {
  return String(req.headers.host || '').split(':')[0].trim().toLowerCase();
}

// Is this request allowed to see the admin surface AT ALL (before any
// account check)? On a configured deployment: only on ADMIN_HOST. In
// single-host local dev (no ADMIN_HOST/APP_HOST set): yes, so both
// surfaces are reachable for testing. When only APP_HOST is set, the
// customer host is explicitly known and anything else is treated as the
// admin host.
function isAdminHost(req) {
  if (!HOSTS_CONFIGURED) return true; // local dev, one host serves both
  const h = hostname(req);
  if (ADMIN_HOST) return h === ADMIN_HOST;
  return h !== APP_HOST; // APP_HOST set alone: everything else is admin
}

// Is this the customer app host? Mirror image of isAdminHost. In local
// dev both are true (one host is both apps).
function isAppHost(req) {
  if (!HOSTS_CONFIGURED) return true;
  const h = hostname(req);
  if (APP_HOST) return h === APP_HOST;
  return h !== ADMIN_HOST;
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

// ---------------------------------------------------------------------------
// The dual public record: the trust surface. Two records, both always
// visible, both graded the same way:
//   ALGORITHM - every pick the pipeline generated (published or not)
//   PUBLISHED - only the picks an admin chose to put on the record
// For each: W-L, and where a locked price exists, actual win rate
// against average required break-even. The win PERCENTAGE is suppressed
// until a record has 50+ graded (win/loss) picks; raw W-L always shows.
const MIN_GRADED_FOR_RATE = 50;

function shapeRecord(row) {
  const wins = Number(row.wins);
  const losses = Number(row.losses);
  const graded = wins + losses;
  return {
    wins,
    losses,
    pushes: Number(row.pushes),
    pending: Number(row.pending),
    graded,
    // null = suppressed. Every surface renders "(sample too small for a
    // rate)" when null and graded > 0.
    winRate: graded >= MIN_GRADED_FOR_RATE ? wins / graded : null,
    rateSuppressed: graded > 0 && graded < MIN_GRADED_FOR_RATE,
    minGradedForRate: MIN_GRADED_FOR_RATE,
    // Priced subset only: you can't compare a win rate to a break-even
    // requirement on picks that never had a price.
    pricedGraded: Number(row.priced_graded),
    pricedWins: Number(row.priced_wins),
    pricedWinRate: Number(row.priced_graded) >= MIN_GRADED_FOR_RATE ? Number(row.priced_wins) / Number(row.priced_graded) : null,
    avgBreakeven: row.avg_breakeven !== null ? Number(row.avg_breakeven) : null,
  };
}

async function buildRecord() {
  const recordQuery = (publishedOnly) => pool.query(`
    SELECT
      count(*) FILTER (WHERE result = 'win') AS wins,
      count(*) FILTER (WHERE result = 'loss') AS losses,
      count(*) FILTER (WHERE result = 'push') AS pushes,
      count(*) FILTER (WHERE result = 'pending') AS pending,
      count(*) FILTER (WHERE result IN ('win','loss') AND locked_price IS NOT NULL) AS priced_graded,
      count(*) FILTER (WHERE result = 'win' AND locked_price IS NOT NULL) AS priced_wins,
      avg(breakeven_pct) FILTER (WHERE result IN ('win','loss') AND locked_price IS NOT NULL) AS avg_breakeven
    FROM tracked_picks
    ${publishedOnly ? 'WHERE published = true' : ''}
  `);

  const [algo, pub, publishedPicks] = await Promise.all([
    recordQuery(false),
    recordQuery(true),
    // The complete published record, every pick ever put on the public
    // record: wins, losses, graded and pending, all-time. Deliberately
    // NOT paginated or filtered - the whole point is that nothing on it
    // can quietly disappear.
    pool.query(`
      SELECT id, game_date, signal_type, description, locked_price, breakeven_pct,
             closing_price, clv_pct, result, published_at
      FROM tracked_picks
      WHERE published = true
      ORDER BY game_date DESC, published_at DESC, id DESC
    `),
  ]);

  return {
    algorithm: {
      label: 'Every pick the screener generated, including ones I passed on.',
      ...shapeRecord(algo.rows[0]),
    },
    published: {
      label: 'Picks I actually called.',
      ...shapeRecord(pub.rows[0]),
      picks: publishedPicks.rows.map((r) => ({
        id: r.id,
        gameDate: r.game_date.toISOString().slice(0, 10),
        signalType: r.signal_type,
        description: r.description,
        lockedPrice: r.locked_price,
        breakevenPct: r.breakeven_pct !== null ? Number(r.breakeven_pct) : null,
        closingPrice: r.closing_price,
        clvPct: r.clv_pct !== null ? Number(r.clv_pct) : null,
        result: r.result,
        publishedAt: r.published_at,
      })),
    },
  };
}

// The Daily Slate strip: the record over EVERY automated pick in the
// ledger, published or not (that's the real all-time W-L — the screener's
// full track record, e.g. 10-4 — not just the curated published subset,
// which starts empty). Same 50-graded suppression as everywhere else.
async function buildPerformance() {
  const [summary, recent] = await Promise.all([
    pool.query(`
      SELECT
        count(*) FILTER (WHERE result = 'win') AS wins,
        count(*) FILTER (WHERE result = 'loss') AS losses,
        count(*) FILTER (WHERE result = 'push') AS pushes,
        count(*) FILTER (WHERE result = 'pending') AS pending,
        count(*) FILTER (WHERE result IN ('win','loss') AND locked_price IS NOT NULL) AS priced_graded,
        count(*) FILTER (WHERE result = 'win' AND locked_price IS NOT NULL) AS priced_wins,
        avg(breakeven_pct) FILTER (WHERE result IN ('win','loss') AND locked_price IS NOT NULL) AS avg_breakeven
      FROM tracked_picks
    `),
    pool.query(`
      SELECT game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, result
      FROM tracked_picks
      ORDER BY game_date DESC, id DESC
      LIMIT 100
    `),
  ]);
  return {
    record: shapeRecord(summary.rows[0]),
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
// Tracked-picks ledger reads for the public digest and the admin slate.

function shapeLedgerPick(p) {
  const m = p.qualifying_metrics || {};
  return {
    id: p.id,
    signalType: p.signal_type,
    mlbGameId: p.mlb_game_id,
    homeTeam: m.homeTeam ?? null,
    awayTeam: m.awayTeam ?? null,
    homeMl: m.homeMl ?? p.locked_price,
    breakevenPct: m.breakevenPct ?? (p.breakeven_pct !== null ? Number(p.breakeven_pct) : null),
    headline: m.headline ?? null,
    detail: m.detail ?? null,
    batterName: m.batterName ?? null,
    batterId: m.batterId ?? null,
    pitcherName: m.pitcherName ?? null,
    pitcherId: m.pitcherId ?? null,
    team: m.team ?? null,
    trailing15Avg: m.trailing15Avg ?? null,
    trailing15Ab: m.trailing15Ab ?? null,
    lineupConfirmed: m.lineupConfirmed ?? null,
    suggestedLine: m.suggestedLine ?? null,
    strictFloorKs: m.strictFloorKs ?? null,
    kPerStart: m.kPerStart ?? null,
    awayStarterName: m.awayStarterName ?? null,
    awayStarterTrailingEra: m.awayStarterTrailingEra ?? null,
    awayStarterTrailingStarts: m.awayStarterTrailingStarts ?? null,
    awayStarterSeasonEra: m.awayStarterSeasonEra ?? null,
    // Grade + reasons: what the pick was scored, and why, frozen at pick
    // time so a card rebuilt from the ledger years later says exactly what
    // it said the morning it was made.
    grade: m.grade ?? null,
    gradeScore: m.score ?? null,
    gradeReasons: m.gradeReasons ?? [],
    // Hit projection (both tiers, see lib/hitProjection.js).
    expectedHits: m.expectedHits ?? null,
    expectedAtBats: m.expectedAtBats ?? null,
    pAtLeastOne: m.pAtLeastOne ?? null,
    pAtLeastTwo: m.pAtLeastTwo ?? null,
    multiHitRate: m.multiHitRate ?? null,
    battingOrderSlot: m.battingOrderSlot ?? null,
    xba: m.xba ?? null,
    xbaLuckFlag: m.xbaLuckFlag ?? null,
    opposingStarterName: m.opposingStarterName ?? null,
    opposingHitsPer9: m.opposingHitsPer9 ?? null,
    // Home run inputs.
    barrelPct: m.barrelPct ?? null,
    avgExitVelo: m.avgExitVelo ?? null,
    hardHitPct: m.hardHitPct ?? null,
    xslg: m.xslg ?? null,
    trailing15HrRate: m.trailing15HrRate ?? null,
    opposingHrPer9: m.opposingHrPer9 ?? null,
    windBlowingOut: m.windBlowingOut ?? null,
    windSpeedMph: m.windSpeedMph ?? null,
    venue: m.venue ?? null,
    result: p.result,
    published: p.published,
    publishedAt: p.published_at,
  };
}

async function ledgerForDate(date) {
  const { rows } = await pool.query(
    `SELECT id, signal_type, mlb_game_id, description, locked_price, breakeven_pct,
            closing_price, clv_pct, qualifying_metrics, result, published, published_at, published_by, created_at, is_free_pick
     FROM tracked_picks WHERE game_date = $1 ORDER BY signal_type, id`,
    [date]
  );
  return rows;
}

// The one free moneyline pick of the day: among PUBLISHED picks, the
// qualifying game whose away starter has the highest trailing ERA - the
// worst opposing arm, which is the thesis of the bet. Not a score, not a
// grade.
function pickFreeMoneyline(ledgerRows) {
  const published = ledgerRows
    .filter((p) => p.signal_type === 'moneyline' && p.published)
    .map(shapeLedgerPick)
    .sort((a, b) => (b.awayStarterTrailingEra ?? 0) - (a.awayStarterTrailingEra ?? 0));
  return published[0] ?? null;
}

// The free tier's one full pick of the day: the highest-scoring published
// pick on the board, whatever signal it came from. A prop wins a tie over
// a moneyline, because the props are what the product is actually for and
// a free reader should see the thing worth paying for, not the side dish.
//
// Deliberately the BEST pick rather than a random or a deliberately weak
// one. A free tier that shows its worst work is a bad advertisement and a
// dishonest sample of the record it is asking to be judged on.
const FEATURED_TIEBREAK = { multi_hit: 3, home_run: 3, strikeout: 3, hit_streak: 2, moneyline: 1 };

function pickFeatured(ledgerRows) {
  const publishedRows = ledgerRows.filter((p) => p.published);
  if (!publishedRows.length) return null;

  // The owner's explicit choice wins. Auto-selection is only the default
  // for a slate nobody curated -- picking the highest score is a decent
  // guess, but which pick makes the best advertisement is an editorial
  // call the person running the book should get to make.
  const chosen = publishedRows.find((p) => p.is_free_pick);
  if (chosen) return { ...shapeLedgerPick(chosen), freePickChosenBy: 'owner' };

  const published = publishedRows.map(shapeLedgerPick);
  published.sort((a, b) => {
    const rank = (FEATURED_TIEBREAK[b.signalType] ?? 0) - (FEATURED_TIEBREAK[a.signalType] ?? 0);
    if (rank !== 0) return rank;
    return (b.gradeScore ?? 0) - (a.gradeScore ?? 0);
  });
  return { ...published[0], freePickChosenBy: 'auto' };
}

// A published pick with everything actionable removed. This is what a
// free reader gets for the picks they have not paid for: proof the pick
// exists and how it graded, never who it is on.
//
// The stripping happens HERE, on the server, before the JSON is written.
// Nothing actionable is serialised and then hidden with CSS -- a paywall
// you can defeat with devtools is not a paywall.
function lockedStub(p) {
  return {
    id: p.id,
    signalType: p.signalType,
    locked: true,
    grade: p.grade,
    // Safe once the game is over, and it is the honest part: the reader
    // watches the locked board win or lose in public before deciding.
    result: p.result,
    published: true,
  };
}

// ---------------------------------------------------------------------------
// Static assets: the Slate Addict single-page app. Whitelisted files only -
// no directory traversal surface. /record and /how serve the same SPA (it
// reads location.pathname and opens the matching view), so those routes
// are shareable links rather than client-only state; the admin bundle is
// served separately and only to admins.
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/record': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/how': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  // Shared by both surfaces: design tokens and the player-media helpers
  // (headshots, team logos, colours). Public because the customer app
  // needs them; they contain no picks and no account data.
  '/media.js': { file: 'media.js', type: 'text/javascript; charset=utf-8' },
  '/tokens.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  // Legacy path: older cached HTML may still ask for this. Serves the
  // token sheet so a stale page renders readable rather than unstyled.
  '/styles.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Security helpers.

const rateBuckets = new Map();
function rateLimited(req, key, maxHits, windowMs) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const hits = (rateBuckets.get(bucketKey) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  rateBuckets.set(bucketKey, hits);
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k);
    }
  }
  return hits.length > maxHits;
}

// Mutating endpoints require a logged-in session. Read-only research
// data stays public.
async function requireUser(req, res) {
  const user = await userForSession(pool, parseCookies(req).sf_session);
  if (!user) {
    sendJson(res, 401, { error: 'Log in to do that.' });
    return null;
  }
  return user;
}

// Admin gate for every /admin page and /api/admin/* endpoint. The role
// is re-read from the users table on THIS request (session -> users join
// in userForSession, then an explicit fresh SELECT here), never taken
// from a client flag or a token claim minted earlier - a demotion takes
// effect on the very next request. A logged-in non-admin gets a plain
// 403, not a redirect; so does an anonymous request, which also avoids
// confirming the route exists to people probing for it.
async function requireAdmin(req, res) {
  const user = await userForSession(pool, parseCookies(req).sf_session);
  if (!user) {
    sendJson(res, 403, { error: 'Forbidden.' });
    return null;
  }
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [user.id]);
  if (rows[0]?.role !== 'admin') {
    sendJson(res, 403, { error: 'Forbidden.' });
    return null;
  }
  return user;
}

// Tier access. While PAYWALL_ENABLED is false everything is open to any
// authenticated (or anonymous) reader; when it flips on, research
// surfaces require member tier (admins always see everything).
function researchAccess(user) {
  if (!PAYWALL_ENABLED) return true;
  return user?.role === 'admin' || user?.tier === 'member';
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
// Admin endpoint implementations.

// The admin slate review: every pick the pipeline generated for the
// date, published and unpublished, with the qualifying metrics that
// produced each one, game start times, lineup state, and change flags
// (starter swapped since the pick locked, batter no longer in a
// confirmed lineup). Moneyline picks come back sorted worst-away-arm
// first; the first row is the one the free slate gets if published.
async function buildAdminSlate(date) {
  const [ledger, gamesRes, battersRes] = await Promise.all([
    ledgerForDate(date),
    pool.query(
      `SELECT mlb_game_id, home_team, away_team, game_time_utc,
              home_starter_name, away_starter_name
       FROM games WHERE game_date = $1`,
      [date]
    ),
    pool.query(
      `SELECT batter_id, batter_name, team, lineup_confirmed FROM batter_form WHERE game_date = $1`,
      [date]
    ),
  ]);

  const gameById = new Map(gamesRes.rows.map((g) => [g.mlb_game_id, g]));
  const batterById = new Map(battersRes.rows.map((b) => [b.batter_id, b]));
  const lineupByTeam = await lineupStatusByTeam(date);

  const picks = ledger.map((row) => {
    const p = shapeLedgerPick(row);
    const game = gameById.get(row.mlb_game_id);
    const m = row.qualifying_metrics || {};

    const warnings = [];
    let lineupConfirmed = null;
    // Every batter signal shares the same lineup risk: a pick on someone
    // who turns out not to be starting is dead, whichever prop it is.
    if (p.signalType === 'hit_streak' || p.signalType === 'multi_hit' || p.signalType === 'home_run') {
      const team = m.team;
      lineupConfirmed = lineupByTeam[team]?.confirmed === true;
      if (!lineupConfirmed) {
        warnings.push('Lineup not posted yet. Batter props are unreliable until the lineup is out.');
      } else {
        const nowRow = m.batterId ? batterById.get(m.batterId) : null;
        if (nowRow && nowRow.lineup_confirmed !== true) {
          warnings.push(`OUT OF LINEUP: ${m.batterName} is not in the confirmed ${team} lineup.`);
        }
      }
    }
    if (p.signalType === 'moneyline' && game) {
      if (m.awayStarterName && game.away_starter_name && m.awayStarterName !== game.away_starter_name) {
        warnings.push(`STARTER CHANGED: pick locked against ${m.awayStarterName}, current away probable is ${game.away_starter_name}.`);
      }
      if (m.homeStarterName && game.home_starter_name && m.homeStarterName !== game.home_starter_name) {
        warnings.push(`STARTER CHANGED: home probable was ${m.homeStarterName}, now ${game.home_starter_name}.`);
      }
    }
    if (p.signalType === 'strikeout' && game) {
      const current = [game.home_starter_name, game.away_starter_name];
      if (m.pitcherName && !current.includes(m.pitcherName)) {
        warnings.push(`STARTER CHANGED: ${m.pitcherName} is no longer a probable starter in this game.`);
      }
    }

    const gameTime = game?.game_time_utc ?? null;
    return {
      ...p,
      lockedPrice: row.locked_price,
      closingPrice: row.closing_price,
      clvPct: row.clv_pct !== null ? Number(row.clv_pct) : null,
      description: row.description,
      createdAt: row.created_at,
      gameTimeUtc: gameTime,
      gameStarted: gameTime ? Date.now() >= new Date(gameTime).getTime() : null,
      lineupConfirmed,
      warnings,
    };
  });

  const bySignal = { moneyline: [], strikeout: [], multi_hit: [], hit_streak: [], home_run: [], other: [] };
  for (const p of picks) {
    (bySignal[p.signalType] || bySignal.other).push(p);
  }
  // Within each prop board, best first by the metric that board is
  // actually ranked on, matching what the filters produced.
  bySignal.multi_hit.sort((a, b) => (b.pAtLeastTwo ?? 0) - (a.pAtLeastTwo ?? 0));
  bySignal.hit_streak.sort((a, b) => (b.pAtLeastOne ?? 0) - (a.pAtLeastOne ?? 0));
  bySignal.home_run.sort((a, b) => (b.gradeScore ?? 0) - (a.gradeScore ?? 0));
  bySignal.strikeout.sort((a, b) => (b.gradeScore ?? 0) - (a.gradeScore ?? 0));
  // Worst away arm first - the top row is the free-slate pick.
  bySignal.moneyline.sort((a, b) => (b.awayStarterTrailingEra ?? 0) - (a.awayStarterTrailingEra ?? 0));

  return {
    date,
    picks: bySignal,
    freePickId: bySignal.moneyline.find((p) => p.published)?.id ?? null,
    lineupsByTeam: lineupByTeam,
  };
}

async function buildAdminUsers() {
  const [totals, sparkline] = await Promise.all([
    pool.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS active_7d
      FROM users
    `),
    pool.query(`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             count(u.id)::int AS signups
      FROM generate_series(now()::date - 29, now()::date, '1 day') d
      LEFT JOIN users u ON u.created_at::date = d::date
      GROUP BY d::date ORDER BY d::date
    `),
  ]);
  return {
    totalUsers: totals.rows[0].total,
    activeUsers7d: totals.rows[0].active_7d,
    signupsLast30Days: sparkline.rows,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

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

    const onAdminHost = isAdminHost(req);

    // --- admin surface (admin host only) -----------------------------------
    // Every /admin* page, /admin.js, /api/admin/*, and /api/dashboard*
    // endpoint exists ONLY on the admin host. On the customer host these
    // route patterns are not matched at all, so the request falls through
    // to the final 404: the routes aren't just forbidden there, they're
    // undiscoverable. On the admin host they additionally require an admin
    // account (403 otherwise). The Phase 1 research dashboard (/api/dashboard*)
    // is admin-only private research, not a customer-facing surface.
    const isAdminRoute = /^\/admin(\/(slate|users|email))?$/.test(url.pathname)
      || url.pathname === '/admin.js'
      || url.pathname === '/finder.css'
      || url.pathname.startsWith('/api/admin/')
      || url.pathname.startsWith('/api/dashboard');

    if (isAdminRoute && !onAdminHost) {
      // Customer host: pretend the admin surface does not exist.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    if (onAdminHost && /^\/admin(\/(slate|users|email))?$/.test(url.pathname) && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'web', 'admin.html')));
      return;
    }
    // The Finder's own bundle and stylesheet. Both admin-gated: the
    // stylesheet leaks nothing sensitive, but there is no reason for the
    // customer host to serve the private terminal's design either.
    if (onAdminHost && (url.pathname === '/admin.js' || url.pathname === '/finder.css') && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const isCss = url.pathname === '/finder.css';
      res.writeHead(200, {
        'Content-Type': isCss ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(fs.readFileSync(path.join(__dirname, 'web', isCss ? 'finder.css' : 'admin.js')));
      return;
    }

    // --- Phase 1 research dashboard (admin-only, private) -------------------
    // Data endpoint: the full slate + all three signal tabs for one date.
    // Same auth as every other admin surface (requireAdmin), served from
    // the existing /admin shell's "Research" tab, not a separate page.
    if (onAdminHost && url.pathname === '/api/dashboard' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      try {
        const data = await buildDashboardData(pool, date);
        sendJson(res, 200, data);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // Live monitor: Server-Sent Events, one snapshot line every 60s while
    // the connection is open. SSE over WebSocket per the spec -- simpler,
    // one-way is all this needs, and it works through Railway's proxy with
    // no special configuration.
    if (onAdminHost && url.pathname === '/api/dashboard/live' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let closed = false;
      req.on('close', () => { closed = true; clearInterval(timer); });
      const tick = async () => {
        if (closed) return;
        try {
          const snapshot = await liveMonitorSnapshot(pool, date);
          res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        } catch (err) {
          // Don't kill the stream over one bad tick, just skip it.
          console.warn(`  Live monitor tick failed: ${err.message}`);
        }
      };
      await tick();
      const timer = setInterval(tick, 60000);
      return;
    }

    // Root of a CONFIGURED admin host lands on the admin dashboard, not
    // the customer app (slatefinder.lol is admin-only). In single-host
    // local dev, '/' stays the customer app and /admin is used explicitly,
    // so both surfaces are testable on http://localhost.
    if (HOSTS_CONFIGURED && onAdminHost && url.pathname === '/' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'web', 'admin.html')));
      return;
    }

    const staticEntry = STATIC_FILES[url.pathname];
    if (staticEntry && req.method === 'GET') {
      const filePath = path.join(__dirname, 'web', staticEntry.file);
      res.writeHead(200, { 'Content-Type': staticEntry.type, 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(filePath));
      return;
    }

    // --- admin API (admin host only; guarded above) ------------------------
    if (url.pathname.startsWith('/api/admin/')) {
      const admin = await requireAdmin(req, res);
      if (!admin) return;

      if (url.pathname === '/api/admin/slate' && req.method === 'GET') {
        const date = url.searchParams.get('date') || todayIsoDate();
        if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
        // Review window: back through the ledger's history, ahead one
        // day (tomorrow's board populates once the pipeline sees it).
        if (date > shiftIso(todayIsoDate(), 1)) return sendJson(res, 400, { error: 'can only look ahead one day' });
        sendJson(res, 200, await buildAdminSlate(date));
        return;
      }

      if (url.pathname === '/api/admin/publish' && req.method === 'POST') {
        const { pickId } = await readJsonBody(req);
        if (!Number.isInteger(pickId)) return sendJson(res, 400, { error: 'pickId required' });
        const result = await publishPick(pool, pickId, admin.id);
        if (!result.ok) return sendJson(res, 409, { error: result.error });
        sendJson(res, 200, result.pick);
        return;
      }

      // Designate the day's free pick. Clearing the previous one and
      // setting the new one happen in a single transaction: the partial
      // unique index (one free pick per game_date) would otherwise reject
      // the second write while the first was still in place.
      if (url.pathname === '/api/admin/free-pick' && req.method === 'POST') {
        const { pickId } = await readJsonBody(req);
        if (!Number.isInteger(pickId)) return sendJson(res, 400, { error: 'pickId required' });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            'SELECT id, game_date, published FROM tracked_picks WHERE id = $1 FOR UPDATE', [pickId]);
          const pick = rows[0];
          if (!pick) {
            await client.query('ROLLBACK');
            return sendJson(res, 404, { error: 'No such pick.' });
          }
          if (!pick.published) {
            await client.query('ROLLBACK');
            return sendJson(res, 409, { error: 'Only a published pick can be the free pick.' });
          }
          await client.query(
            'UPDATE tracked_picks SET is_free_pick = false WHERE game_date = $1 AND is_free_pick', [pick.game_date]);
          await client.query('UPDATE tracked_picks SET is_free_pick = true WHERE id = $1', [pickId]);
          await client.query('COMMIT');
          sendJson(res, 200, { ok: true, pickId, gameDate: pick.game_date });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          sendJson(res, 500, { error: err.message });
        } finally {
          client.release();
        }
        return;
      }

      if (url.pathname === '/api/admin/users' && req.method === 'GET') {
        sendJson(res, 200, await buildAdminUsers());
        return;
      }

      if (url.pathname === '/api/admin/email/stats' && req.method === 'GET') {
        const [{ rows: counts }, { rows: sends }] = await Promise.all([
          pool.query(`SELECT count(*)::int AS eligible FROM users WHERE email_verified = true AND marketing_opt_in = true`),
          pool.query(`SELECT id, sent_at, admin_user_id, recipient_count, pick_ids, subject FROM email_sends ORDER BY sent_at DESC LIMIT 20`),
        ]);
        sendJson(res, 200, { eligibleRecipients: counts[0].eligible, recentSends: sends });
        return;
      }

      // CSV export of the verified + opted-in list. POST and a file
      // download on purpose: email addresses never appear in a URL,
      // query string, or GET response.
      if (url.pathname === '/api/admin/email/export' && req.method === 'POST') {
        const recipients = await marketingRecipients(pool);
        const csv = ['email', ...recipients.map((r) => `"${String(r.email).replace(/"/g, '""')}"`)].join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="slatefinder-marketing-list.csv"',
          'Cache-Control': 'no-store',
        });
        res.end(csv);
        return;
      }

      if (url.pathname === '/api/admin/email/preview' && req.method === 'POST') {
        const { intro, pickIds, subject } = await readJsonBody(req);
        const loaded = await loadPublishedPicks(pool, pickIds);
        if (!loaded.ok) return sendJson(res, 400, { error: loaded.error });
        // Preview renders with a placeholder token; the real send mints
        // a fresh signed token per recipient.
        const html = renderAdminEmail({
          intro: String(intro || ''),
          picks: loaded.picks,
          unsubscribeUrl: `${(process.env.APP_BASE_URL || '').replace(/\/$/, '')}/email/unsubscribe?token=preview`,
          postalAddress: (process.env.POSTAL_ADDRESS || '').trim(),
        });
        sendJson(res, 200, { html, subject: String(subject || '').trim() || "Today's published picks" });
        return;
      }

      if (url.pathname === '/api/admin/email/send' && req.method === 'POST') {
        const { intro, pickIds, subject } = await readJsonBody(req);
        const result = await sendAdminEmail(pool, { adminUserId: admin.id, intro, pickIds, subject });
        if (!result.ok) return sendJson(res, 422, { error: result.error });
        sendJson(res, 200, { sent: result.sent, total: result.total });
        return;
      }

      return sendJson(res, 404, { error: 'no such admin endpoint' });
    }

    if ((url.pathname === '/api/refresh' || url.pathname === '/refresh') && req.method === 'POST') {
      if (!(await requireUser(req, res))) return;
      if (rateLimited(req, 'refresh', 6, 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Slow down, refresh is already running on a schedule.' });
      // The web app doesn't run the pipeline; it signals the engine
      // (worker.js), which picks up the request within ~20s and runs an
      // MLB-only refresh (never a metered odds pull).
      await requestRefresh(pool);
      sendJson(res, 202, { started: true });
      return;
    }

    // --- accounts ---------------------------------------------------------
    if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
      if (rateLimited(req, 'signup', 10, 60 * 60 * 1000)) return sendJson(res, 429, { error: 'Too many signups from this address, try again later.' });
      const { email, password, rememberMe, marketingOptIn } = await readJsonBody(req);
      const cleanEmail = String(email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return sendJson(res, 400, { error: 'That email does not look right.' });
      if (typeof password !== 'string' || password.length < 8) return sendJson(res, 400, { error: 'Password needs at least 8 characters.' });
      try {
        const user = await createUser(pool, cleanEmail, password, { marketingOptIn: marketingOptIn === true });
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
      // Run status comes from the engine via the shared system_status row.
      const engine = await readSystemStatus(pool).catch(() => ({}));
      sendJson(res, 200, {
        ...engine,
        today: todayIsoDate(),
        build: BUILD,
        paywallEnabled: PAYWALL_ENABLED,
      });
      return;
    }

    // The dual public record: the trust surface, open to everyone.
    if (url.pathname === '/api/record' && req.method === 'GET') {
      sendJson(res, 200, await buildRecord());
      return;
    }

    // Per-signal and per-grade breakdown off the same immutable ledger.
    // Public on purpose: this is the evidence behind every claim the
    // product makes, and a track record nobody can audit is worthless.
    // Both scopes ship (algorithm = everything generated, published = what
    // was actually called), so the honest and the flattering number are
    // always side by side.
    if (url.pathname === '/api/performance/breakdown' && req.method === 'GET') {
      const sinceParam = url.searchParams.get('sinceDays');
      const sinceDays = sinceParam !== null && /^\d{1,4}$/.test(sinceParam) ? Number(sinceParam) : null;
      sendJson(res, 200, await buildPerformanceBreakdown(pool, { sinceDays }));
      return;
    }

    if (url.pathname === '/api/digest') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });

      const user = await userForSession(pool, parseCookies(req).sf_session);
      const research = researchAccess(user);

      const [digest, availableDates, ledger] = await Promise.all([
        loadDigest(date),
        listDigestDates(),
        ledgerForDate(date),
      ]);

      // FREE surface: the day's single best published pick in full, plus a
      // stripped stub for every other published pick so the reader can see
      // the size and shape of the board (and watch it win or lose) without
      // being handed it. MEMBER surface (or paywall off): the full ledger
      // for the date - every qualifying pick with its metrics, published
      // or not - plus the research tables from the digest.
      const freeMoneyline = pickFreeMoneyline(ledger);
      const allPublished = ledger.filter((r) => r.published).map(shapeLedgerPick);
      const featured = research ? null : pickFeatured(ledger);
      const publishedToday = research
        ? allPublished
        : allPublished.map((p) => (featured && p.id === featured.id ? p : lockedStub(p)));

      const base = {
        date,
        availableDates,
        updatedAt: digest.updatedAt,
        warnings: digest.warnings,
        access: {
          research,
          paywallEnabled: PAYWALL_ENABLED,
          // What the reader is missing, so the app can say "6 more picks"
          // rather than an unquantified nag.
          lockedCount: research ? 0 : Math.max(0, allPublished.length - (featured ? 1 : 0)),
        },
        featuredPickId: featured?.id ?? null,
        // 'owner' when the free pick was designated from the Finder,
        // 'auto' when nobody curated the slate and it fell back to the
        // highest score. Metadata about the SELECTION, so it lives here
        // rather than on the card -- publishedToday is re-shaped straight
        // from the ledger and would drop a field decorated onto `featured`.
        featuredPickChosenBy: featured?.freePickChosenBy ?? null,
        freeMoneyline,
        publishedToday,
      };

      if (!research) {
        return sendJson(res, 200, base);
      }

      sendJson(res, 200, {
        ...base,
        topPicks: digest.topPicks,
        moneyline: digest.moneyline,
        hitStreak: digest.hitStreak,
        windHr: digest.windHr,
        strikeouts: digest.strikeouts,
        ledger: ledger.map(shapeLedgerPick),
      });
      return;
    }

    if (url.pathname === '/api/slate') {
      const date = url.searchParams.get('date') || todayIsoDate();
      if (!ISO_DATE_RE.test(date)) return sendJson(res, 400, { error: 'bad date' });
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

    if (url.pathname === '/api/tracked-picks/grade' && req.method === 'POST') {
      if (!(await requireUser(req, res))) return;
      if (rateLimited(req, 'tracked-picks-grade', 10, 10 * 60 * 1000)) {
        return sendJson(res, 429, { error: 'Slow down, try again in a bit.' });
      }
      sendJson(res, 200, await gradePendingPicks(pool));
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

    // --- newsletter unsubscribe (from the daily digest's one-click link) --
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

    // --- marketing unsubscribe (signed, expiring token; no login) ---------
    if (url.pathname === '/email/unsubscribe') {
      const uid = await verifyUnsubscribeToken(pool, url.searchParams.get('token') || '');
      const ok = uid !== null ? await marketingUnsubscribe(pool, uid) : false;
      const already = uid !== null && !ok;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#101216;color:#e7e9ee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center;padding:24px"><p style="font-size:16px;font-weight:600">${uid !== null ? "You're unsubscribed from marketing emails." : 'That link is invalid or has expired.'}</p>
        <p style="color:#9ba3b0;font-size:13px">${already ? 'You were already unsubscribed, nothing more to do.' : ''}</p>
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
  // Migrations run idempotently on both services; the engine (worker.js)
  // is the canonical writer, but the web app running them too is safe and
  // means a web-only boot still self-heals the schema.
  await runMigrations(pool);
  await ensureAuthSchema(pool);
  await ensureInsertSafety(pool);

  server.listen(PORT, () => {
    console.log(`SlateFinder web listening on :${PORT}`);
  });

  // Single-service default: run the engine (generation, grading, hourly
  // refresh) IN THIS PROCESS. worker.js is still the canonical standalone
  // engine for a two-service split, but most deploys (including the
  // current Railway setup) run one service on `npm start` (server.js) — so
  // unless a separate engine is explicitly configured, the web process
  // hosts the engine too, otherwise nothing would ever generate the board.
  // Set RUN_ENGINE_IN_WEB=false on the web service once a dedicated engine
  // service (npm run start:worker) is running, so the loops don't run twice.
  if (String(process.env.RUN_ENGINE_IN_WEB ?? 'true').toLowerCase() !== 'false') {
    try {
      const { startEngine } = await import('./worker.js');
      // Migrations already ran above; don't bind a second health server
      // (this process already owns PORT).
      await startEngine({ runMigrationsFirst: false, withHealthServer: false });
    } catch (err) {
      console.error('In-process engine failed to start:', err);
    }
  } else {
    console.log('RUN_ENGINE_IN_WEB=false: engine expected to run as a separate worker.js service.');
  }
}

// Starts on import. The admin test suite imports this module (with a
// cache-busting query) precisely to get a live server bound to a test
// PORT, so importing == starting is intentional, not a footgun to guard.
start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

import 'dotenv/config';
import http from 'node:http';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { runPipeline, todayIsoDate } from './lib/pipeline.js';
import { ensureAuthSchema } from './lib/auth.js';
import { ensureInsertSafety } from './lib/schemaGuard.js';
import { gradePendingPicks } from './lib/trackedPicks.js';
import { gradePendingBets } from './lib/bets.js';
import { sendDailyNewsletter } from './lib/newsletter.js';
import { fetchMoneylines, normalizeTeam } from './lib/sources/odds.js';
import { getOddsProvider, oddsApiKey } from './lib/sources/oddsProvider.js';
import { breakevenPct } from './lib/breakeven.js';
import {
  pacificDateIso, isGenerationHour, msUntilNextTopOfHour, GENERATION_HOUR_PT,
  easternHour, easternMinute, GAME_LOG_PULL_HOUR_ET, SAVANT_PULL_TIMES_ET,
} from './lib/schedule.js';
import { markRefreshStarted, markRefreshFinished, claimRefreshRequest } from './lib/systemStatus.js';
import { pullTodaysRosterHistory } from './lib/data/game-logs-pull.js';
import { runSavantSnapshotPull } from './lib/data/savant-pull.js';
import { recalcTeamBattingAggregates, recalcBatterVsTeamHistory } from './lib/data/team-aggregates.js';

// The always-on engine. This is the headless "brain": it runs the
// research pipeline continuously (MLB Stats API is free and unmetered),
// generates the day's moneyline board once each morning at 8 AM Pacific
// (the only time it spends a metered odds pull, aside from the closing
// line near first pitch), grades finished games, and sends the daily
// email. It shares one Postgres database with the web app (server.js) but
// runs as a SEPARATE service, so the two scale and fail independently.
// The web app never runs the pipeline; it reads what this writes.

const PORT = process.env.PORT || 3000;
const NEWSLETTER_HOUR_PT = GENERATION_HOUR_PT; // the daily email goes out with the generation run

// The "game date" the engine works on: the Pacific calendar date, since
// generation is anchored to 8 AM Pacific.
function engineGameDate() {
  return pacificDateIso();
}

let isRunning = false;

// One pipeline run, guarded so overlapping ticks (a slow run bleeding
// into the next hour) can't stack. Records start/finish to system_status
// so the web app's /api/status reflects it.
async function runOnce({ fetchOdds, isGeneration, label }) {
  if (isRunning) {
    console.log(`Engine: ${label} skipped, a run is already in progress.`);
    return;
  }
  isRunning = true;
  const gameDate = engineGameDate();
  await markRefreshStarted(pool).catch(() => {});
  try {
    const result = await runPipeline(gameDate, { fetchOdds, isGeneration });
    await markRefreshFinished(pool, { gameDate, error: null, warnings: result?.warnings || [] });
  } catch (err) {
    console.error(`Engine: ${label} failed:`, err);
    await markRefreshFinished(pool, { gameDate, error: err.message, warnings: [] }).catch(() => {});
  } finally {
    isRunning = false;
  }
}

// Closing-line pull: the second (and final) metered odds call of the day,
// once shortly before the day's earliest first pitch, to stamp
// closing_price / clv_pct onto today's moneyline picks. Latched per date.
let closingPulledFor = null;
async function maybePullClosingLines() {
  const date = engineGameDate();
  if (closingPulledFor === date) return;
  const provider = getOddsProvider();
  const key = oddsApiKey(provider);
  if (provider.requiresKey && !key) return;

  const { rows: pending } = await pool.query(
    `SELECT tp.id, tp.locked_price, tp.breakeven_pct, tp.qualifying_metrics
     FROM tracked_picks tp
     WHERE tp.game_date = $1 AND tp.signal_type = 'moneyline' AND tp.closing_price IS NULL`,
    [date]
  );
  if (!pending.length) { closingPulledFor = date; return; }

  const { rows: firstGame } = await pool.query(
    `SELECT min(game_time_utc) AS first FROM games WHERE game_date = $1`,
    [date]
  );
  const first = firstGame[0]?.first ? new Date(firstGame[0].first) : null;
  if (!first || first.getTime() - Date.now() > 65 * 60 * 1000) return; // within an hour of first pitch

  console.log('Engine: closing-line pull (odds call #2 of the day)...');
  closingPulledFor = date; // latch before the call so a failure can't drain quota
  try {
    const moneylines = await provider.fetchMoneylines(key);
    let updated = 0;
    for (const pick of pending) {
      const homeTeam = pick.qualifying_metrics?.homeTeam;
      const awayTeam = pick.qualifying_metrics?.awayTeam;
      const match = moneylines.find(
        (o) => normalizeTeam(o.homeTeam) === normalizeTeam(homeTeam) && normalizeTeam(o.awayTeam) === normalizeTeam(awayTeam)
      );
      if (!match || match.homeMl === null) continue;
      const locked = pick.breakeven_pct !== null ? Number(pick.breakeven_pct) : breakevenPct(pick.locked_price);
      const closing = breakevenPct(match.homeMl);
      const clv = locked !== null && closing !== null ? closing - locked : null;
      await pool.query('UPDATE tracked_picks SET closing_price = $1, clv_pct = $2 WHERE id = $3', [match.homeMl, clv, pick.id]);
      updated++;
    }
    console.log(`Engine: closing-line pull stamped ${updated}/${pending.length} pick(s).`);
  } catch (err) {
    console.warn(`Engine: closing-line pull failed: ${err.message}`);
  }
}

// Daily historical-data maintenance, per the Phase 1 spec's pull schedule:
// game logs once at 6am ET (backfilling yesterday's completed games into
// pitcher_game_logs / batter_game_logs for today's rostered players), and
// the two derived aggregate tables recalculated right after. Both MLB-Stats-
// only, neither touches the metered odds budget. Latched per calendar day
// so a slow tick that straddles the hour boundary can't double-run it.
let gameLogPulledFor = null;
async function maybeRunDailyGameLogPull(force = false) {
  const date = engineGameDate();
  if (!force && (easternHour() !== GAME_LOG_PULL_HOUR_ET || gameLogPulledFor === date)) return;
  gameLogPulledFor = date;
  console.log(`Engine: daily game-log pull (${force ? 'boot catch-up' : '6am ET'})...`);
  try {
    const { pitchersDone, battersDone } = await pullTodaysRosterHistory(pool, date);
    const season = Number(date.slice(0, 4));
    const teamAgg = await recalcTeamBattingAggregates(pool, season, date);
    const vsTeam = await recalcBatterVsTeamHistory(pool, date);
    console.log(`Engine: game-log pull done - ${pitchersDone} pitchers, ${battersDone} batters, ${teamAgg.written} team aggregates, ${vsTeam.written} vs-team rows.`);
  } catch (err) {
    console.warn(`Engine: daily game-log pull failed: ${err.message}`);
  }
}

// Savant leaderboard snapshot: does the actual pull + write, logging
// exactly what landed (row counts for both raw CSV rows and rows actually
// parsed/upserted) so a diagnosis never has to guess whether the pull ran,
// ran and returned nothing, or ran and failed to parse -- those are three
// different problems and the log line now says which one happened.
async function runSavantSnapshotNow(reason) {
  const date = engineGameDate();
  console.log(`Engine: Savant leaderboard snapshot starting (${reason})...`);
  try {
    const season = Number(date.slice(0, 4));
    const result = await runSavantSnapshotPull(pool, season, date);
    console.log(
      `Engine: Savant snapshot done - pitchers: ${result.pitchers.written} written / ${result.pitchers.rowCount} CSV rows` +
      (result.pitchers.rowCount === 0 ? ' (EMPTY RESPONSE -- endpoint may be down or its shape changed)' : '') +
      `; batters: ${result.batters.written} written / ${result.batters.rowCount} CSV rows` +
      (result.batters.rowCount === 0 ? ' (EMPTY RESPONSE -- endpoint may be down or its shape changed)' : '')
    );
    return result;
  } catch (err) {
    console.warn(`Engine: Savant snapshot pull FAILED: ${err.message}`);
    return null;
  }
}

// Savant snapshot: two scheduled times a day, each with a purpose (see
// lib/schedule.js SAVANT_PULL_TIMES_ET) -- 8:00 AM ET and 1:30 PM ET need
// half-hour precision the hourly tick can't give, so this polls every
// minute and fires when the clock matches a scheduled slot, latched per
// (date, slot) so it only fires once per slot per day even though the
// poll checks every minute.
const savantSlotsFiredToday = new Set();
function startSavantPullPoll() {
  setInterval(async () => {
    const date = engineGameDate();
    const hour = easternHour();
    const minute = easternMinute();
    for (const slot of SAVANT_PULL_TIMES_ET) {
      const key = `${date}:${slot.hour}:${slot.minute}`;
      if (hour === slot.hour && minute === slot.minute && !savantSlotsFiredToday.has(key)) {
        savantSlotsFiredToday.add(key);
        await runSavantSnapshotNow(`scheduled ${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')} ET`);
      }
    }
  }, 60 * 1000);
}

// Top-of-hour loop. Exactly one tick per hour; the 8 AM PT tick is the
// generation run (odds + record + lock + newsletter), every other tick is
// an MLB-only refresh (lineups, probable starters, filter recompute).
function scheduleHourlyTicks() {
  const delay = msUntilNextTopOfHour();
  console.log(`Engine: next hourly tick in ${(delay / 60000).toFixed(0)}m.`);
  setTimeout(async () => {
    const generation = isGenerationHour();
    await runOnce({
      fetchOdds: generation,
      isGeneration: generation,
      label: generation ? 'generation run (8 AM PT)' : 'hourly MLB-only refresh',
    });
    await maybePullClosingLines();
    await maybeRunDailyGameLogPull();
    try {
      const { graded, checked } = await gradePendingBets(pool);
      if (checked) console.log(`Engine: bets auto-graded ${graded}/${checked}.`);
    } catch (err) {
      console.warn(`Engine: bet grading pass failed: ${err.message}`);
    }
    if (generation) {
      try {
        await sendDailyNewsletter(pool, engineGameDate());
      } catch (err) {
        console.warn(`Engine: newsletter send failed: ${err.message}`);
      }
    }
    scheduleHourlyTicks();
  }, delay);
}

// Grade finished games between hourly ticks so a result flips to W/L
// shortly after the final, not at the next top of hour.
function startGradingLoop() {
  setInterval(async () => {
    try {
      await gradePendingPicks(pool);
      await gradePendingBets(pool);
    } catch (err) {
      console.warn(`Engine: grading loop: ${err.message}`);
    }
  }, 10 * 60 * 1000);
}

// Poll for a manual refresh request from the web app and honor it with an
// MLB-only refresh (never a metered odds pull). Short interval so the
// button feels responsive.
function startRefreshSignalPoll() {
  setInterval(async () => {
    try {
      if (await claimRefreshRequest(pool)) {
        await runOnce({ fetchOdds: false, isGeneration: false, label: 'manual refresh (MLB-only)' });
      }
    } catch (err) {
      console.warn(`Engine: refresh-signal poll: ${err.message}`);
    }
  }, 20 * 1000);
}

// A tiny health endpoint so the platform (Railway) can see the worker is
// up. The engine is not a web surface; this is only /healthz.
function startHealthServer() {
  http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('engine');
  }).listen(PORT, () => console.log(`Engine health server on :${PORT}`));
}

// Start every engine loop. Exported so a single-service deploy can run the
// engine in-process from the web app (server.js) without a second Railway
// service; the standalone `node worker.js` path calls this too. Options:
//   runMigrationsFirst - the standalone engine owns migrations; when the
//     web app already ran them on its own boot, it passes false.
//   withHealthServer   - the standalone engine binds /healthz on PORT; the
//     web app already serves the port itself, so it passes false to avoid
//     an EADDRINUSE collision.
export async function startEngine({ runMigrationsFirst = true, withHealthServer = true } = {}) {
  if (runMigrationsFirst) {
    // The engine owns migrations. The web app also runs them idempotently
    // on boot, but the engine is the canonical writer.
    await runMigrations(pool);
    await ensureAuthSchema(pool);
    await ensureInsertSafety(pool);
  }

  if (withHealthServer) startHealthServer();

  // Boot populate. Only spend a metered odds pull if today's games have
  // no prices yet AND we're already past the generation hour (a restart
  // mid-day shouldn't re-run generation and re-lock; but a fresh boot on
  // a day with no board yet should seed one). Otherwise MLB-only.
  const gameDate = engineGameDate();
  const { rows } = await pool.query(
    `SELECT count(*)::int AS priced FROM games WHERE game_date = $1 AND home_ml IS NOT NULL`,
    [gameDate]
  ).catch(() => ({ rows: [{ priced: 0 }] }));
  const { rows: lockRows } = await pool.query('SELECT 1 FROM moneyline_lock WHERE game_date = $1', [gameDate]).catch(() => ({ rows: [] }));
  const alreadyLocked = lockRows.length > 0;
  const needsFreshBoard = !alreadyLocked && rows[0].priced === 0;
  await runOnce({
    fetchOdds: needsFreshBoard,
    isGeneration: needsFreshBoard,
    label: needsFreshBoard ? 'boot generation (no board yet today)' : 'boot MLB-only refresh',
  });

  // Boot catch-up for the Savant/game-log data, and this is the actual
  // fix for "the dashboard shows no Savant data at all": the old code
  // only ever pulled on a scheduled clock tick, so a service that
  // deployed or restarted outside the 8:00/13:30 ET windows (or before
  // 6am ET for game logs) would show a genuinely, correctly EMPTY
  // savant_pitcher_metrics / team_batting_aggregates until the next
  // scheduled slot arrived -- not a bug in the pull itself, just no pull
  // had happened yet. Checking "is there anything on file for today" and
  // pulling immediately if not means a fresh deploy always has real data
  // within one boot, not up to several hours later.
  const season = Number(gameDate.slice(0, 4));
  const { rows: savantCheck } = await pool.query(
    `SELECT count(*)::int AS n FROM savant_pitcher_metrics WHERE season = $1 AND pull_date = $2`,
    [season, gameDate]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  if (savantCheck[0].n === 0) {
    await runSavantSnapshotNow('boot catch-up, nothing on file for today yet');
  } else {
    console.log(`Engine: Savant snapshot already on file for today (${savantCheck[0].n} pitcher rows), skipping boot catch-up.`);
  }

  const { rows: aggCheck } = await pool.query(
    `SELECT count(*)::int AS n FROM team_batting_aggregates WHERE season = $1`,
    [season]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  if (aggCheck[0].n === 0) {
    console.log('Engine: team_batting_aggregates empty for this season, running a boot catch-up game-log pull...');
    await maybeRunDailyGameLogPull(true);
  }

  scheduleHourlyTicks();
  startGradingLoop();
  startRefreshSignalPoll();
  startSavantPullPoll();
  console.log(`Engine running. Generation at ${GENERATION_HOUR_PT}:00 Pacific; daily email at the same tick.`);
}

// Auto-start ONLY when this file is the process entrypoint (`node
// worker.js`). When server.js imports startEngine for single-service mode,
// importing this module must not kick off a second standalone engine.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startEngine({ runMigrationsFirst: true, withHealthServer: true }).catch((err) => {
    console.error('Engine failed to start:', err);
    process.exit(1);
  });
}

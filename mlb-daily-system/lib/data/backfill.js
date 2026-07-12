import * as mlb from '../sources/mlbStats.js';
import { pullPitcherSeasonLog, pullBatterSeasonLog } from './game-logs-pull.js';
import { pullAndStoreSavantPitchers, pullAndStoreSavantBatters } from './savant-pull.js';
import { recalcTeamBattingAggregates, recalcBatterVsTeamHistory } from './team-aggregates.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "Be respectful, 1 request/second pace" per the spec. Each player pull is
// itself one HTTP request (game log), so this is the pace between players.
const REQUEST_PACE_MS = 1000;

async function loadProgress(pool, jobName, season) {
  const { rows } = await pool.query(
    'SELECT * FROM backfill_progress WHERE job_name = $1 AND season = $2',
    [jobName, season]
  );
  return rows[0] || null;
}

async function saveProgress(pool, jobName, season, patch) {
  await pool.query(
    `INSERT INTO backfill_progress (job_name, season, last_player_id, players_done, players_total, status, last_error, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (job_name, season) DO UPDATE SET
       last_player_id = EXCLUDED.last_player_id, players_done = EXCLUDED.players_done,
       players_total = EXCLUDED.players_total, status = EXCLUDED.status,
       last_error = EXCLUDED.last_error, updated_at = now()`,
    [
      jobName, season,
      patch.lastPlayerId ?? null, patch.playersDone ?? 0, patch.playersTotal ?? null,
      patch.status ?? 'in_progress', patch.lastError ?? null,
    ]
  );
}

// Enumerates every pitcher (or hitter) across all 30 teams' full-season
// rosters for one season, deduped by player id (a player traded mid-season
// appears on two rosters; only pulling his log once matters, not which
// team he's attributed to here -- team_abbr comes from each individual
// game log split, which is always correct per-game regardless of this
// dedup).
async function enumerateSeasonPlayers(season, group) {
  const teams = await mlb.fetchAllTeams(season);
  const byId = new Map();
  for (const team of teams) {
    try {
      const roster = await mlb.fetchSeasonRoster(team.id, season);
      const list = group === 'pitching' ? roster.pitchers : roster.hitters;
      for (const p of list) byId.set(p.id, p.fullName);
    } catch (err) {
      console.warn(`  Backfill: roster pull failed for team ${team.abbrev ?? team.id} / ${season}: ${err.message}`);
    }
    await sleep(REQUEST_PACE_MS);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

// Pulls every pitcher's (or batter's) full game log for one season,
// resumable via backfill_progress: a re-run for the same (jobName, season)
// skips players already recorded as done, so an interrupted multi-hour
// backfill picks back up instead of restarting from zero.
async function backfillSeasonGameLogs(pool, season, group) {
  const jobName = group === 'pitching' ? 'pitcher_game_logs' : 'batter_game_logs';
  const pullFn = group === 'pitching' ? pullPitcherSeasonLog : pullBatterSeasonLog;

  let progress = await loadProgress(pool, jobName, season);
  if (progress?.status === 'complete') {
    console.log(`Backfill: ${jobName} ${season} already complete (${progress.players_done} players), skipping.`);
    return { skipped: true, playersDone: progress.players_done };
  }

  console.log(`Backfill: enumerating ${group} rosters for ${season}...`);
  const players = await enumerateSeasonPlayers(season, group);
  console.log(`Backfill: ${players.length} ${group === 'pitching' ? 'pitchers' : 'batters'} found for ${season}.`);

  // Resume point: skip players up to and including the last completed id,
  // in enumeration order. Enumeration order isn't guaranteed stable across
  // runs (roster APIs don't promise ordering), so this is a best-effort
  // resume, not a guarantee -- worst case on a resume some players get
  // re-pulled (harmless, ON CONFLICT upserts) rather than skipped.
  let startIdx = 0;
  if (progress?.last_player_id) {
    const idx = players.findIndex((p) => p.id === progress.last_player_id);
    if (idx >= 0) startIdx = idx + 1;
  }

  let playersDone = progress?.players_done ?? 0;
  await saveProgress(pool, jobName, season, {
    playersDone, playersTotal: players.length, status: 'in_progress',
  });

  for (let i = startIdx; i < players.length; i++) {
    const p = players[i];
    try {
      const games = await pullFn(pool, p.id, p.name, season);
      playersDone++;
      if (playersDone % 25 === 0) {
        console.log(`Backfill: ${jobName} ${season} - ${playersDone}/${players.length} players (${p.name}: ${games} games).`);
      }
      await saveProgress(pool, jobName, season, {
        lastPlayerId: p.id, playersDone, playersTotal: players.length, status: 'in_progress',
      });
    } catch (err) {
      console.warn(`  Backfill: game log pull failed for ${p.name} (${p.id}), ${season}: ${err.message}`);
      await saveProgress(pool, jobName, season, {
        lastPlayerId: p.id, playersDone, playersTotal: players.length, status: 'in_progress', lastError: err.message,
      });
    }
    await sleep(REQUEST_PACE_MS);
  }

  await saveProgress(pool, jobName, season, { playersDone, playersTotal: players.length, status: 'complete' });
  console.log(`Backfill: ${jobName} ${season} complete (${playersDone}/${players.length} players).`);
  return { skipped: false, playersDone };
}

// Season-end Savant snapshot: one pull per season per type, stored with
// pull_date = the season's last day, since a historical backfill has no
// "today" to stamp the snapshot with.
async function backfillSeasonSavant(pool, season) {
  const jobName = 'savant_snapshot';
  const progress = await loadProgress(pool, jobName, season);
  if (progress?.status === 'complete') {
    console.log(`Backfill: Savant ${season} already complete, skipping.`);
    return { skipped: true };
  }
  const pullDate = `${season}-11-01`; // after the World Series, safely "season end"
  try {
    const p = await pullAndStoreSavantPitchers(pool, season, pullDate);
    const b = await pullAndStoreSavantBatters(pool, season, pullDate);
    console.log(`Backfill: Savant ${season} - ${p.written} pitchers, ${b.written} batters.`);
    await saveProgress(pool, jobName, season, { status: 'complete', playersDone: p.written + b.written });
  } catch (err) {
    console.warn(`  Backfill: Savant ${season} failed: ${err.message}`);
    await saveProgress(pool, jobName, season, { status: 'failed', lastError: err.message });
  }
  return { skipped: false };
}

// The full Phase 1 backfill for a list of seasons, in spec order: pitcher
// logs, batter logs, Savant snapshots, then the two derived aggregate
// tables (once per season across ALL its game logs, since aggregates
// don't need to be resumable -- they're a fast single recompute).
export async function runFullBackfill(pool, seasons = [2023, 2024, 2025]) {
  for (const season of seasons) {
    console.log(`\n=== Backfill: season ${season} ===`);
    await backfillSeasonGameLogs(pool, season, 'pitching');
    await backfillSeasonGameLogs(pool, season, 'hitting');
    await backfillSeasonSavant(pool, season);
    const calcDate = `${season}-11-01`;
    const teamAgg = await recalcTeamBattingAggregates(pool, season, calcDate);
    console.log(`Backfill: team_batting_aggregates ${season} - ${teamAgg.written} teams.`);
  }
  // Batter-vs-team history aggregates across ALL stored seasons at once
  // (it's not season-scoped by design -- more career history is more
  // signal), so it only needs to run once after every season's logs are in.
  const vsTeam = await recalcBatterVsTeamHistory(pool, seasons[seasons.length - 1] + '-11-01');
  console.log(`Backfill: batter_vs_team_history - ${vsTeam.written} batter/opponent pairs.`);
}

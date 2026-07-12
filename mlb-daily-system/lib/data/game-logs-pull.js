import * as mlb from '../sources/mlbStats.js';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// MLB Stats API's gameLog split shape (same for pitching/hitting groups):
// { date, team: {abbreviation}, opponent: {abbreviation}, game: {gamePk}, stat: {...} }.
// Read defensively -- a field missing on an individual split (e.g. a
// suspended/resumed game with an odd boxscore) should drop that one game,
// not crash the whole pull.
function splitGamePk(split) {
  return split.game?.gamePk ?? split.gamePk ?? null;
}

async function upsertPitcherGameLogRow(pool, playerId, playerName, split) {
  const gamePk = splitGamePk(split);
  if (!gamePk || !split.date) return false;
  const s = split.stat || {};
  await pool.query(
    `INSERT INTO pitcher_game_logs
       (player_id, player_name, team_abbr, game_date, game_pk, opponent_abbr,
        innings_pitched, hits_allowed, runs_allowed, earned_runs, walks,
        strikeouts, home_runs_allowed, pitches_thrown, era)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (player_id, game_pk) DO UPDATE SET
       innings_pitched = EXCLUDED.innings_pitched,
       hits_allowed = EXCLUDED.hits_allowed,
       runs_allowed = EXCLUDED.runs_allowed,
       earned_runs = EXCLUDED.earned_runs,
       walks = EXCLUDED.walks,
       strikeouts = EXCLUDED.strikeouts,
       home_runs_allowed = EXCLUDED.home_runs_allowed,
       pitches_thrown = EXCLUDED.pitches_thrown,
       era = EXCLUDED.era`,
    [
      playerId, playerName, split.team?.abbreviation ?? null, split.date, gamePk,
      split.opponent?.abbreviation ?? null,
      num(s.inningsPitched), num(s.hits), num(s.runs), num(s.earnedRuns), num(s.baseOnBalls),
      num(s.strikeOuts), num(s.homeRuns), num(s.numberOfPitches), num(s.era),
    ]
  );
  return true;
}

async function upsertBatterGameLogRow(pool, playerId, playerName, split) {
  const gamePk = splitGamePk(split);
  if (!gamePk || !split.date) return false;
  const s = split.stat || {};
  await pool.query(
    `INSERT INTO batter_game_logs
       (player_id, player_name, team_abbr, game_date, game_pk, opponent_abbr,
        at_bats, hits, doubles, triples, home_runs, rbi, walks, strikeouts, batting_avg)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (player_id, game_pk) DO UPDATE SET
       at_bats = EXCLUDED.at_bats,
       hits = EXCLUDED.hits,
       doubles = EXCLUDED.doubles,
       triples = EXCLUDED.triples,
       home_runs = EXCLUDED.home_runs,
       rbi = EXCLUDED.rbi,
       walks = EXCLUDED.walks,
       strikeouts = EXCLUDED.strikeouts,
       batting_avg = EXCLUDED.batting_avg`,
    [
      playerId, playerName, split.team?.abbreviation ?? null, split.date, gamePk,
      split.opponent?.abbreviation ?? null,
      num(s.atBats), num(s.hits), num(s.doubles), num(s.triples), num(s.homeRuns),
      num(s.rbi), num(s.baseOnBalls), num(s.strikeOuts), num(s.avg),
    ]
  );
  return true;
}

// Pulls and stores one pitcher's full game log for a season. Returns the
// number of games written. Used by both the daily pull (current season,
// today's rostered pitchers) and the historical backfill (2023-2025).
export async function pullPitcherSeasonLog(pool, playerId, playerName, season) {
  const splits = await mlb.fetchPitcherGameLog(playerId, season);
  let written = 0;
  for (const split of splits) {
    if (await upsertPitcherGameLogRow(pool, playerId, playerName, split)) written++;
  }
  return written;
}

export async function pullBatterSeasonLog(pool, playerId, playerName, season) {
  const splits = await mlb.fetchBatterGameLog(playerId, season);
  let written = 0;
  for (const split of splits) {
    if (await upsertBatterGameLogRow(pool, playerId, playerName, split)) written++;
  }
  return written;
}

// Trailing hits/9 for a pitcher from STORED history (pitcher_game_logs),
// not a fresh API call -- this is the payoff of persisting game logs at
// all: the hit-prop scorer (lib/grading.js scoreHitProp) needs "how many
// hits does this arm actually allow", which replaces opposing-pitcher ERA
// per the Phase 1 spec, and now there's real recent-game data on file to
// compute it from instead of guessing off a season aggregate.
export async function trailingHitsPer9(pool, pitcherId, n = 5) {
  const { rows } = await pool.query(
    `SELECT innings_pitched, hits_allowed FROM pitcher_game_logs
      WHERE player_id = $1 ORDER BY game_date DESC LIMIT $2`,
    [pitcherId, n]
  );
  if (!rows.length) return null;
  const ip = rows.reduce((sum, r) => sum + (Number(r.innings_pitched) || 0), 0);
  const hits = rows.reduce((sum, r) => sum + (Number(r.hits_allowed) || 0), 0);
  if (ip <= 0) return null;
  return Math.round((hits / ip) * 9 * 100) / 100;
}

// Daily maintenance: re-pull the CURRENT season's log for everyone on
// today's two rosters (via the games table), so games since the last pull
// land in history. Cheap and idempotent -- ON CONFLICT upserts, so running
// this against a player who already has yesterday's game stored is a
// no-op for that row.
export async function pullTodaysRosterHistory(pool, gameDate) {
  const season = Number(String(gameDate).slice(0, 4));
  const { rows: games } = await pool.query(
    'SELECT DISTINCT home_starter_id, home_starter_name, away_starter_id, away_starter_name FROM games WHERE game_date = $1',
    [gameDate]
  );
  const { rows: batters } = await pool.query(
    'SELECT DISTINCT batter_id, batter_name FROM batter_form WHERE game_date = $1',
    [gameDate]
  );

  let pitchersDone = 0;
  let battersDone = 0;
  const pitcherIds = new Set();
  for (const g of games) {
    if (g.home_starter_id) pitcherIds.add(JSON.stringify([g.home_starter_id, g.home_starter_name]));
    if (g.away_starter_id) pitcherIds.add(JSON.stringify([g.away_starter_id, g.away_starter_name]));
  }
  for (const key of pitcherIds) {
    const [id, name] = JSON.parse(key);
    try {
      await pullPitcherSeasonLog(pool, id, name, season);
      pitchersDone++;
    } catch (err) {
      console.warn(`  Game-log pull failed for pitcher ${name ?? id}: ${err.message}`);
    }
  }
  for (const b of batters) {
    try {
      await pullBatterSeasonLog(pool, b.batter_id, b.batter_name, season);
      battersDone++;
    } catch (err) {
      console.warn(`  Game-log pull failed for batter ${b.batter_name ?? b.batter_id}: ${err.message}`);
    }
  }
  return { pitchersDone, battersDone };
}

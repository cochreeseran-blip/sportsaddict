-- Phase 1 research dashboard: historical data storage so backtesting and
-- "is this unusual?" context become possible. Everything before this
-- migration only kept same-day rolling snapshots and overwrote them daily;
-- these tables persist real history. migrate.js re-runs this file on every
-- boot, so every statement here must be idempotent by hand.

CREATE TABLE IF NOT EXISTS pitcher_game_logs (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  team_abbr TEXT,
  game_date DATE NOT NULL,
  game_pk INTEGER NOT NULL,
  opponent_abbr TEXT,
  innings_pitched NUMERIC(4,1),
  hits_allowed INTEGER,
  runs_allowed INTEGER,
  earned_runs INTEGER,
  walks INTEGER,
  strikeouts INTEGER,
  home_runs_allowed INTEGER,
  pitches_thrown INTEGER,
  era NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, game_pk)
);
CREATE INDEX IF NOT EXISTS idx_pitcher_game_logs_player_date ON pitcher_game_logs (player_id, game_date);
CREATE INDEX IF NOT EXISTS idx_pitcher_game_logs_date ON pitcher_game_logs (game_date);

CREATE TABLE IF NOT EXISTS batter_game_logs (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  team_abbr TEXT,
  game_date DATE NOT NULL,
  game_pk INTEGER NOT NULL,
  opponent_abbr TEXT,
  at_bats INTEGER,
  hits INTEGER,
  doubles INTEGER,
  triples INTEGER,
  home_runs INTEGER,
  rbi INTEGER,
  walks INTEGER,
  strikeouts INTEGER,
  batting_avg NUMERIC(4,3),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, game_pk)
);
CREATE INDEX IF NOT EXISTS idx_batter_game_logs_player_date ON batter_game_logs (player_id, game_date);
CREATE INDEX IF NOT EXISTS idx_batter_game_logs_date ON batter_game_logs (game_date);
CREATE INDEX IF NOT EXISTS idx_batter_game_logs_team_date ON batter_game_logs (team_abbr, game_date);

CREATE TABLE IF NOT EXISTS savant_pitcher_metrics (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  pull_date DATE NOT NULL,
  k_pct NUMERIC(5,2),
  bb_pct NUMERIC(5,2),
  whiff_pct NUMERIC(5,2),
  hard_hit_pct NUMERIC(5,2),
  xera NUMERIC(5,2),
  era NUMERIC(5,2),
  xba_against NUMERIC(5,3),
  barrel_pct NUMERIC(5,2),
  avg_exit_velo NUMERIC(5,1),
  hits_per_9 NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, pull_date)
);
CREATE INDEX IF NOT EXISTS idx_savant_pitcher_metrics_player ON savant_pitcher_metrics (player_id, pull_date DESC);

CREATE TABLE IF NOT EXISTS savant_batter_metrics (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  pull_date DATE NOT NULL,
  xba NUMERIC(5,3),
  xslg NUMERIC(5,3),
  barrel_pct NUMERIC(5,2),
  hard_hit_pct NUMERIC(5,2),
  k_pct NUMERIC(5,2),
  bb_pct NUMERIC(5,2),
  avg_exit_velo NUMERIC(5,1),
  sprint_speed NUMERIC(5,1),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(player_id, pull_date)
);
CREATE INDEX IF NOT EXISTS idx_savant_batter_metrics_player ON savant_batter_metrics (player_id, pull_date DESC);

-- Raw CSV backup of every Savant pull, so a parsing bug never loses data
-- that was actually fetched successfully -- reparse from here instead of
-- re-pulling.
CREATE TABLE IF NOT EXISTS savant_raw_pulls (
  id SERIAL PRIMARY KEY,
  pull_type TEXT NOT NULL, -- 'pitcher' | 'batter'
  season INTEGER NOT NULL,
  pull_date DATE NOT NULL,
  raw_csv TEXT NOT NULL,
  row_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_savant_raw_pulls_lookup ON savant_raw_pulls (pull_type, season, pull_date DESC);

CREATE TABLE IF NOT EXISTS team_batting_aggregates (
  id SERIAL PRIMARY KEY,
  team_abbr TEXT NOT NULL,
  season INTEGER NOT NULL,
  calc_date DATE NOT NULL,
  team_k_pct NUMERIC(5,2),
  team_ba NUMERIC(4,3),
  team_obp NUMERIC(4,3),
  team_slg NUMERIC(4,3),
  games_played INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_abbr, calc_date)
);
CREATE INDEX IF NOT EXISTS idx_team_batting_aggregates_lookup ON team_batting_aggregates (team_abbr, calc_date DESC);

-- Aggregated (not per-game) so a single unlucky/lucky game can't swing it;
-- only ever surfaced in the UI once total_pa >= 20 (see hitStreak.js),
-- this table stores the full aggregate regardless, the sample-size floor
-- is a display-time decision, not a storage-time one.
CREATE TABLE IF NOT EXISTS batter_vs_team_history (
  id SERIAL PRIMARY KEY,
  batter_id INTEGER NOT NULL,
  batter_name TEXT NOT NULL,
  opponent_abbr TEXT NOT NULL,
  total_pa INTEGER,
  total_ab INTEGER,
  total_hits INTEGER,
  total_hr INTEGER,
  total_k INTEGER,
  batting_avg NUMERIC(4,3),
  last_updated DATE,
  UNIQUE(batter_id, opponent_abbr)
);
CREATE INDEX IF NOT EXISTS idx_batter_vs_team_history_batter ON batter_vs_team_history (batter_id);

-- Resumable backfill progress: the historical pull is a long-running,
-- interruptible job (potentially hours for 500k+ rows per the spec), so it
-- checkpoints here instead of assuming one uninterrupted run. Keyed by a
-- job name + season so pitcher and batter backfills track independently
-- and a restart resumes from the last completed player, not from scratch.
CREATE TABLE IF NOT EXISTS backfill_progress (
  job_name TEXT NOT NULL,
  season INTEGER NOT NULL,
  last_player_id INTEGER,
  players_done INTEGER NOT NULL DEFAULT 0,
  players_total INTEGER,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | complete | failed
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_name, season)
);

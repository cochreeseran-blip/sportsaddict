-- Manual moneyline picks: a direct publish path for when you've done the
-- research yourself (elsewhere) and just want it on the site now, rather
-- than waiting on or debugging the automated odds/schedule pipeline.
CREATE TABLE IF NOT EXISTS manual_picks (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_ml INTEGER NOT NULL,
  reason TEXT,
  mlb_game_id TEXT, -- auto-matched against games table when available, so grading still works
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_picks_date ON manual_picks (game_date);

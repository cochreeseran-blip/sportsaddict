CREATE TABLE IF NOT EXISTS tracked_picks (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  signal_type TEXT NOT NULL, -- 'moneyline' | 'hit_streak' | 'wind_hr'
  mlb_game_id TEXT,
  description TEXT NOT NULL,
  locked_price INTEGER,
  breakeven_pct NUMERIC,
  closing_price INTEGER,
  clv_pct NUMERIC,
  qualifying_metrics JSONB NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending', -- 'win' | 'loss' | 'push' | 'pending'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- No UNIQUE constraint in the spec'd schema, so idempotency (don't
-- re-insert the same pick on every refresh within a day) is handled at
-- the application layer in lib/trackedPicks.js by checking for an
-- existing row before inserting. This index just makes that lookup fast.
CREATE INDEX IF NOT EXISTS idx_tracked_picks_dedupe
  ON tracked_picks (game_date, signal_type, mlb_game_id);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_result
  ON tracked_picks (signal_type, result);

-- Personal bet tracker + newsletter subscribers.

-- Your actual bets — separate from tracked_picks, which is the SYSTEM's
-- automatic ledger of every qualifying signal. This table only gets a row
-- when you explicitly track a bet (tailing a pick or adding one manually).
CREATE TABLE IF NOT EXISTS bets (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,          -- the day the bet rides on
  description TEXT NOT NULL,
  odds INTEGER,                     -- American odds you actually got (nullable for odds-less notes)
  stake NUMERIC NOT NULL CHECK (stake > 0),
  book TEXT,
  -- Auto-grading hooks, set when the bet was tailed from a signal:
  --   'moneyline_home' -> home team of mlb_game_id wins
  --   'batter_hit'     -> batter_id records 1+ hit that day
  --   'batter_hr'      -> batter_id hits a home run that day
  --   'manual'         -> settled by hand only
  bet_kind TEXT NOT NULL DEFAULT 'manual',
  mlb_game_id TEXT,
  batter_id INTEGER,
  result TEXT NOT NULL DEFAULT 'pending', -- 'win' | 'loss' | 'push' | 'pending'
  profit NUMERIC,                   -- computed at settle time; NULL while pending
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bets_result ON bets (result);
CREATE INDEX IF NOT EXISTS idx_bets_game_date ON bets (game_date DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  unsubscribe_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  unsubscribed_at TIMESTAMPTZ
);

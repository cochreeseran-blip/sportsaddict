-- Freezes the day's moneyline board once the go-live run has happened.
-- Before this table has a row for a date, the pipeline can still add new
-- qualifying games to tracked_picks as odds/starters firm up overnight.
-- Once the go-live hour's run inserts a row here, every later run that day
-- (hourly refreshes, manual "Refresh") skips adding new moneyline picks
-- entirely: the board that went live is the board for the rest of the day.
CREATE TABLE IF NOT EXISTS moneyline_lock (
  game_date DATE PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

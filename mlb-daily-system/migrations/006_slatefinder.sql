-- SlateFinder upgrade.
--
-- 1) Batter identity extras for the interactive lineup views: fielding
--    position and jersey number, captured from the confirmed lineup (or
--    active roster fallback) at pipeline time.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS position TEXT;
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS jersey_number TEXT;

-- 2) Track WHEN a team's lineup was first seen as confirmed that day, so
--    the dashboard can show "confirmed at 4:12 PM ET" instead of just a
--    boolean. Only set the first time a batter flips to confirmed.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS lineup_confirmed_at TIMESTAMPTZ;

-- 3) daily_digest historically INSERTed a fresh row on every pipeline run
--    (3+ per day per signal), and the reader picked one arbitrarily.
--    Dedupe keeping the most recent row per (game_date, signal_type),
--    then enforce uniqueness so saveDigest can upsert deterministically.
DELETE FROM daily_digest d
USING daily_digest newer
WHERE d.game_date = newer.game_date
  AND d.signal_type = newer.signal_type
  AND newer.id > d.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_digest_date_signal
  ON daily_digest (game_date, signal_type);

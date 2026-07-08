-- Track whether a batter came from MLB's confirmed starting lineup
-- (posted a couple hours before first pitch) vs. a fallback to the active
-- roster's position players when the lineup isn't out yet, plus a
-- game-by-game hit/no-hit pattern for the batter's last 5 games played
-- (oldest to newest) so the dashboard can show recent form at a glance.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS lineup_confirmed BOOLEAN;
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS last5_results JSONB;

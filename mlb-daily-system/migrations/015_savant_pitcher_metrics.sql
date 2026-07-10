-- Baseball Savant metrics layered onto that day's probable starters, on
-- top of the season/trailing ERA already computed from MLB Stats API game
-- logs (see lib/pitcherForm.js). Best-effort: Savant has no documented
-- public API, so every column here can legitimately be NULL on any given
-- day (page unreachable, page format changed, or that pitcher just isn't
-- in what we could parse). Nothing else in the app depends on these being
-- populated, see lib/sources/savant.js and lib/grading.js.
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_era NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_xera NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_k_pct NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_bb_pct NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_whiff_pct NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_hard_hit_pct NUMERIC;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS savant_updated_at TIMESTAMPTZ;

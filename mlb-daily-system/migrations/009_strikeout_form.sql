-- Strikeout form for the new strikeout-prop research section: per-start
-- K counts over a pitcher's last 5 starts (oldest first, so it reads
-- left-to-right like a form guide) plus the average, computed from the
-- same game logs the ERA numbers already come from.
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS last5_start_ks JSONB;
ALTER TABLE pitcher_form ADD COLUMN IF NOT EXISTS trailing_k_per_start NUMERIC;

-- Tiered hit projections + the home-run signal going live.
--
-- The hit board changes from "will he get a hit" (nearly every regular
-- qualifies, so there's no edge in the pick itself) to a projection of HOW
-- MANY hits, surfaced as two tiers: P(1+) and P(2+). Both come from one
-- binomial model (see lib/hitProjection.js), so the two tiers can never
-- disagree with each other.
--
-- NOTE: lib/migrate.js re-runs every migration on every boot; everything
-- here must stay idempotent.

-- Fraction of the trailing window in which the batter had 2+ hits. The
-- empirical counterpart to the model's P(2+): the model says what should
-- happen from rate inputs, this says what actually has been happening.
-- Shown side by side on the card so a projection can be sanity-checked
-- against the batter's own recent history instead of taken on faith.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS trailing_15_multi_hit_rate NUMERIC;

-- How many of the trailing games are actually behind the rates above.
-- trailing_15_ab already guards the average's denominator; this guards the
-- per-game rates (multi-hit rate, HR rate), where the denominator is games
-- and not at-bats.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS trailing_15_games INTEGER;

-- Per-signal, per-grade performance needs a fast scan of graded picks by
-- type; the existing idx_tracked_picks_signal_result covers (signal_type,
-- result) but the breakdown also groups by the grade stored inside
-- qualifying_metrics, and filters to published rows for the public split.
CREATE INDEX IF NOT EXISTS idx_tracked_picks_perf
  ON tracked_picks (signal_type, result, published);

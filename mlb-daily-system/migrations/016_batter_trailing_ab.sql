-- Sample-size guard for the trailing batting average. trailing_15_avg on
-- its own can't distinguish a real .341 over 42 at-bats from a fluke
-- 1.000 on 2 at-bats, both look like a great number without this. See
-- lib/filters/hitStreak.js for the eligibility rule this feeds.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS trailing_15_ab INTEGER;

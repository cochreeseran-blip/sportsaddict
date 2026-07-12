-- Lineup-position bonus for the corrected hit-prop scoring (Phase 1
-- spec section 2B) needs to know WHERE in the order a confirmed starter
-- is batting, which nothing captured before now.
ALTER TABLE batter_form ADD COLUMN IF NOT EXISTS batting_order_slot INTEGER;

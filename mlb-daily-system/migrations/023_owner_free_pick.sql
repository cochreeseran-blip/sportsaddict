-- Owner-chosen free pick of the day.
--
-- The customer app previously auto-selected the free pick (highest grade
-- score of the day). That stays as the FALLBACK -- a day nobody curates
-- still shows something sensible -- but the owner can now override it from
-- the Finder, which is the actual editorial decision: the best-graded pick
-- is not always the best advertisement.
--
-- Deliberately NOT part of the immutability set enforced by
-- tracked_picks_guard (description / locked_price / breakeven_pct /
-- qualifying_metrics). Which pick is given away free is a presentation
-- choice, not a claim about the pick, so it stays editable after publish.
-- The pick's substance remains frozen exactly as before.

ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS is_free_pick BOOLEAN NOT NULL DEFAULT false;

-- At most one free pick per slate. A partial unique index rather than
-- application logic, so two admin tabs racing cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS tracked_picks_one_free_per_day
  ON tracked_picks (game_date) WHERE is_free_pick;

-- The free pick must be a published pick: giving away something that was
-- never put on the record would let an ungraded pick reach customers.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tracked_picks_free_requires_published') THEN
    ALTER TABLE tracked_picks
      ADD CONSTRAINT tracked_picks_free_requires_published
      CHECK (NOT is_free_pick OR published);
  END IF;
END $$;

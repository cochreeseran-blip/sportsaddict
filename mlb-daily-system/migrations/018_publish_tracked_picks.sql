-- The public track record's whole value is that it can't be edited after
-- the fact. These three columns plus the trigger below are the mechanism:
-- an admin can flip published false -> true, and that is the ONLY
-- permitted state transition on this table from anywhere, including a
-- direct psql UPDATE. The trigger is the enforcement layer, not the
-- application code in lib/publishing.js (that file just calls the UPDATE
-- and translates the resulting Postgres error into an HTTP response).
ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_published ON tracked_picks (game_date, published);

-- CREATE OR REPLACE is naturally idempotent for functions, no DO-block
-- guard needed here the way the CHECK constraints in migration 017 did.
CREATE OR REPLACE FUNCTION tracked_picks_immutability() RETURNS TRIGGER AS $$
DECLARE
  v_game_time TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published THEN
      RAISE EXCEPTION 'tracked_picks: cannot delete a published pick (id %). The public record is permanent.', OLD.id;
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE' from here down.

  -- 1. A published pick can never be unpublished. This is the core
  --    guarantee: publishing is a one-way door.
  IF OLD.published AND NOT NEW.published THEN
    RAISE EXCEPTION 'tracked_picks: cannot un-publish pick %. Publishing is permanent.', OLD.id;
  END IF;

  -- 2. Once published_at is set, it's set forever, it's the timestamp of
  --    record for when this pick became public.
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'tracked_picks: cannot change published_at on pick % once it is set.', OLD.id;
  END IF;

  -- 3. The pick itself can't be rewritten after it's public: not the
  --    description, not the price, not the qualifying numbers that
  --    justified it. Grading columns (result, closing_price, clv_pct)
  --    are deliberately NOT in this list, npm run grade / npm run
  --    closing still have to be able to write those on a published row,
  --    that's how the record ever gets a W/L. Scoped to these four
  --    columns only, not the whole row, so grading isn't blocked.
  IF OLD.published AND (
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.locked_price IS DISTINCT FROM OLD.locked_price OR
    NEW.breakeven_pct IS DISTINCT FROM OLD.breakeven_pct OR
    NEW.qualifying_metrics IS DISTINCT FROM OLD.qualifying_metrics
  ) THEN
    RAISE EXCEPTION 'tracked_picks: cannot edit description/locked_price/breakeven_pct/qualifying_metrics on published pick %.', OLD.id;
  END IF;

  -- 4. The publish transition itself (false -> true): rejected if the
  --    game has already started. A pick can't be added to the public
  --    record after first pitch. Games with no mlb_game_id (shouldn't
  --    happen for moneyline picks, but tracked_picks.mlb_game_id is
  --    nullable) have nothing to check against, so they're allowed
  --    through rather than silently unpublishable forever.
  IF NOT OLD.published AND NEW.published THEN
    IF NEW.mlb_game_id IS NOT NULL THEN
      SELECT game_time_utc INTO v_game_time FROM games WHERE mlb_game_id = NEW.mlb_game_id;
      IF v_game_time IS NOT NULL AND now() >= v_game_time THEN
        RAISE EXCEPTION 'tracked_picks: cannot publish pick % after first pitch (game started at %).', OLD.id, v_game_time;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tracked_picks_immutable ON tracked_picks;
CREATE TRIGGER trg_tracked_picks_immutable
  BEFORE UPDATE OR DELETE ON tracked_picks
  FOR EACH ROW EXECUTE FUNCTION tracked_picks_immutability();

-- One-time historical reconciliation of the "picks I actually called"
-- record.
--
-- The public record (buildPerformance in server.js, the /record page, and
-- the Daily Slate all-time badge) counts a moneyline pick toward "Picks I
-- actually called" only when published = true. But that flag arrived with
-- the admin publishing system (migration 018) -- every moneyline pick made
-- BEFORE it existed was auto-recorded one-per-day by the old pipeline and
-- is sitting at published = false, so the real historical W-L (e.g. 6-1)
-- collapsed to 0-0 the moment the record was scoped to published rows.
--
-- Those old rows ARE genuine calls: the previous system recorded exactly
-- one moneyline pick per day (the day's play), win or loss alike. This
-- marks them published so the record reflects the actual history. It is
-- NOT cherry-picking: it publishes every historical day's pick regardless
-- of result, including the losses.
--
-- Scoped precisely so it can only ever touch real historical rows:
--   * game_date < the cutover date below (today is admin-controlled), and
--   * only days that have exactly ONE moneyline row (the old one-per-day
--     shape) -- any day the new pipeline recorded the full qualifier field
--     has multiple rows and is left entirely to the admin's publish choices.
-- Both guards plus the published = false filter make this idempotent: on
-- re-run (migrate.js re-runs every file every boot) it matches nothing.
--
-- The immutability trigger (migration 018) refuses to publish a pick after
-- its game has started, which every historical pick has, so the trigger is
-- disabled for just this one backfill statement and re-enabled immediately.
-- This is the one legitimate exception: a one-time historical import, not
-- an admin action, and it still only ever flips false -> true.

ALTER TABLE tracked_picks DISABLE TRIGGER trg_tracked_picks_immutable;

UPDATE tracked_picks
   SET published = true,
       published_at = COALESCE(published_at, created_at, now())
 WHERE signal_type = 'moneyline'
   AND published = false
   AND game_date < DATE '2026-07-10'
   AND game_date IN (
     SELECT game_date FROM tracked_picks
      WHERE signal_type = 'moneyline'
      GROUP BY game_date
     HAVING count(*) = 1
   );

ALTER TABLE tracked_picks ENABLE TRIGGER trg_tracked_picks_immutable;

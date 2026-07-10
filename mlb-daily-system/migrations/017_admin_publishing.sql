-- Admin roles, content tiers, and the one-way publishing model.
--
-- The product's only real asset is a public track record that cannot be
-- edited after the fact. The enforcement layer for that is HERE, in the
-- database, not in application code: the tracked_picks_guard trigger
-- below holds against a direct psql UPDATE, there is no admin override
-- and no soft delete. Application code merely surfaces the errors.
--
-- NOTE: lib/migrate.js re-runs every migration file on every boot, so
-- everything in this file must be idempotent.

-- --- users: role / tier / activity / email consent ------------------------

-- The production database once hosted a legacy users table with its own
-- "role" column (see ensureAuthSchema in lib/auth.js), so this can't
-- assume a clean slate: add if missing, normalize whatever values exist,
-- then pin the default + constraint.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
UPDATE users SET role = 'user' WHERE role IS NULL OR role NOT IN ('user', 'admin');
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE users ALTER COLUMN role SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Content tier. Structured now, gated later: PAYWALL_ENABLED=false ships
-- everything to everyone; the boundary only takes effect when it flips.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT;
UPDATE users SET tier = 'free' WHERE tier IS NULL OR tier NOT IN ('free', 'member');
ALTER TABLE users ALTER COLUMN tier SET DEFAULT 'free';
ALTER TABLE users ALTER COLUMN tier SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tier_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_tier_check CHECK (tier IN ('free', 'member'));
  END IF;
END $$;

-- Activity tracking for the admin users panel: set on authenticated
-- requests, throttled in code to at most one write per user per hour.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Email consent. Existing users default to false, nobody is opted in
-- retroactively. email_verified ships as a column now (the count on the
-- admin email panel requires verified AND opted-in) even though the
-- verification flow itself is a later feature; until it exists the
-- verified count will honestly read zero.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;
UPDATE users SET email_verified = false WHERE email_verified IS NULL;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;
ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN;
UPDATE users SET marketing_opt_in = false WHERE marketing_opt_in IS NULL;
ALTER TABLE users ALTER COLUMN marketing_opt_in SET DEFAULT false;
ALTER TABLE users ALTER COLUMN marketing_opt_in SET NOT NULL;

-- --- tracked_picks: the publishing columns ---------------------------------

ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published BOOLEAN;
UPDATE tracked_picks SET published = false WHERE published IS NULL;
ALTER TABLE tracked_picks ALTER COLUMN published SET DEFAULT false;
ALTER TABLE tracked_picks ALTER COLUMN published SET NOT NULL;
ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE tracked_picks ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_tracked_picks_published
  ON tracked_picks (published, game_date);

-- --- the one-way door -------------------------------------------------------
-- BEFORE UPDATE / BEFORE DELETE guard. The only permitted state
-- transition anywhere in the system is published false -> true, and a
-- published row's identity columns (description, locked_price,
-- breakeven_pct, qualifying_metrics) are frozen forever. Grading columns
-- (result, closing_price, clv_pct) stay writable on purpose: the scope
-- of immutability is exactly the listed columns, not the whole row, so
-- npm run grade keeps working on published picks.
CREATE OR REPLACE FUNCTION tracked_picks_guard() RETURNS trigger AS $$
DECLARE g_time TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published THEN
      RAISE EXCEPTION 'tracked_picks: published picks are on the public record and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- Un-publishing is not a thing. There is no override.
  IF OLD.published AND NOT NEW.published THEN
    RAISE EXCEPTION 'tracked_picks: publishing is one-way; published cannot be set back to false';
  END IF;

  -- published_at is write-once.
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'tracked_picks: published_at is immutable once set';
  END IF;

  -- A published pick's substance is frozen.
  IF OLD.published AND (
       NEW.description IS DISTINCT FROM OLD.description
    OR NEW.locked_price IS DISTINCT FROM OLD.locked_price
    OR NEW.breakeven_pct IS DISTINCT FROM OLD.breakeven_pct
    OR NEW.qualifying_metrics IS DISTINCT FROM OLD.qualifying_metrics
  ) THEN
    RAISE EXCEPTION 'tracked_picks: description, locked_price, breakeven_pct and qualifying_metrics are immutable on a published pick';
  END IF;

  -- The publish transition itself: rejected at or after first pitch,
  -- enforced here rather than in the route handler so a direct SQL
  -- publish obeys the same rule. Judgment call: a pick whose game has no
  -- known start time on file cannot prove it's before first pitch, so it
  -- cannot be published either - fail closed, not open.
  IF NOT OLD.published AND NEW.published THEN
    SELECT game_time_utc INTO g_time FROM games WHERE mlb_game_id = NEW.mlb_game_id LIMIT 1;
    IF g_time IS NULL THEN
      RAISE EXCEPTION 'tracked_picks: cannot publish pick %, no known start time for its game', NEW.id;
    END IF;
    IF now() >= g_time THEN
      RAISE EXCEPTION 'tracked_picks: cannot publish pick %, its game has already started', NEW.id;
    END IF;
    NEW.published_at := COALESCE(NEW.published_at, now());
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tracked_picks_guard_upd ON tracked_picks;
CREATE TRIGGER tracked_picks_guard_upd
  BEFORE UPDATE ON tracked_picks
  FOR EACH ROW EXECUTE FUNCTION tracked_picks_guard();

DROP TRIGGER IF EXISTS tracked_picks_guard_del ON tracked_picks;
CREATE TRIGGER tracked_picks_guard_del
  BEFORE DELETE ON tracked_picks
  FOR EACH ROW EXECUTE FUNCTION tracked_picks_guard();

-- --- email send audit log ----------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sends (
  id SERIAL PRIMARY KEY,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  admin_user_id INTEGER REFERENCES users(id),
  recipient_count INTEGER NOT NULL,
  pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  subject TEXT
);

-- --- app secrets --------------------------------------------------------------
-- Holds the HMAC secret that signs one-click unsubscribe tokens, generated
-- once and persisted so links keep working across restarts/redeploys
-- without requiring a new env var to be provisioned. An env override
-- (EMAIL_LINK_SECRET) still wins when set, see lib/emailTokens.js.
CREATE TABLE IF NOT EXISTS app_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

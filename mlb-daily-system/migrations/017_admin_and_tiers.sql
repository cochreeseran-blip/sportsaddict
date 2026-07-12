-- Admin roles + content-tier scaffolding (see lib/adminAuth.js, server.js
-- /api/admin/* routes). Structured now, gated later: PAYWALL_ENABLED
-- (server.js) stays false until there's a real subscription flow, at
-- which point `tier` starts actually restricting Research content.
--
-- migrate.js re-runs every .sql file on every boot (no migration-tracking
-- table), so everything here has to be idempotent by hand: ADD COLUMN IF
-- NOT EXISTS is native, but ADD CONSTRAINT has no IF NOT EXISTS in
-- Postgres.
--
-- JUDGMENT CALL / production bug fix: this table is shared with a legacy
-- app (see lib/auth.js's NOT-NULL-relaxation block) that already had its
-- own "role" column with a constraint also named users_role_check, whose
-- allowed values didn't include 'admin'. The original catch-duplicate_object
-- DO block silently no-opped against that name collision, so the legacy,
-- stricter constraint stayed in force and `npm run make-admin` failed with
-- "violates check constraint users_role_check". DROP + ADD forces this to
-- always converge on the definition this app actually needs, every boot,
-- instead of silently deferring to whatever got there first.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'free';

-- Updated on authenticated requests (see server.js touchLastSeen), throttled
-- to at most one write per user per hour so it isn't a write on every request.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- CAN-SPAM / deliverability: nobody is opted into marketing email without
-- an explicit, unchecked-by-default checkbox at signup (see /api/auth/signup).
-- Existing accounts default to false, nobody gets opted in retroactively.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT false;

-- The shared legacy table can contain role/tier values outside this app's
-- allow-lists. A plain ADD CONSTRAINT validates every existing row, so any
-- non-conforming legacy row makes the migration -- and therefore boot,
-- since migrate.js runs synchronously before the server binds $PORT --
-- fail with 23514.
--
-- NOT VALID is the fix, not sanitizing/overwriting legacy rows: it skips
-- the initial full-table validation scan, so pre-existing legacy values
-- are left exactly as they are (this app never owns that data and must
-- not silently rewrite it -- the other app sharing this table may depend
-- on role/tier values we don't know about). Postgres still enforces the
-- constraint on every INSERT and every UPDATE from this point forward,
-- which is all this app actually needs: our own inserts/updates (signup,
-- make-admin) always use an allowed value, so they're validated exactly
-- as before. Only pre-existing rows this app never wrote are exempted
-- from the one-time historical scan.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin')) NOT VALID;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
ALTER TABLE users ADD CONSTRAINT users_tier_check CHECK (tier IN ('free', 'member')) NOT VALID;

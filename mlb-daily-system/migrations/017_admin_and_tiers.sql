-- Admin roles + content-tier scaffolding (see lib/adminAuth.js, server.js
-- /api/admin/* routes). Structured now, gated later: PAYWALL_ENABLED
-- (server.js) stays false until there's a real subscription flow, at
-- which point `tier` starts actually restricting Research content.
--
-- migrate.js re-runs every .sql file on every boot (no migration-tracking
-- table), so everything here has to be idempotent by hand: ADD COLUMN IF
-- NOT EXISTS is native, but ADD CONSTRAINT has no IF NOT EXISTS in
-- Postgres, so the two CHECK constraints are wrapped in a catch-the-
-- duplicate DO block, same pattern as the rest of this codebase.

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

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_tier_check CHECK (tier IN ('free', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

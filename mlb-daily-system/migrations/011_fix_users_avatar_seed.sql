-- Self-heals deployments where a `users` table already existed (created
-- by an earlier version of migrations/010_users.sql, before avatar_seed
-- was added to that file) — CREATE TABLE IF NOT EXISTS silently no-ops
-- against an already-created table, so the column never landed there.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed INTEGER;

-- Backfill any pre-existing rows (there shouldn't be real accounts yet,
-- but stay safe) with a positive int32 seed derived from their id, then
-- enforce the same NOT NULL guarantee the fresh-install schema has.
-- Re-running SET NOT NULL on an already-constrained column is a no-op in
-- Postgres, so this migration file stays safe to re-apply.
UPDATE users SET avatar_seed = ((id::bigint * 2654435761) % 2147483647)::integer
WHERE avatar_seed IS NULL;
ALTER TABLE users ALTER COLUMN avatar_seed SET NOT NULL;

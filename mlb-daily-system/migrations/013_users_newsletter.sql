-- The daily email now goes to account holders (their email is on file at
-- signup) instead of a separate subscriber list. Each account carries an
-- opt-out timestamp and a token for the email's one-click unsubscribe.
-- Mirrors the self-heal in lib/auth.js ensureAuthSchema so a fresh migrate
-- and a running server agree.
ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_unsubscribed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_token TEXT;

UPDATE users SET newsletter_token = md5(random()::text || clock_timestamp()::text || id::text)
  WHERE newsletter_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_newsletter_token_uidx ON users (newsletter_token);

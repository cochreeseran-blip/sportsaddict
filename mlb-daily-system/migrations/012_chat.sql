-- Live chat: one flat room. Username and avatar_seed are snapshotted onto
-- each message so the feed renders without joining the accounts table (and
-- keeps working regardless of how that table is named or evolves).
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  username TEXT NOT NULL,
  avatar_seed INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages(id);

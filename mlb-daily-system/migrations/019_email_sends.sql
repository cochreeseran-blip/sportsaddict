-- Audit log for admin-composed marketing sends (see lib/adminEmail.js,
-- POST /api/admin/email/send). Every send gets one row: who sent it, how
-- many recipients, and which published picks were featured.
CREATE TABLE IF NOT EXISTS email_sends (
  id SERIAL PRIMARY KEY,
  sent_by INTEGER NOT NULL REFERENCES users(id),
  recipient_count INTEGER NOT NULL,
  pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

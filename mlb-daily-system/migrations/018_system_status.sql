-- Shared run status for the engine/app split.
--
-- Once the always-on engine (worker.js) is a separate process from the
-- web app (server.js), the web app can no longer read the engine's
-- in-memory "is a refresh running / when did the last run finish / what
-- warnings" state. That state moves here: the worker writes it, the web
-- app reads it for /api/status. Single row, keyed on a constant so it's
-- an upsert, never a growing table.
CREATE TABLE IF NOT EXISTS system_status (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  is_refreshing BOOLEAN NOT NULL DEFAULT false,
  refresh_started_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_run_date DATE,
  last_run_error TEXT,
  last_run_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the single row so readers always find it.
INSERT INTO system_status (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Manual "Refresh" across the engine/app split.
--
-- The web app (server.js) no longer runs the pipeline, so the customer/
-- admin "Refresh" button can't call it directly. Instead the web app
-- stamps refresh_requested_at here and the engine (worker.js) polls it,
-- runs an MLB-only refresh (never a metered odds pull), and clears it.
-- A single pending request, coalesced: repeated clicks just re-stamp the
-- same column.
ALTER TABLE system_status ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ;

// Shared run status (see migrations/018_system_status.sql). The engine
// (worker.js) writes it; the web app (server.js) reads it for
// /api/status. A single upserted row keyed on id = true.

// Mark a pipeline run as started / finished. On start we set
// is_refreshing and stamp refresh_started_at; on finish we clear those
// and record the outcome (date, error, warnings).
export async function markRefreshStarted(pool) {
  await pool.query(
    `INSERT INTO system_status (id, is_refreshing, refresh_started_at, updated_at)
     VALUES (true, true, now(), now())
     ON CONFLICT (id) DO UPDATE SET is_refreshing = true, refresh_started_at = now(), updated_at = now()`
  );
}

export async function markRefreshFinished(pool, { gameDate = null, error = null, warnings = [] } = {}) {
  await pool.query(
    `INSERT INTO system_status (id, is_refreshing, refresh_started_at, last_run_at, last_run_date, last_run_error, last_run_warnings, updated_at)
     VALUES (true, false, NULL, now(), $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       is_refreshing = false,
       refresh_started_at = NULL,
       last_run_at = now(),
       last_run_date = $1,
       last_run_error = $2,
       last_run_warnings = $3,
       updated_at = now()`,
    [gameDate, error, JSON.stringify(warnings || [])]
  );
}

// Manual-refresh signal (see migrations/019). The web app stamps a
// request; the engine consumes it. Coalesced: many clicks, one pending
// request.
export async function requestRefresh(pool) {
  await pool.query(
    `INSERT INTO system_status (id, refresh_requested_at, updated_at)
     VALUES (true, now(), now())
     ON CONFLICT (id) DO UPDATE SET refresh_requested_at = now(), updated_at = now()`
  );
}

// Atomically claim a pending refresh request: returns true if one was
// pending (and clears it), false otherwise. The engine calls this on a
// short poll and runs an MLB-only refresh when it returns true.
export async function claimRefreshRequest(pool) {
  const { rows } = await pool.query(
    `UPDATE system_status SET refresh_requested_at = NULL, updated_at = now()
     WHERE id = true AND refresh_requested_at IS NOT NULL
     RETURNING true AS claimed`
  );
  return rows.length > 0;
}

// Read the current status for /api/status. Returns a plain object with
// the same field names the old in-memory status used, so the web
// handler barely changes.
export async function readSystemStatus(pool) {
  const { rows } = await pool.query(
    `SELECT is_refreshing, refresh_started_at, last_run_at, last_run_date, last_run_error, last_run_warnings
     FROM system_status WHERE id = true`
  );
  if (!rows.length) {
    return { isRefreshing: false, refreshStartedAt: null, lastRunAt: null, lastRunDate: null, lastRunError: null, lastRunWarnings: [] };
  }
  const r = rows[0];
  return {
    isRefreshing: r.is_refreshing === true,
    refreshStartedAt: r.refresh_started_at,
    lastRunAt: r.last_run_at,
    lastRunDate: r.last_run_date ? r.last_run_date.toISOString().slice(0, 10) : null,
    lastRunError: r.last_run_error,
    lastRunWarnings: r.last_run_warnings || [],
  };
}

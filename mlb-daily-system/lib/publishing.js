// The application-layer half of the one-way publish door. The enforcement
// itself lives in the tracked_picks_immutability() trigger (migrations/
// 018_publish_tracked_picks.sql) — this file just issues the UPDATE and
// turns the trigger's Postgres exception into a clean error message for
// the admin UI. There is deliberately no unpublish/edit/delete function
// anywhere in this file, because there is no such operation.

// Every pick the pipeline generated for a date, published and unpublished.
// Ordering within moneyline is away starter's TRAILING ERA descending
// (worst arm first, "the thesis of the bet", per spec) computed from
// qualifying_metrics since that's where the filter stashed it, not a
// real column.
export async function listAlgorithmPicks(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT tp.*, g.game_time_utc, g.home_starter_name AS current_home_starter, g.away_starter_name AS current_away_starter,
            COALESCE(bh.confirmed, false) AS home_lineup_confirmed,
            COALESCE(ba.confirmed, false) AS away_lineup_confirmed
     FROM tracked_picks tp
     LEFT JOIN games g ON g.mlb_game_id = tp.mlb_game_id
     LEFT JOIN LATERAL (
       SELECT bool_or(lineup_confirmed) AS confirmed FROM batter_form
       WHERE game_date = tp.game_date AND team = g.home_team
     ) bh ON true
     LEFT JOIN LATERAL (
       SELECT bool_or(lineup_confirmed) AS confirmed FROM batter_form
       WHERE game_date = tp.game_date AND team = g.away_team
     ) ba ON true
     WHERE tp.game_date = $1
     ORDER BY tp.signal_type,
       (tp.qualifying_metrics->>'awayStarterTrailingEra')::numeric DESC NULLS LAST,
       tp.id`,
    [gameDate]
  );
  return rows.map((r) => {
    const m = r.qualifying_metrics || {};
    // "Raises a prominent warning on any pick whose... probable starter
    // has changed" (spec sec. 4): compare the SNAPSHOT this pick was
    // recorded with against the CURRENT games row, which the hourly
    // MLB-Stats-only pipeline runs keep fresh (see pipeline.js step 3b,
    // the probable-starter re-confirmation pass). No extra live fetch
    // needed here, games.home_starter_name/away_starter_name already IS
    // the live value by the time this route is called.
    const homeStarterChanged = Boolean(m.homeStarterName && r.current_home_starter && m.homeStarterName !== r.current_home_starter);
    const awayStarterChanged = Boolean(m.awayStarterName && r.current_away_starter && m.awayStarterName !== r.current_away_starter);
    return {
      id: r.id,
      gameDate: r.game_date.toISOString().slice(0, 10),
      signalType: r.signal_type,
      mlbGameId: r.mlb_game_id,
      description: r.description,
      lockedPrice: r.locked_price,
      breakevenPct: r.breakeven_pct !== null ? Number(r.breakeven_pct) : null,
      closingPrice: r.closing_price,
      clvPct: r.clv_pct !== null ? Number(r.clv_pct) : null,
      qualifyingMetrics: m,
      result: r.result,
      published: r.published,
      publishedAt: r.published_at,
      publishedBy: r.published_by,
      createdAt: r.created_at,
      gameTimeUtc: r.game_time_utc,
      gameStarted: r.game_time_utc ? new Date(r.game_time_utc) <= new Date() : null,
      homeLineupConfirmed: r.home_lineup_confirmed,
      awayLineupConfirmed: r.away_lineup_confirmed,
      warnings: [
        homeStarterChanged ? `Home starter changed: was ${m.homeStarterName}, now ${r.current_home_starter}.` : null,
        awayStarterChanged ? `Away starter changed: was ${m.awayStarterName}, now ${r.current_away_starter}.` : null,
      ].filter(Boolean),
    };
  });
}

// The one and only state-changing operation this table supports. Throws
// with the trigger's own message on any rejection (already published,
// game already started); the route handler maps that to a 409.
export async function publishPick(pool, pickId, adminUserId) {
  const { rows } = await pool.query(
    `UPDATE tracked_picks SET published = true, published_at = now(), published_by = $2
     WHERE id = $1 AND published = false
     RETURNING id, published, published_at`,
    [pickId, adminUserId]
  );
  if (rows.length) return rows[0];
  // No rows updated with no exception thrown means the WHERE clause (not
  // the trigger) excluded it: either the id doesn't exist, or it's
  // already published (a no-op update wouldn't ever hit the trigger's
  // false->true branch since published was already true, hence the
  // explicit published = false in the WHERE above catches it here
  // instead of silently no-op'ing).
  const { rows: existing } = await pool.query('SELECT published FROM tracked_picks WHERE id = $1', [pickId]);
  if (!existing.length) throw new Error('No such pick.');
  throw new Error('That pick is already published.');
}

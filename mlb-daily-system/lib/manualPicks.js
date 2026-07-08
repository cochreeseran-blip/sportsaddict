import { breakevenPct } from './breakeven.js';
import { fmtOdds } from './util/format.js';

export async function listManualPicks(pool, gameDate) {
  const { rows } = await pool.query(
    'SELECT * FROM manual_picks WHERE game_date = $1 ORDER BY id DESC',
    [gameDate]
  );
  return rows.map((r) => ({
    id: r.id,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    homeMl: r.home_ml,
    breakevenPct: breakevenPct(r.home_ml),
    reason: r.reason,
    mlbGameId: r.mlb_game_id,
  }));
}

// Best-effort match against whatever the pipeline already knows about
// today's slate, so a manually-added pick can still be auto-graded later
// (npm run grade) without you having to know the MLB gamePk yourself.
async function findMlbGameId(pool, gameDate, homeTeam, awayTeam) {
  const { rows } = await pool.query(
    'SELECT mlb_game_id FROM games WHERE game_date = $1 AND lower(home_team) = lower($2) AND lower(away_team) = lower($3) LIMIT 1',
    [gameDate, homeTeam, awayTeam]
  );
  return rows[0]?.mlb_game_id ?? null;
}

export async function addManualPick(pool, { gameDate, homeTeam, awayTeam, homeMl, reason }) {
  const mlbGameId = await findMlbGameId(pool, gameDate, homeTeam, awayTeam);
  const breakeven = breakevenPct(homeMl);

  const { rows } = await pool.query(
    `INSERT INTO manual_picks (game_date, home_team, away_team, home_ml, reason, mlb_game_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [gameDate, homeTeam, awayTeam, homeMl, reason || null, mlbGameId]
  );

  // Also lands in the permanent ledger so it gets graded and reported on
  // the same as an automated pick, just tagged as manual in its metrics.
  await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, 'moneyline', $2, $3, $4, $5, $6)`,
    [
      gameDate,
      mlbGameId,
      `${homeTeam} (${fmtOdds(homeMl)}) to beat ${awayTeam}, manual pick${reason ? `: ${reason}` : ''}`,
      homeMl,
      breakeven,
      JSON.stringify({ homeTeam, awayTeam, homeMl, breakevenPct: breakeven, manual: true, reason: reason || null }),
    ]
  );

  return { id: rows[0].id, mlbGameId };
}

export async function deleteManualPick(pool, id) {
  await pool.query('DELETE FROM manual_picks WHERE id = $1', [id]);
}

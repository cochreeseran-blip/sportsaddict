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
// Matching is forgiving: "baltimore", "Orioles", or "Baltimore Orioles"
// all find the Orioles' home game, and a matched pick adopts the
// canonical team names from the schedule (so logos resolve and grading
// is unambiguous). Falls back to what was typed if nothing matches.
async function findGame(pool, gameDate, homeTeam, awayTeam) {
  // Try both sides first, then home-only (covers a misspelled or omitted
  // opponent — the schedule fills the rest in).
  const both = await pool.query(
    `SELECT mlb_game_id, home_team, away_team FROM games
     WHERE game_date = $1
       AND lower(home_team) LIKE '%' || lower($2) || '%'
       AND lower(away_team) LIKE '%' || lower($3) || '%'
     LIMIT 1`,
    [gameDate, homeTeam, awayTeam]
  );
  if (both.rows.length) return both.rows[0];
  const homeOnly = await pool.query(
    `SELECT mlb_game_id, home_team, away_team FROM games
     WHERE game_date = $1 AND lower(home_team) LIKE '%' || lower($2) || '%'
     LIMIT 1`,
    [gameDate, homeTeam]
  );
  return homeOnly.rows[0] ?? null;
}

export async function addManualPick(pool, { gameDate, homeTeam, awayTeam, homeMl, reason }) {
  const game = await findGame(pool, gameDate, homeTeam, awayTeam);
  const mlbGameId = game?.mlb_game_id ?? null;
  if (game) {
    homeTeam = game.home_team;
    awayTeam = game.away_team;
  }
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

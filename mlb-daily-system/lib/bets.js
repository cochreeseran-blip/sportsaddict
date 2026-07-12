import * as mlb from './sources/mlbStats.js';

// Profit for a settled bet at American odds. Win on -150 for $10 returns
// $6.67 profit; win on +130 returns $13. Push/void returns 0.
export function profitFor(result, odds, stake) {
  const s = Number(stake);
  if (result === 'push') return 0;
  if (result === 'loss') return -s;
  if (result !== 'win') return null;
  if (odds === null || odds === undefined) return null; // can't price an odds-less win
  const o = Number(odds);
  return o > 0 ? (s * o) / 100 : (s * 100) / Math.abs(o);
}

const VALID_KINDS = new Set(['moneyline_home', 'batter_hit', 'batter_hr', 'manual']);
const VALID_RESULTS = new Set(['win', 'loss', 'push']);

export async function createBet(pool, b) {
  const kind = VALID_KINDS.has(b.betKind) ? b.betKind : 'manual';
  const { rows } = await pool.query(
    `INSERT INTO bets (game_date, description, odds, stake, book, bet_kind, mlb_game_id, batter_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      b.gameDate,
      b.description,
      b.odds ?? null,
      b.stake,
      b.book || null,
      kind,
      b.mlbGameId ?? null,
      b.batterId ?? null,
    ]
  );
  return rows[0];
}

export async function settleBet(pool, id, result) {
  if (!VALID_RESULTS.has(result)) throw new Error(`bad result: ${result}`);
  const { rows } = await pool.query('SELECT * FROM bets WHERE id = $1', [id]);
  if (!rows.length) return null;
  const bet = rows[0];
  const profit = profitFor(result, bet.odds, bet.stake);
  const { rows: updated } = await pool.query(
    `UPDATE bets SET result = $1, profit = $2, settled_at = now() WHERE id = $3 RETURNING *`,
    [result, profit, id]
  );
  return updated[0];
}

export async function reopenBet(pool, id) {
  const { rows } = await pool.query(
    `UPDATE bets SET result = 'pending', profit = NULL, settled_at = NULL WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

export async function deleteBet(pool, id) {
  const { rowCount } = await pool.query('DELETE FROM bets WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function listBets(pool) {
  const { rows } = await pool.query('SELECT * FROM bets ORDER BY game_date DESC, id DESC LIMIT 500');
  const bets = rows.map((r) => ({
    id: r.id,
    gameDate: r.game_date.toISOString().slice(0, 10),
    description: r.description,
    odds: r.odds,
    stake: Number(r.stake),
    book: r.book,
    betKind: r.bet_kind,
    mlbGameId: r.mlb_game_id,
    batterId: r.batter_id,
    result: r.result,
    profit: r.profit !== null ? Number(r.profit) : null,
    settledAt: r.settled_at,
  }));

  const settled = bets.filter((b) => b.result !== 'pending');
  const wins = settled.filter((b) => b.result === 'win').length;
  const losses = settled.filter((b) => b.result === 'loss').length;
  const pushes = settled.filter((b) => b.result === 'push').length;
  const profit = settled.reduce((sum, b) => sum + (b.profit ?? 0), 0);
  const staked = settled.reduce((sum, b) => sum + b.stake, 0);

  return {
    bets,
    summary: {
      profit,
      staked,
      roi: staked > 0 ? profit / staked : null,
      wins,
      losses,
      pushes,
      pending: bets.length - settled.length,
    },
  };
}

// Grades one auto-gradable pending bet against real results. Returns
// 'win' | 'loss' | 'push', or null if the game isn't final yet (or the
// bet can't be auto-graded).
async function gradeOneBet(bet) {
  if (bet.bet_kind === 'manual' || !bet.mlb_game_id) return null;
  const result = await mlb.fetchGameResult(bet.mlb_game_id);
  if (!result || !result.isFinal) return null;

  if (bet.bet_kind === 'moneyline_home') {
    if (result.homeScore === null || result.awayScore === null) return null;
    if (result.homeScore === result.awayScore) return 'push';
    return result.homeScore > result.awayScore ? 'win' : 'loss';
  }

  if (bet.bet_kind === 'batter_hit' || bet.bet_kind === 'batter_hr') {
    if (!bet.batter_id) return null;
    const season = String(bet.game_date).slice(0, 4);
    const log = await mlb.fetchBatterGameLog(bet.batter_id, season);
    const dateStr = new Date(bet.game_date).toISOString().slice(0, 10);
    const split = log.find((s) => (s.date || '').slice(0, 10) === dateStr);
    // Final game + no logged appearance counts as a loss for "to get a
    // hit"/"to homer", same convention as the signal ledger.
    const hits = Number(split?.stat?.hits ?? 0);
    const homeRuns = Number(split?.stat?.homeRuns ?? 0);
    return bet.bet_kind === 'batter_hit' ? (hits >= 1 ? 'win' : 'loss') : (homeRuns >= 1 ? 'win' : 'loss');
  }

  return null;
}

export async function gradePendingBets(pool) {
  const { rows: pending } = await pool.query(
    `SELECT * FROM bets WHERE result = 'pending' AND bet_kind != 'manual'`
  );
  let graded = 0;
  for (const bet of pending) {
    try {
      const outcome = await gradeOneBet(bet);
      if (!outcome) continue;
      await pool.query(
        `UPDATE bets SET result = $1, profit = $2, settled_at = now() WHERE id = $3`,
        [outcome, profitFor(outcome, bet.odds, bet.stake), bet.id]
      );
      graded++;
    } catch (err) {
      console.warn(`  Bet grading failed for #${bet.id} (${bet.description}): ${err.message}`);
    }
  }
  return { checked: pending.length, graded };
}

import * as mlb from './sources/mlbStats.js';

async function insertTrackedPick(pool, record) {
  await pool.query(
    `INSERT INTO tracked_picks
       (game_date, signal_type, mlb_game_id, description, locked_price, breakeven_pct, qualifying_metrics)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      record.gameDate,
      record.signalType,
      record.mlbGameId,
      record.description,
      record.lockedPrice,
      record.breakevenPct,
      JSON.stringify(record.qualifyingMetrics),
    ]
  );
}


// The Daily Slate publishes ONE official moneyline per day: the single
// best-graded qualifier. That one pick is what the public W-L record
// tracks, not every game that ever cleared the gate, so the record
// reflects the call we actually made, not a pile of also-rans. Candidates
// arrive already sorted best-first (see lib/filters/moneyline.js). This
// runs only BEFORE the board locks at go-live (the pipeline skips it
// after), and before go-live no game has started, so clearing and
// re-writing the day's single moneyline row can never drop a real result:
// it just keeps "today's pick" pointed at the current best until it
// freezes. Idempotent, exactly one moneyline row per day.
export async function recordBestMoneyline(pool, gameDate, candidates) {
  const best = (candidates || [])[0] || null;
  const { rows: existing } = await pool.query(
    `SELECT id, mlb_game_id, result FROM tracked_picks
     WHERE game_date = $1 AND signal_type = 'moneyline' ORDER BY id`,
    [gameDate]
  );
  // If the current best is already the locked-in pick, leave it untouched
  // (don't churn created_at / the row).
  if (best && existing.length === 1 && String(existing[0].mlb_game_id) === String(best.mlbGameId)) {
    return 0;
  }
  // Never delete a row that already graded (belt-and-suspenders: shouldn't
  // happen pre-lock, but if it somehow did we keep the graded history).
  if (existing.some((r) => r.result && r.result !== 'pending')) return 0;
  await pool.query(`DELETE FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline'`, [gameDate]);
  if (!best) return 0;
  await insertTrackedPick(pool, {
    gameDate,
    signalType: 'moneyline',
    mlbGameId: best.mlbGameId,
    description: `${best.headline}. ${best.detail}`,
    lockedPrice: best.homeMl ?? null,
    breakevenPct: best.breakevenPct ?? null,
    qualifyingMetrics: best,
  });
  return 1;
}

// Grades a single pending pick against real results, or returns null if
// the underlying game isn't final yet (still legitimately pending).
async function gradeOnePick(pick) {
  if (!pick.mlb_game_id) return null;
  const result = await mlb.fetchGameResult(pick.mlb_game_id);
  if (!result || !result.isFinal) return null;

  if (pick.signal_type === 'moneyline') {
    if (result.homeScore === null || result.awayScore === null) return null;
    if (result.homeScore === result.awayScore) return 'push'; // essentially never happens in MLB, but handled
    // The moneyline filter only ever picks the home team, by construction.
    return result.homeScore > result.awayScore ? 'win' : 'loss';
  }

  if (pick.signal_type === 'hit_streak' || pick.signal_type === 'wind_hr') {
    const batterId = pick.qualifying_metrics?.batterId;
    if (!batterId) return null; // picks recorded before batterId was tracked
    const season = String(pick.game_date).slice(0, 4);
    const log = await mlb.fetchBatterGameLog(batterId, season);
    const pickDateStr = new Date(pick.game_date).toISOString().slice(0, 10);
    const split = log.find((s) => (s.date || '').slice(0, 10) === pickDateStr);
    // Game is final and the batter has no logged plate appearance that day
    // (didn't play, or was subbed out before recording a stat), that's a
    // loss for "gets a hit" / "goes deep" purposes, not still-pending.
    const hits = Number(split?.stat?.hits ?? 0);
    const homeRuns = Number(split?.stat?.homeRuns ?? 0);
    return pick.signal_type === 'hit_streak' ? (hits >= 1 ? 'win' : 'loss') : (homeRuns >= 1 ? 'win' : 'loss');
  }

  return null;
}

export async function gradePendingPicks(pool) {
  const { rows: pending } = await pool.query(`SELECT * FROM tracked_picks WHERE result = 'pending'`);
  let graded = 0;
  let stillPending = 0;
  let errors = 0;
  for (const pick of pending) {
    try {
      const outcome = await gradeOnePick(pick);
      if (outcome === null) {
        stillPending++;
        continue;
      }
      await pool.query('UPDATE tracked_picks SET result = $1 WHERE id = $2', [outcome, pick.id]);
      graded++;
    } catch (err) {
      console.warn(`  Grading failed for pick #${pick.id} (${pick.description}): ${err.message}`);
      errors++;
    }
  }
  return { total: pending.length, graded, stillPending, errors };
}

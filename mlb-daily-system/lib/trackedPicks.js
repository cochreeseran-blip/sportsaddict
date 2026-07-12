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

// This is "the algorithm's untouched dataset" (see the admin-dashboard
// build notes): every game that qualifies for the moneyline board gets a
// row here, published=false, on the FIRST pipeline run that saw it
// qualify that day. It is never updated and never deleted by later runs,
// only inserted once per (game_date, mlb_game_id) — the trigger in
// migrations/018_publish_tracked_picks.sql would block editing a
// published row anyway, but this function doesn't touch unpublished rows
// either, on purpose: the metrics recorded here are a snapshot of what
// the algorithm said at the moment it first qualified, not a rolling
// live view. If a starter changes or a lineup posts after that snapshot,
// that shows up as a WARNING on the admin slate review (computed live,
// by comparing this frozen snapshot against a fresh MLB Stats API read),
// not as a silent rewrite of the algorithm's original call.
//
// This deliberately does NOT decide which one is "the" free pick or cap
// how many rows get written — every qualifier is recorded. Selecting the
// single free-tier pick (highest away-starter trailing ERA) and deciding
// whether to publish it at all is entirely an editorial call the admin
// makes on /admin/slate; the pipeline's only job here is to make sure
// every game that ever qualified is on file to be reviewed.
export async function recordAllQualifyingMoneyline(pool, gameDate, candidates) {
  let inserted = 0;
  for (const p of candidates || []) {
    if (!p.mlbGameId) continue;
    const { rows } = await pool.query(
      `SELECT id FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline' AND mlb_game_id = $2 LIMIT 1`,
      [gameDate, p.mlbGameId]
    );
    if (rows.length) continue;
    await insertTrackedPick(pool, {
      gameDate,
      signalType: 'moneyline',
      mlbGameId: p.mlbGameId,
      description: `${p.headline}. ${p.detail}`,
      lockedPrice: p.homeMl ?? null,
      breakevenPct: p.breakevenPct ?? null,
      qualifyingMetrics: p,
    });
    inserted++;
  }
  return inserted;
}

// Grades a single pending pick against real results, or returns null if
// the underlying game isn't final yet (still legitimately pending). This
// writes ONLY the `result` column, which the trigger allows on a
// published row (see migrations/018), so grading never has to care
// whether a pick is published or not.
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

// Grades EVERY pending pick, published or not — the point of the dual
// public record (/record) is that the algorithm's whole dataset gets
// graded, not just what got published, otherwise there's no way to ever
// check whether the filter itself works.
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

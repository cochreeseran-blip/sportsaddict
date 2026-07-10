import * as mlb from './sources/mlbStats.js';

// A pick's identity within a day: signal type + game + the player it's
// about (batter for hit props, pitcher for K props, nobody for
// moneyline). Two starters in the same game can both have a K pick, so
// pitcherName participates in the dedupe alongside batterName.
async function alreadyTracked(pool, gameDate, signalType, mlbGameId, batterName, pitcherName) {
  const { rows } = await pool.query(
    `SELECT id FROM tracked_picks
     WHERE game_date = $1 AND signal_type = $2
       AND mlb_game_id IS NOT DISTINCT FROM $3
       AND (qualifying_metrics->>'batterName') IS NOT DISTINCT FROM $4
       AND (qualifying_metrics->>'pitcherName') IS NOT DISTINCT FROM $5
     LIMIT 1`,
    [gameDate, signalType, mlbGameId, batterName, pitcherName]
  );
  return rows.length > 0;
}

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

// Writes the day's qualifying picks (every signal type: moneyline calls,
// the surfaced hit props, the surfaced K props) into the permanent
// ledger with published = false. This is the algorithm's untouched
// dataset: it happens automatically on every pipeline run and is never
// filtered by admin choice, so the filters themselves stay measurable
// independent of the admin's judgment. An admin may later flip a row to
// published (one-way, enforced by a DB trigger, see migrations/017);
// nothing about that changes what got recorded here.
//
// Idempotent per (game_date, signal_type, game, batter, pitcher) so
// hourly runs don't duplicate rows: the price/metrics from the FIRST
// time a pick qualified that day are what get locked in.
export async function recordTrackedPicks(pool, gameDate, picks) {
  let inserted = 0;
  for (const p of picks || []) {
    const batterName = p.batterName ?? null;
    const pitcherName = p.pitcherName ?? null;
    if (await alreadyTracked(pool, gameDate, p.type, p.mlbGameId, batterName, pitcherName)) continue;
    await insertTrackedPick(pool, {
      gameDate,
      signalType: p.type,
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

  if (pick.signal_type === 'strikeout') {
    // "Over N.5 strikeouts" against the pitcher's actual K count that
    // day, from his own game log. A final game with no logged start for
    // him (scratched after the pick) grades as a loss for the over, the
    // same didn't-play convention as the batter props above.
    const pitcherId = pick.qualifying_metrics?.pitcherId;
    const line = Number(pick.qualifying_metrics?.suggestedLine);
    if (!pitcherId || !Number.isFinite(line)) return null;
    const season = String(pick.game_date).slice(0, 4);
    const log = await mlb.fetchPitcherGameLog(pitcherId, season);
    const pickDateStr = new Date(pick.game_date).toISOString().slice(0, 10);
    const split = (log || []).find((s) => (s.date || '').slice(0, 10) === pickDateStr);
    const ks = Number(split?.stat?.strikeOuts ?? 0);
    return ks > line ? 'win' : 'loss';
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

// The publish transition. The only mutation the admin API performs on
// tracked_picks, and the only one the DB trigger permits: published
// false -> true, before first pitch, once. Everything that could go
// wrong (already published, game started, no known start time, row
// missing) surfaces as a clear error string for the route to relay.
export async function publishPick(pool, pickId, adminUserId) {
  try {
    const { rows } = await pool.query(
      `UPDATE tracked_picks
       SET published = true, published_by = $2
       WHERE id = $1 AND published = false
       RETURNING id, game_date, signal_type, description, published, published_at, published_by`,
      [pickId, adminUserId]
    );
    if (!rows.length) {
      // Either no such row, or it's already published (the WHERE filtered
      // it out). Tell those apart for a useful message.
      const { rows: existing } = await pool.query('SELECT published FROM tracked_picks WHERE id = $1', [pickId]);
      if (!existing.length) return { ok: false, error: 'No such pick.' };
      return { ok: false, error: 'Already published. Publishing is permanent, there is nothing further to do.' };
    }
    return { ok: true, pick: rows[0] };
  } catch (err) {
    // Trigger rejections (game already started, no known start time)
    // arrive here as plain Postgres exceptions.
    return { ok: false, error: err.message.replace(/^tracked_picks:\s*/, '') };
  }
}

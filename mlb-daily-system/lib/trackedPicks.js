import * as mlb from './sources/mlbStats.js';
import { fmtOdds } from './util/format.js';

async function alreadyTracked(pool, gameDate, signalType, mlbGameId, batterName) {
  const { rows } = await pool.query(
    `SELECT id FROM tracked_picks
     WHERE game_date = $1 AND signal_type = $2
       AND mlb_game_id IS NOT DISTINCT FROM $3
       AND (qualifying_metrics->>'batterName') IS NOT DISTINCT FROM $4
     LIMIT 1`,
    [gameDate, signalType, mlbGameId, batterName]
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

// Writes every qualifying pick from all three filters into the permanent
// ledger. Idempotent per (game_date, signal_type, mlb_game_id, batter) so
// running the pipeline 3x/day (or on manual refresh) doesn't spam
// duplicate rows for the same underlying pick — the price/metrics from
// the FIRST time a pick qualified that day are what get "locked in",
// same as if you'd actually placed the bet then.
export async function recordTrackedPicks(pool, gameDate, { moneyline, hitStreak, windHr }) {
  let inserted = 0;

  for (const p of moneyline?.picks || []) {
    if (await alreadyTracked(pool, gameDate, 'moneyline', p.mlbGameId, null)) continue;
    await insertTrackedPick(pool, {
      gameDate,
      signalType: 'moneyline',
      mlbGameId: p.mlbGameId,
      description: `${p.homeTeam} (${fmtOdds(p.homeMl)}) to beat ${p.awayTeam} — ${p.homeStarterName ?? 'home starter'} (ERA ${(p.homeStarterTrailingEra ?? p.homeStarterSeasonEra)?.toFixed(2) ?? 'n/a'}) over ${p.awayStarterName ?? 'visitor'} (${(p.awayStarterTrailingEra ?? p.awayStarterSeasonEra)?.toFixed(2) ?? 'n/a'})`,
      lockedPrice: p.homeMl,
      breakevenPct: p.breakevenPct,
      qualifyingMetrics: p,
    });
    inserted++;
  }

  for (const b of hitStreak?.watchList || []) {
    if (await alreadyTracked(pool, gameDate, 'hit_streak', b.mlbGameId, b.batterName)) continue;
    await insertTrackedPick(pool, {
      gameDate,
      signalType: 'hit_streak',
      mlbGameId: b.mlbGameId,
      description: `${b.batterName} (${b.team}) to get a hit — streak ${b.hitStreak}, avg ${b.trailing15Avg?.toFixed(3) ?? 'n/a'}, vs ${b.opposingStarterName ?? 'TBD'} (ERA ${b.opposingStarterTrailingEra?.toFixed(2) ?? 'n/a'})`,
      lockedPrice: null,
      breakevenPct: null, // not applicable — this isn't a fixed-odds pick
      qualifyingMetrics: b,
    });
    inserted++;
  }

  for (const b of windHr?.watchList || []) {
    if (await alreadyTracked(pool, gameDate, 'wind_hr', b.mlbGameId, b.batterName)) continue;
    await insertTrackedPick(pool, {
      gameDate,
      signalType: 'wind_hr',
      mlbGameId: b.mlbGameId,
      description: `${b.batterName} (${b.team}) to go deep — HR rate ${b.trailing15HrRate?.toFixed(3) ?? 'n/a'}, wind ${b.windSpeedMph?.toFixed(1) ?? 'n/a'} mph out at ${b.venue}, vs ${b.opposingStarterName ?? 'TBD'} (ERA ${b.opposingStarterTrailingEra?.toFixed(2) ?? 'n/a'})`,
      lockedPrice: null,
      breakevenPct: null,
      qualifyingMetrics: b,
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
    // (didn't play, or was subbed out before recording a stat) — that's a
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

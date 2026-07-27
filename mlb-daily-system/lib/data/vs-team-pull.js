// Batter-vs-team history.
//
// scoreHitProp has read batter_vs_team_history since it was written, but
// nothing ever populated the table, so that factor has been scoring a flat
// zero for every batter on every board. This is the pull that makes it
// real.
//
// WHY VS-TEAM AND NOT VS-PITCHER: batter-vs-specific-pitcher is the split
// everyone reaches for and it is almost always noise -- most batters have
// well under 20 plate appearances against any given starter, which is a
// sample that tells you nothing and will happily show a 1.000 average off
// two swings. Vs-TEAM accumulates across every arm on a roster over years,
// so it actually reaches a usable sample, and it is already gated at 20+
// PA in the scorer. That gate is why this pulls MLB's `vsTeamTotal`
// (career) rather than the per-season variant, which resets every April.
//
// TWO SOURCES, ONE TABLE:
//   1. MLB Stats API vsTeamTotal -- true career numbers, the primary.
//   2. Local batter_game_logs -- derived, the fallback when the API is
//      unreachable. Narrower (only the seasons whose logs we hold) and
//      labelled as such, but it means the factor degrades to "less
//      history" rather than back to zero.
//
// Career totals move by at most a handful of at-bats a day, so rows are
// refreshed on a staleness window rather than every morning. A full slate
// is ~250 batters; without the window that would be 250 API calls a day
// for data that barely changes.

import { fetchBatterVsTeam } from '../sources/mlbStats.js';
import { teamAbbr, teamIdFromAbbr } from '../util/teamAbbr.js';

const STALE_AFTER_DAYS = 7;
const CONCURRENCY = 4;

// Runs `worker` over `items`, at most `limit` in flight. The MLB API is
// not rate-limit documented; four at a time has been the safe ceiling used
// by the other pulls in this directory.
async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results.push(await worker(items[i]));
      } catch (err) {
        results.push({ ok: false, error: err.message });
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// (batter, opponent) pairs for a slate: every batter with form on that
// date, paired with the team they are actually facing.
export async function vsTeamPairsForDate(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT bf.batter_id, bf.batter_name, bf.team,
            CASE WHEN g.home_team = bf.team THEN g.away_team ELSE g.home_team END AS opponent
       FROM batter_form bf
       JOIN games g ON g.game_date = bf.game_date
                   AND (g.home_team = bf.team OR g.away_team = bf.team)
      WHERE bf.game_date = $1`,
    [gameDate]
  );
  return rows
    .map((r) => ({
      batterId: r.batter_id,
      batterName: r.batter_name,
      opponent: r.opponent,
      opponentAbbr: teamAbbr(r.opponent),
    }))
    .filter((r) => r.opponentAbbr);
}

// Which pairs actually need a refresh: never pulled, or older than the
// staleness window.
async function stalePairs(pool, pairs) {
  if (!pairs.length) return [];
  const { rows } = await pool.query(
    `SELECT batter_id, opponent_abbr FROM batter_vs_team_history
      WHERE batter_id = ANY($1)
        AND last_updated IS NOT NULL
        AND last_updated > (CURRENT_DATE - $2::int)`,
    [pairs.map((p) => p.batterId), STALE_AFTER_DAYS]
  );
  const fresh = new Set(rows.map((r) => `${r.batter_id}:${r.opponent_abbr}`));
  return pairs.filter((p) => !fresh.has(`${p.batterId}:${p.opponentAbbr}`));
}

async function upsert(pool, row) {
  await pool.query(
    `INSERT INTO batter_vs_team_history
       (batter_id, batter_name, opponent_abbr, total_pa, total_ab, total_hits, total_hr, total_k, batting_avg, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE)
     ON CONFLICT (batter_id, opponent_abbr) DO UPDATE SET
       batter_name = EXCLUDED.batter_name,
       total_pa    = EXCLUDED.total_pa,
       total_ab    = EXCLUDED.total_ab,
       total_hits  = EXCLUDED.total_hits,
       total_hr    = EXCLUDED.total_hr,
       total_k     = EXCLUDED.total_k,
       batting_avg = EXCLUDED.batting_avg,
       last_updated = CURRENT_DATE`,
    [row.batterId, row.batterName, row.opponentAbbr, row.totalPa, row.totalAb,
      row.totalHits, row.totalHr, row.totalK, row.battingAvg]
  );
}

// Fallback source: aggregate the game logs already on disk. Narrower than
// career (only the seasons we hold logs for) but it needs no network, and
// a smaller true sample still beats a silent zero.
export async function deriveVsTeamFromLogs(pool, pairs) {
  if (!pairs.length) return 0;
  const { rows } = await pool.query(
    `SELECT player_id, player_name, opponent_abbr,
            sum(at_bats)::int    AS ab,
            sum(hits)::int       AS hits,
            sum(home_runs)::int  AS hr,
            sum(strikeouts)::int AS k
       FROM batter_game_logs
      WHERE player_id = ANY($1)
      GROUP BY player_id, player_name, opponent_abbr`,
    [pairs.map((p) => p.batterId)]
  );
  const want = new Set(pairs.map((p) => `${p.batterId}:${p.opponentAbbr}`));
  let written = 0;
  for (const r of rows) {
    if (!want.has(`${r.player_id}:${r.opponent_abbr}`)) continue;
    if (!r.ab) continue;
    await upsert(pool, {
      batterId: r.player_id,
      batterName: r.player_name,
      opponentAbbr: r.opponent_abbr,
      // No PA column in the logs; at-bats is the conservative stand-in,
      // which under-counts (walks are excluded) and so can only make the
      // 20-PA gate harder to clear, never easier.
      totalPa: r.ab,
      totalAb: r.ab,
      totalHits: r.hits ?? 0,
      totalHr: r.hr ?? 0,
      totalK: r.k ?? 0,
      battingAvg: Number((r.hits / r.ab).toFixed(3)),
    });
    written++;
  }
  return written;
}

// The pull. Returns a summary rather than throwing on partial failure: a
// slate where 30 of 250 lookups 404 should still write the other 220.
export async function pullVsTeamHistory(pool, gameDate, opts = {}) {
  const all = await vsTeamPairsForDate(pool, gameDate);
  const pairs = opts.force ? all : await stalePairs(pool, all);
  if (!pairs.length) {
    return { pairs: all.length, refreshed: 0, written: 0, source: 'cache', errors: [] };
  }

  const errors = [];
  let written = 0;

  const results = await mapLimit(pairs, CONCURRENCY, async (p) => {
    const teamId = teamIdFromAbbr(p.opponentAbbr);
    if (!teamId) return { ok: false, error: `no team id for ${p.opponentAbbr}` };
    const split = await fetchBatterVsTeam(p.batterId, teamId);
    if (!split) {
      // Genuinely never faced them: record the zero so the staleness
      // window stops us re-asking every single day.
      await upsert(pool, {
        batterId: p.batterId, batterName: p.batterName, opponentAbbr: p.opponentAbbr,
        totalPa: 0, totalAb: 0, totalHits: 0, totalHr: 0, totalK: 0, battingAvg: null,
      });
      return { ok: true, empty: true };
    }
    await upsert(pool, {
      batterId: p.batterId,
      batterName: p.batterName,
      opponentAbbr: p.opponentAbbr,
      totalPa: split.plateAppearances,
      totalAb: split.atBats,
      totalHits: split.hits,
      totalHr: split.homeRuns,
      totalK: split.strikeOuts,
      battingAvg: split.battingAvg,
    });
    return { ok: true };
  });

  for (const r of results) {
    if (r.ok) written++;
    else errors.push(r.error);
  }

  // Every lookup failed: almost always the API being unreachable rather
  // than 250 individually bad batters. Fall back to the local logs so the
  // factor still has something behind it, and say which source was used.
  if (written === 0 && errors.length) {
    const derived = await deriveVsTeamFromLogs(pool, pairs);
    return {
      pairs: all.length, refreshed: pairs.length, written: derived,
      source: 'game-logs (API unreachable)', errors: errors.slice(0, 3),
    };
  }

  return {
    pairs: all.length, refreshed: pairs.length, written,
    source: 'mlb-api', errors: errors.slice(0, 3),
  };
}

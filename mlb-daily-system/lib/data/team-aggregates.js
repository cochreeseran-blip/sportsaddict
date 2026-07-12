// Recomputes team-level batting aggregates and batter-vs-team history from
// the stored game logs (batter_game_logs). Both are derived tables, always
// safe to fully recompute -- no incremental/delta logic, since the input
// data volume (one season's logs) is small enough to aggregate in one
// query and idempotency matters more here than micro-optimizing writes.
//
// JUDGMENT CALL: plate appearances aren't stored directly (MLB's gameLog
// stat block doesn't cleanly expose HBP/sac-fly splits in the fields this
// app already pulls), so PA is approximated as at-bats + walks. That
// undercounts true PA by HBP/SF/catcher's-interference, which are rare
// enough relative to AB+BB that this is a reasonable stand-in for a K-rate
// denominator, not a precise official PA. Documented here so nobody
// mistakes team_k_pct for the official stat.

export async function recalcTeamBattingAggregates(pool, season, calcDate) {
  const { rows } = await pool.query(
    `SELECT team_abbr,
            sum(at_bats) AS ab, sum(hits) AS hits, sum(walks) AS bb,
            sum(strikeouts) AS k, sum(doubles) AS doubles, sum(triples) AS triples,
            sum(home_runs) AS hr, count(DISTINCT game_pk) AS games
       FROM batter_game_logs
      WHERE team_abbr IS NOT NULL
        AND extract(year FROM game_date) = $1
      GROUP BY team_abbr`,
    [season]
  );

  let written = 0;
  for (const r of rows) {
    const ab = Number(r.ab) || 0;
    const bb = Number(r.bb) || 0;
    const hits = Number(r.hits) || 0;
    const k = Number(r.k) || 0;
    const doubles = Number(r.doubles) || 0;
    const triples = Number(r.triples) || 0;
    const hr = Number(r.hr) || 0;
    const pa = ab + bb;
    const singles = Math.max(0, hits - doubles - triples - hr);
    const totalBases = singles + doubles * 2 + triples * 3 + hr * 4;

    await pool.query(
      `INSERT INTO team_batting_aggregates
         (team_abbr, season, calc_date, team_k_pct, team_ba, team_obp, team_slg, games_played)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (team_abbr, calc_date) DO UPDATE SET
         team_k_pct = EXCLUDED.team_k_pct, team_ba = EXCLUDED.team_ba,
         team_obp = EXCLUDED.team_obp, team_slg = EXCLUDED.team_slg,
         games_played = EXCLUDED.games_played`,
      [
        r.team_abbr, season, calcDate,
        pa > 0 ? round2(100 * (k / pa)) : null,
        ab > 0 ? round3(hits / ab) : null,
        pa > 0 ? round3((hits + bb) / pa) : null,
        ab > 0 ? round3(totalBases / ab) : null,
        Number(r.games) || 0,
      ]
    );
    written++;
  }
  return { written };
}

export async function recalcBatterVsTeamHistory(pool, calcDate) {
  const { rows } = await pool.query(
    `SELECT player_id, max(player_name) AS player_name, opponent_abbr,
            sum(at_bats) AS ab, sum(walks) AS bb, sum(hits) AS hits,
            sum(home_runs) AS hr, sum(strikeouts) AS k
       FROM batter_game_logs
      WHERE opponent_abbr IS NOT NULL
      GROUP BY player_id, opponent_abbr`
  );

  let written = 0;
  for (const r of rows) {
    const ab = Number(r.ab) || 0;
    const bb = Number(r.bb) || 0;
    const hits = Number(r.hits) || 0;
    const pa = ab + bb;
    await pool.query(
      `INSERT INTO batter_vs_team_history
         (batter_id, batter_name, opponent_abbr, total_pa, total_ab, total_hits, total_hr, total_k, batting_avg, last_updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (batter_id, opponent_abbr) DO UPDATE SET
         batter_name = EXCLUDED.batter_name, total_pa = EXCLUDED.total_pa,
         total_ab = EXCLUDED.total_ab, total_hits = EXCLUDED.total_hits,
         total_hr = EXCLUDED.total_hr, total_k = EXCLUDED.total_k,
         batting_avg = EXCLUDED.batting_avg, last_updated = EXCLUDED.last_updated`,
      [
        r.player_id, r.player_name, r.opponent_abbr, pa, ab, hits,
        Number(r.hr) || 0, Number(r.k) || 0,
        ab > 0 ? round3(hits / ab) : null, calcDate,
      ]
    );
    written++;
  }
  return { written };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

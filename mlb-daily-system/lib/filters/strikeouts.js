import { scoreStrikeoutProp, MIN_SURFACE_SCORE } from '../grading.js';
import { teamAbbr } from '../util/teamAbbr.js';

const MIN_STARTS = 4;
const MIN_FLOOR_KS = 4;

// The largest whole-strikeout count the pitcher has reached in at least
// hitsNeeded of his recent starts. That count minus 0.5 is the highest
// over line his own recent form says he clears reliably - the "floor".
// Example: last 5 starts of 7, 5, 8, 6, 9 Ks reach 5+ in all 5 starts,
// so the floor is 5 and the suggested line is over 4.5.
function consistentFloor(ks, hitsNeeded) {
  const sorted = [...ks].sort((a, b) => b - a);
  if (sorted.length < hitsNeeded) return null;
  return sorted[hitsNeeded - 1];
}

// Today's probable starters whose recent strikeout counts have a high,
// consistent floor, scored against how strikeout-prone the OPPOSING
// lineup actually is (see lib/grading.js scoreStrikeoutProp). This is
// still form-only research: it does not know the actual book line, so it
// says "his last 5 starts + this matchup support over N.5", not "bet it".
export async function runStrikeoutFilter(pool, gameDate) {
  const { rows: games } = await pool.query(
    'SELECT mlb_game_id, home_team, away_team, home_starter_id, home_starter_name, away_starter_id, away_starter_name FROM games WHERE game_date = $1',
    [gameDate]
  );

  const starters = [];
  for (const g of games) {
    if (g.home_starter_id) {
      starters.push({ pitcherId: g.home_starter_id, pitcherName: g.home_starter_name, team: g.home_team, opponent: g.away_team, mlbGameId: g.mlb_game_id, isHome: true });
    }
    if (g.away_starter_id) {
      starters.push({ pitcherId: g.away_starter_id, pitcherName: g.away_starter_name, team: g.away_team, opponent: g.home_team, mlbGameId: g.mlb_game_id, isHome: false });
    }
  }
  if (!starters.length) return { watchList: [] };

  const { rows: forms } = await pool.query(
    `SELECT pitcher_id, pitcher_name, last5_start_ks, trailing_k_per_start, trailing_era,
            savant_era, savant_xera, savant_k_pct, savant_bb_pct, savant_whiff_pct, savant_hard_hit_pct
     FROM pitcher_form WHERE game_date = $1 AND pitcher_id = ANY($2)`,
    [gameDate, starters.map((s) => s.pitcherId)]
  );
  const formById = new Map(forms.map((f) => [f.pitcher_id, f]));
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);

  // Opposing team's strikeout rate: the key addition per the corrected
  // logic. Most recent team_batting_aggregates row for that team this
  // season -- the table is recalculated daily by lib/data/team-aggregates.js,
  // so "most recent" is effectively "as of today or the last successful
  // recalc". Missing entirely (e.g. backfill hasn't run yet) degrades to
  // null, which scoreStrikeoutProp treats as neutral (no bonus, no
  // penalty), not a crash.
  const season = Number(String(gameDate).slice(0, 4));
  const opponentAbbrs = [...new Set(starters.map((s) => teamAbbr(s.opponent)).filter(Boolean))];
  const teamKPctByAbbr = new Map();
  if (opponentAbbrs.length) {
    const { rows: aggRows } = await pool.query(
      `SELECT DISTINCT ON (team_abbr) team_abbr, team_k_pct
         FROM team_batting_aggregates
        WHERE team_abbr = ANY($1) AND season = $2
        ORDER BY team_abbr, calc_date DESC`,
      [opponentAbbrs, season]
    );
    for (const r of aggRows) teamKPctByAbbr.set(r.team_abbr, r.team_k_pct !== null ? Number(r.team_k_pct) : null);
  }

  const scored = [];
  for (const s of starters) {
    const form = formById.get(s.pitcherId);
    const ks = Array.isArray(form?.last5_start_ks) ? form.last5_start_ks.map(Number) : [];
    if (ks.length < MIN_STARTS) continue;

    // Floor across all recent starts, and the softer floor that allows
    // one dud. The strict floor is the headline; the softer one shows how
    // much room there is above it.
    const strictFloor = consistentFloor(ks, ks.length);
    const softFloor = consistentFloor(ks, Math.max(1, ks.length - 1));
    if (strictFloor === null || strictFloor < MIN_FLOOR_KS) continue;

    const suggestedLine = strictFloor - 0.5;
    const kPerStart = form.trailing_k_per_start !== null ? Number(form.trailing_k_per_start) : null;
    const trailingEra = form.trailing_era !== null && form.trailing_era !== undefined ? Number(form.trailing_era) : null;
    const opposingTeamKPct = teamKPctByAbbr.get(teamAbbr(s.opponent)) ?? null;

    const graded = scoreStrikeoutProp({
      strictFloorKs: strictFloor,
      softFloorKs: softFloor,
      pitcherKPct: num(form.savant_k_pct),
      opposingTeamKPct,
      pitcherWhiffPct: num(form.savant_whiff_pct),
      kPerStart,
      last5StartKs: ks,
    });
    // Below the surface floor: not a pick, dropped entirely per spec
    // ("Below 40 = not surfaced").
    if (!graded.surfaced) continue;

    scored.push({
      mlbGameId: s.mlbGameId,
      pitcherId: s.pitcherId,
      pitcherName: form.pitcher_name ?? s.pitcherName,
      team: s.team,
      opponent: s.opponent,
      isHome: s.isHome,
      last5StartKs: ks,
      kPerStart,
      trailingEra,
      strictFloorKs: strictFloor,
      softFloorKs: softFloor,
      suggestedLine,
      opposingTeamKPct,
      clearedRate: ks.filter((k) => k >= strictFloor).length / ks.length,
      grade: graded.grade,
      gradeScore: graded.score,
      gradeReasons: graded.reasons,
    });
  }

  scored.sort((a, b) => b.gradeScore - a.gradeScore);
  // No fixed top-N here either. A slate caps itself at roughly two
  // starters per game, so this board is naturally small and there is no
  // per-team cap to apply -- a team has exactly one starting pitcher.
  return { watchList: scored, watchListAll: scored };
}

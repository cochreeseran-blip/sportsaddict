import { gradeHitProp } from '../grading.js';

const HIT_STREAK_GATE = 5;
const AVG_GATE = 0.32;
const ERA_GATE = 6.0;
// "Even a little bit weaker" arm: anything worse than a league-average-ish
// trailing ERA counts toward the matchup score, not just full meltdowns.
const WEAK_ARM_FLOOR = 4.5;
// Not a business cap, just a safety valve. The Daily Slate/Tracking top 6
// is picked from this whole pool (lib/topPicks.js), so it needs every
// qualifying hitter on a busy slate (can legitimately be 50-100+), not
// just the first handful.
const MAX_WATCH = 200;

// Every hitter with hot recent form (a 5+ game streak or .320+ over the
// last 15), ranked by how hot they are and how weak the arm they're
// facing is. The ERA_GATE still marks the prime matchups, but a merely
// below-average starter now boosts a hitter's rank instead of being
// ignored.
export async function runHitStreakFilter(pool, gameDate) {
  const { rows: games } = await pool.query('SELECT * FROM games WHERE game_date = $1', [gameDate]);

  // Opponent starter for a given team's batters (the *other* team's starter).
  const opponentByTeam = new Map();
  const gameIdByTeam = new Map();
  for (const g of games) {
    opponentByTeam.set(g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name });
    opponentByTeam.set(g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name });
    gameIdByTeam.set(g.home_team, g.mlb_game_id);
    gameIdByTeam.set(g.away_team, g.mlb_game_id);
  }

  const { rows: pitchers } = await pool.query(
    `SELECT pitcher_id, trailing_era, savant_era, savant_xera, savant_k_pct, savant_bb_pct,
            savant_whiff_pct, savant_hard_hit_pct
     FROM pitcher_form WHERE game_date = $1`,
    [gameDate]
  );
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  const trailingEraByPitcherId = new Map(pitchers.map((p) => [p.pitcher_id, num(p.trailing_era)]));
  const savantByPitcherId = new Map(
    pitchers
      .filter((p) => p.savant_era !== null && p.savant_era !== undefined)
      .map((p) => [
        p.pitcher_id,
        {
          era: num(p.savant_era),
          xera: num(p.savant_xera),
          kPct: num(p.savant_k_pct),
          bbPct: num(p.savant_bb_pct),
          whiffPct: num(p.savant_whiff_pct),
          hardHitPct: num(p.savant_hard_hit_pct),
        },
      ])
  );

  const { rows: batters } = await pool.query(
    `SELECT * FROM batter_form WHERE game_date = $1 AND (hit_streak >= $2 OR trailing_15_avg >= $3)`,
    [gameDate, HIT_STREAK_GATE, AVG_GATE]
  );

  const scored = batters.map((b) => {
    const opp = opponentByTeam.get(b.team);
    const opponentTrailingEra =
      opp?.starterId != null ? trailingEraByPitcherId.get(opp.starterId) ?? null : null;
    const trailing15Avg = b.trailing_15_avg !== null ? Number(b.trailing_15_avg) : null;

    const opponentSavant = opp?.starterId != null ? savantByPitcherId.get(opp.starterId) ?? null : null;
    const graded = gradeHitProp({
      hitStreak: b.hit_streak ?? 0,
      trailing15Avg,
      opposingTrailingEra: opponentTrailingEra,
      opposingSavant: opponentSavant,
    });

    return {
      mlbGameId: gameIdByTeam.get(b.team) ?? null,
      batterId: b.batter_id,
      batterName: b.batter_name,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jersey_number ?? null,
      hitStreak: b.hit_streak,
      trailing15Avg,
      lineupConfirmed: b.lineup_confirmed,
      last5Results: b.last5_results ?? [],
      opposingStarterName: opp?.starterName ?? null,
      opposingStarterTrailingEra: opponentTrailingEra,
      weakerArm: opponentTrailingEra !== null && opponentTrailingEra >= WEAK_ARM_FLOOR,
      highConfidence: opponentTrailingEra !== null && opponentTrailingEra >= ERA_GATE,
      grade: graded.grade,
      gradeScore: graded.score,
      gradeReasons: graded.reasons,
    };
  });

  scored.sort((a, b) => b.gradeScore - a.gradeScore);
  const watchList = scored.slice(0, MAX_WATCH);

  return {
    watchList,
    highConfidence: watchList.filter((r) => r.highConfidence),
  };
}

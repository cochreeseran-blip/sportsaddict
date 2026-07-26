import { scoreHitProp } from '../grading.js';
import { postedLineupTeams, benchedOut } from '../lineupStatus.js';
import { trailingHitsPer9 } from '../data/game-logs-pull.js';
import { teamAbbr } from '../util/teamAbbr.js';
import { projectHits } from '../hitProjection.js';

const HIT_STREAK_GATE = 5;
const AVG_GATE = 0.30; // spec: trailing-15 avg qualification path raised to .300
const XBA_GATE = 0.28; // spec: new "deserves hits" qualification path
// Sample-size floor: below this many trailing at-bats, trailing_15_avg is
// too noisy to rank or grade on at all (a backup catcher going 2-for-2
// shows as a 1.000 average, that's not a real signal). A batter under
// this line is excluded entirely from the watch list, not shown with a
// lower grade or greyed out, see runHitStreakFilter below.
const MIN_TRAILING_AB = 30;
// Lower floor for the hit-streak exemption. A 5+ game hit streak lets a
// batter in below MIN_TRAILING_AB, but not on nothing: a pinch hitter
// with one at-bat a game can run a 5-game streak on five total at-bats
// and otherwise sail past the 30-AB gate. Requiring 15+ at-bats alongside
// the streak keeps regulars (who clear it trivially) while shutting out
// that thin-sample case. Sits between the two: enough to be real, low
// enough that a genuine streaking regular is never wrongly dropped.
const STREAK_EXEMPT_MIN_AB = 15;
const MAX_WATCH = 15; // spec: "TOP 15 shown"

// Tier cutoffs for the multi-hit board. A batter is only called a "2+ hit"
// candidate when the projection puts him meaningfully above the field: the
// typical regular's P(2+) sits near 25%, so 32% is genuinely the upper
// slice rather than a relabelling of everyone. The 1+ tier's floor is the
// same idea from the other end: below ~70% a "gets a hit" play isn't safe
// enough to be worth calling out at all.
const MULTI_HIT_TIER_MIN = 0.32;
const SINGLE_HIT_TIER_MIN = 0.70;

// Hot recent form (streak, trailing average, OR Savant xBA) against a
// beatable arm, scored per lib/grading.js scoreHitProp -- contact-quality
// metrics (xBA, hard-hit%, opposing H/9) instead of opposing ERA, plus
// lineup position and batter-vs-team history. See the Phase 1 spec for
// why each of these replaced the old ERA-based scoring.
export async function runHitStreakFilter(pool, gameDate) {
  const { rows: games } = await pool.query('SELECT * FROM games WHERE game_date = $1', [gameDate]);
  const season = Number(String(gameDate).slice(0, 4));

  // Opponent starter for a given team's batters (the *other* team's starter).
  const opponentByTeam = new Map();
  const gameIdByTeam = new Map();
  for (const g of games) {
    opponentByTeam.set(g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name, opponentName: g.away_team });
    opponentByTeam.set(g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name, opponentName: g.home_team });
    gameIdByTeam.set(g.home_team, g.mlb_game_id);
    gameIdByTeam.set(g.away_team, g.mlb_game_id);
  }

  const { rows: batters } = await pool.query(
    `SELECT * FROM batter_form WHERE game_date = $1
       AND (hit_streak >= $2 OR trailing_15_avg >= $3)`,
    [gameDate, HIT_STREAK_GATE, AVG_GATE]
  );

  // The xBA-only qualification path (a batter with a mediocre trailing
  // average but strong expected contact quality -- "deserves hits") isn't
  // reachable from the streak/average query above, so batters who missed
  // both of those but clear XBA_GATE need pulling in separately.
  const { rows: batterIdsForXba } = await pool.query(
    `SELECT batter_id FROM batter_form WHERE game_date = $1`,
    [gameDate]
  );
  const xbaByBatterId = new Map();
  if (batterIdsForXba.length) {
    const { rows: xbaRows } = await pool.query(
      `SELECT DISTINCT ON (player_id) player_id, xba, hard_hit_pct
         FROM savant_batter_metrics
        WHERE player_id = ANY($1) AND season = $2
        ORDER BY player_id, pull_date DESC`,
      [batterIdsForXba.map((r) => r.batter_id), season]
    );
    for (const r of xbaRows) xbaByBatterId.set(r.player_id, { xba: r.xba !== null ? Number(r.xba) : null, hardHitPct: r.hard_hit_pct !== null ? Number(r.hard_hit_pct) : null });
  }
  const { rows: xbaQualifiers } = await pool.query(
    `SELECT * FROM batter_form WHERE game_date = $1`,
    [gameDate]
  );
  const alreadyIn = new Set(batters.map((b) => b.batter_id));
  for (const b of xbaQualifiers) {
    if (alreadyIn.has(b.batter_id)) continue;
    const savant = xbaByBatterId.get(b.batter_id);
    if (savant?.xba !== null && savant?.xba !== undefined && savant.xba >= XBA_GATE) {
      batters.push(b);
      alreadyIn.add(b.batter_id);
    }
  }

  const { rows: pitchers } = await pool.query(
    `SELECT pitcher_id, trailing_era, savant_era, savant_xera, savant_k_pct, savant_bb_pct,
            savant_whiff_pct, savant_hard_hit_pct
     FROM pitcher_form WHERE game_date = $1`,
    [gameDate]
  );
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  const trailingEraByPitcherId = new Map(pitchers.map((p) => [p.pitcher_id, num(p.trailing_era)]));

  // Once a team's lineup is posted, drop any hot hitter who isn't in it:
  // there's no hit prop on a guy who isn't starting. This is what makes a
  // refresh clean itself up — a batter who looked good on projected form
  // but gets left out of the confirmed lineup disappears from the board on
  // the next run instead of sitting there as a phantom pick.
  const postedTeams = await postedLineupTeams(pool, gameDate);

  // Eligibility: a batter needs MIN_TRAILING_AB real at-bats behind his
  // trailing average to be graded/ranked at all, UNLESS his hit streak
  // clears HIT_STREAK_GATE (5+ straight games with a hit) AND he still has
  // at least STREAK_EXEMPT_MIN_AB at-bats. The streak exemption exists
  // because a long streak is evidence of playing time, but a bare streak
  // isn't enough on its own: a pinch hitter with one at-bat a game can run
  // a 5-game streak on five total at-bats, so the exemption carries its
  // own (lower) at-bat floor to shut that thin-sample case out.
  const eligible = batters.filter((b) => {
    if (benchedOut(b, postedTeams)) return false; // lineup posted, not in it
    const ab = b.trailing_15_ab ?? 0;
    if (ab >= MIN_TRAILING_AB) return true;
    return (b.hit_streak ?? 0) >= HIT_STREAK_GATE && ab >= STREAK_EXEMPT_MIN_AB;
  });

  // Batter-vs-opponent history, only surfaced at 20+ career PA (see
  // migrations/020 comment on batter_vs_team_history).
  const opponentAbbrByBatterId = new Map();
  for (const b of eligible) {
    const opp = opponentByTeam.get(b.team);
    if (opp?.opponentName) opponentAbbrByBatterId.set(b.batter_id, teamAbbr(opp.opponentName));
  }
  const vsTeamByKey = new Map();
  const pairs = [...opponentAbbrByBatterId.entries()].filter(([, abbr]) => abbr);
  if (pairs.length) {
    // Small result set (today's eligible batters only), so fetch by
    // batter-id set and filter the (batter, opponent) pair in JS rather
    // than a row-constructor subquery.
    const { rows: vsRows } = await pool.query(
      `SELECT batter_id, opponent_abbr, total_pa, batting_avg FROM batter_vs_team_history WHERE batter_id = ANY($1)`,
      [pairs.map(([id]) => id)]
    );
    for (const r of vsRows) {
      if (opponentAbbrByBatterId.get(r.batter_id) !== r.opponent_abbr) continue;
      vsTeamByKey.set(`${r.batter_id}:${r.opponent_abbr}`, { pa: r.total_pa, avg: r.batting_avg !== null ? Number(r.batting_avg) : null });
    }
  }

  const scored = [];
  for (const b of eligible) {
    const opp = opponentByTeam.get(b.team);
    const opponentTrailingEra = opp?.starterId != null ? trailingEraByPitcherId.get(opp.starterId) ?? null : null;
    const trailing15Avg = b.trailing_15_avg !== null ? Number(b.trailing_15_avg) : null;
    const trailing15Ab = b.trailing_15_ab ?? 0;

    const savant = xbaByBatterId.get(b.batter_id) || {};
    const opposingHitsPer9 = opp?.starterId != null ? await trailingHitsPer9(pool, opp.starterId).catch(() => null) : null;
    const vsTeam = vsTeamByKey.get(`${b.batter_id}:${opponentAbbrByBatterId.get(b.batter_id)}`);

    const graded = scoreHitProp({
      trailing15Avg,
      xba: savant.xba ?? null,
      opposingHitsPer9,
      hitStreak: b.hit_streak ?? 0,
      hardHitPct: savant.hardHitPct ?? null,
      battingOrderSlot: b.batting_order_slot ?? null,
      vsTeamPa: vsTeam?.pa ?? null,
      vsTeamAvg: vsTeam?.avg ?? null,
    });
    if (!graded.surfaced) continue; // below MIN_SURFACE_SCORE, per spec not shown at all

    // The projection is what the board is actually built on now: the same
    // model produces both tiers, so the 2+ list can never disagree with
    // the 1+ list. The letter grade rides along as the quality read on the
    // matchup, but ordering within a tier is by that tier's probability.
    const projection = projectHits({
      trailing15Avg,
      xba: savant.xba ?? null,
      opposingHitsPer9,
      battingOrderSlot: b.batting_order_slot ?? null,
    });

    scored.push({
      mlbGameId: gameIdByTeam.get(b.team) ?? null,
      batterId: b.batter_id,
      batterName: b.batter_name,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jersey_number ?? null,
      battingOrderSlot: b.batting_order_slot ?? null,
      hitStreak: b.hit_streak,
      trailing15Avg,
      trailing15Ab,
      xba: savant.xba ?? null,
      xbaLuckFlag: graded.xbaLuckFlag,
      lineupConfirmed: b.lineup_confirmed,
      last5Results: b.last5_results ?? [],
      opposingStarterName: opp?.starterName ?? null,
      opposingStarterTrailingEra: opponentTrailingEra,
      opposingHitsPer9,
      vsTeamPa: vsTeam?.pa ?? null,
      vsTeamAvg: vsTeam?.avg ?? null,
      grade: graded.grade,
      gradeScore: graded.score,
      gradeReasons: graded.reasons,
      // Projection fields, flattened so every consumer (ledger, dashboard,
      // email) reads the same keys without digging into a nested object.
      expectedHits: projection.expectedHits,
      expectedAtBats: projection.expectedAtBats,
      hitProbPerAb: projection.hitProbPerAb,
      pAtLeastOne: projection.pAtLeastOne,
      pAtLeastTwo: projection.pAtLeastTwo,
      projectionBasis: projection.basis,
      projectionComponents: projection.components,
      // Empirical counterpart to pAtLeastTwo: how often he actually had a
      // multi-hit game recently, so the projection can be sanity-checked.
      multiHitRate: b.trailing_15_multi_hit_rate !== null && b.trailing_15_multi_hit_rate !== undefined
        ? Number(b.trailing_15_multi_hit_rate)
        : null,
      trailing15Games: b.trailing_15_games ?? null,
    });
  }

  // Two boards off one model. multiHit is ordered by P(2+) because that's
  // the question being asked; singleHit by P(1+) for the same reason. A
  // batter can legitimately appear on both: a leadoff masher is both the
  // best 2+ candidate and one of the safest 1+ plays, and hiding him from
  // one list to avoid the overlap would be hiding a true answer.
  const multiHit = scored
    .filter((b) => b.pAtLeastTwo >= MULTI_HIT_TIER_MIN)
    .sort((a, b) => b.pAtLeastTwo - a.pAtLeastTwo || b.gradeScore - a.gradeScore)
    .slice(0, MAX_WATCH);

  const singleHit = scored
    .filter((b) => b.pAtLeastOne >= SINGLE_HIT_TIER_MIN)
    .sort((a, b) => b.pAtLeastOne - a.pAtLeastOne || b.gradeScore - a.gradeScore)
    .slice(0, MAX_WATCH);

  scored.sort((a, b) => b.gradeScore - a.gradeScore);

  return {
    // watchList stays the grade-ranked list so existing consumers (the
    // ledger recorder, the email digest) keep working unchanged.
    watchList: scored.slice(0, MAX_WATCH),
    multiHit,
    singleHit,
    tierCutoffs: { multiHit: MULTI_HIT_TIER_MIN, singleHit: SINGLE_HIT_TIER_MIN },
  };
}

import { postedLineupTeams, benchedOut } from '../lineupStatus.js';
import { scoreHomeRunProp } from '../grading.js';
import { trailingHrPer9 } from '../data/game-logs-pull.js';

// Home run board. Previously this ranked on trailing HR rate plus a wind
// bonus and was never surfaced anywhere; it now scores on Statcast contact
// quality (barrel rate, exit velocity, expected slugging) against arms that
// actually give up home runs, with wind as a bonus at verified parks only.
// See scoreHomeRunProp in lib/grading.js for why each input is weighted the
// way it is, and why the HR rate itself is deliberately a minor factor.

// Qualification: a batter needs SOME evidence of power to be considered at
// all, via either path. Barrel rate is the preferred gate (it's the stable,
// predictive one); the HR-rate path exists so a batter Savant hasn't
// covered yet isn't silently excluded.
const BARREL_GATE = 6.0;      // percent
const HR_RATE_GATE = 0.10;    // a homer in at least 1 of every 10 recent games
// Per-game rates need a real denominator. Below this many trailing games,
// one home run reads as a 33% rate and that isn't a signal.
const MIN_TRAILING_GAMES = 8;
const MAX_WATCH = 15;

export async function runWindHrFilter(pool, gameDate) {
  const warnings = [];
  const season = Number(String(gameDate).slice(0, 4));

  const { rows: allBatters } = await pool.query('SELECT * FROM batter_form WHERE game_date = $1', [gameDate]);
  if (!allBatters.length) return { watchList: [], warnings };

  // Same lineup gate as the hit board: once a team's lineup posts, a hitter
  // who isn't in it has no prop, because he isn't playing.
  const postedTeams = await postedLineupTeams(pool, gameDate);
  const startingBatters = allBatters.filter((b) => !benchedOut(b, postedTeams));

  const { rows: games } = await pool.query(
    `SELECT g.*,
            (g.wind_blowing_out = true AND po.out_bearing_degrees IS NOT NULL) AS wind_out_verified,
            (g.wind_blowing_out = true AND po.out_bearing_degrees IS NULL) AS wind_out_stale
     FROM games g
     LEFT JOIN park_orientations po ON lower(po.venue) = lower(g.venue)
     WHERE g.game_date = $1`,
    [gameDate]
  );

  // A wind_blowing_out=true row at a park whose bearing is (no longer)
  // verified is stale data from an earlier run, never trust it.
  for (const g of games) {
    if (g.wind_out_stale) {
      warnings.push(`Ignoring a stale wind reading at "${g.venue}", park orientation is unverified.`);
    }
  }

  // Batter Statcast profiles, latest pull per player for this season.
  const batterIds = startingBatters.map((b) => b.batter_id);
  const savantByBatterId = new Map();
  if (batterIds.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (player_id) player_id, barrel_pct, hard_hit_pct, xslg, avg_exit_velo
         FROM savant_batter_metrics
        WHERE player_id = ANY($1) AND season = $2
        ORDER BY player_id, pull_date DESC`,
      [batterIds, season]
    );
    for (const r of rows) {
      savantByBatterId.set(r.player_id, {
        barrelPct: num(r.barrel_pct),
        hardHitPct: num(r.hard_hit_pct),
        xslg: num(r.xslg),
        avgExitVelo: num(r.avg_exit_velo),
      });
    }
  }

  // Opposing starter Statcast profiles (barrel rate allowed).
  const starterIds = games.flatMap((g) => [g.home_starter_id, g.away_starter_id]).filter(Boolean);
  const pitcherSavantById = new Map();
  if (starterIds.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (player_id) player_id, barrel_pct
         FROM savant_pitcher_metrics
        WHERE player_id = ANY($1) AND season = $2
        ORDER BY player_id, pull_date DESC`,
      [starterIds, season]
    );
    for (const r of rows) pitcherSavantById.set(r.player_id, { barrelPct: num(r.barrel_pct) });
  }

  // Opposing starter HR/9 from stored game logs, computed once per starter
  // rather than once per batter (nine batters share one opposing arm).
  const hrPer9ByPitcherId = new Map();
  for (const id of new Set(starterIds)) {
    hrPer9ByPitcherId.set(id, await trailingHrPer9(pool, id).catch(() => null));
  }

  const battersByTeam = new Map();
  for (const b of startingBatters) {
    if (!battersByTeam.has(b.team)) battersByTeam.set(b.team, []);
    battersByTeam.get(b.team).push(b);
  }

  const scored = [];
  for (const g of games) {
    const windOut = g.wind_out_verified === true;
    const oppByTeam = new Map([
      [g.home_team, { starterId: g.away_starter_id, starterName: g.away_starter_name }],
      [g.away_team, { starterId: g.home_starter_id, starterName: g.home_starter_name }],
    ]);

    for (const team of [g.home_team, g.away_team]) {
      const opp = oppByTeam.get(team);
      const opposingHrPer9 = opp?.starterId != null ? hrPer9ByPitcherId.get(opp.starterId) ?? null : null;
      const opposingBarrelPct = opp?.starterId != null ? pitcherSavantById.get(opp.starterId)?.barrelPct ?? null : null;

      for (const b of battersByTeam.get(team) || []) {
        const savant = savantByBatterId.get(b.batter_id) || {};
        const hrRate = num(b.trailing_15_hr_rate);
        const trailingGames = b.trailing_15_games ?? null;

        // Qualification. The HR-rate path additionally requires a real
        // denominator; the barrel path doesn't, because Savant's barrel
        // rate is already computed off a full season of batted balls.
        const barrelQualifies = savant.barrelPct !== null && savant.barrelPct !== undefined && savant.barrelPct >= BARREL_GATE;
        const rateQualifies = hrRate !== null && hrRate >= HR_RATE_GATE
          && (trailingGames === null || trailingGames >= MIN_TRAILING_GAMES);
        if (!barrelQualifies && !rateQualifies) continue;

        const graded = scoreHomeRunProp({
          barrelPct: savant.barrelPct ?? null,
          avgExitVelo: savant.avgExitVelo ?? null,
          hardHitPct: savant.hardHitPct ?? null,
          xslg: savant.xslg ?? null,
          trailing15HrRate: hrRate,
          opposingHrPer9,
          opposingBarrelPct,
          windBlowingOut: windOut,
          windSpeedMph: windOut ? num(g.wind_speed_mph) : null,
          battingOrderSlot: b.batting_order_slot ?? null,
        });
        if (!graded.surfaced) continue;

        scored.push({
          mlbGameId: g.mlb_game_id,
          batterId: b.batter_id,
          batterName: b.batter_name,
          team,
          position: b.position ?? null,
          jerseyNumber: b.jersey_number ?? null,
          battingOrderSlot: b.batting_order_slot ?? null,
          trailing15HrRate: hrRate,
          trailing15Games: trailingGames,
          barrelPct: savant.barrelPct ?? null,
          avgExitVelo: savant.avgExitVelo ?? null,
          hardHitPct: savant.hardHitPct ?? null,
          xslg: savant.xslg ?? null,
          lineupConfirmed: b.lineup_confirmed,
          last5Results: b.last5_results ?? [],
          venue: g.venue,
          windBlowingOut: windOut,
          windSpeedMph: windOut ? num(g.wind_speed_mph) : null,
          opposingStarterName: opp?.starterName ?? null,
          opposingHrPer9,
          opposingBarrelPct,
          grade: graded.grade,
          gradeScore: graded.score,
          gradeReasons: graded.reasons,
        });
      }
    }
  }

  scored.sort((a, b) => b.gradeScore - a.gradeScore);
  return { watchList: scored.slice(0, MAX_WATCH), warnings };
}

function num(v) {
  return v !== null && v !== undefined ? Number(v) : null;
}

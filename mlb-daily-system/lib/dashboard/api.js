import { runStrikeoutFilter } from '../filters/strikeouts.js';
import { runHitStreakFilter } from '../filters/hitStreak.js';
import { runMoneylineFilter } from '../filters/moneyline.js';
import * as mlb from '../sources/mlbStats.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Panel 1: today's slate overview. One row per game with both starters'
// Savant profiles side by side, lineup-confirmation status, current
// odds/price, and (once games start) score/inning -- everything the spec
// wants visible without clicking through to a second page.
export async function buildSlateOverview(pool, gameDate) {
  const { rows: games } = await pool.query(
    `SELECT id, mlb_game_id, home_team, away_team, venue, home_ml, away_ml,
            home_starter_id, home_starter_name, away_starter_id, away_starter_name
       FROM games WHERE game_date = $1 ORDER BY id`,
    [gameDate]
  );
  if (!games.length) return [];

  const starterIds = games.flatMap((g) => [g.home_starter_id, g.away_starter_id]).filter(Boolean);
  const { rows: forms } = starterIds.length
    ? await pool.query(
        `SELECT pitcher_id, season_era, trailing_era, savant_era, savant_xera,
                savant_k_pct, savant_bb_pct, savant_whiff_pct, savant_hard_hit_pct
           FROM pitcher_form WHERE game_date = $1 AND pitcher_id = ANY($2)`,
        [gameDate, starterIds]
      )
    : { rows: [] };
  const formById = new Map(forms.map((f) => [f.pitcher_id, f]));

  const { rows: confirmedRows } = await pool.query(
    `SELECT DISTINCT team, min(lineup_confirmed_at) AS confirmed_at FROM batter_form
      WHERE game_date = $1 AND lineup_confirmed = true GROUP BY team`,
    [gameDate]
  );
  const confirmedByTeam = new Map(confirmedRows.map((r) => [r.team, r.confirmed_at]));

  const pitcherProfile = (id) => {
    if (!id) return null;
    const f = formById.get(id);
    if (!f) return null;
    return {
      seasonEra: num(f.season_era),
      trailingEra: num(f.trailing_era),
      savantEra: num(f.savant_era),
      savantXera: num(f.savant_xera),
      kPct: num(f.savant_k_pct),
      bbPct: num(f.savant_bb_pct),
      whiffPct: num(f.savant_whiff_pct),
      hardHitPct: num(f.savant_hard_hit_pct),
    };
  };

  return games.map((g) => ({
    gameId: g.id,
    mlbGameId: g.mlb_game_id,
    venue: g.venue,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    homeMl: g.home_ml,
    awayMl: g.away_ml,
    homeStarterId: g.home_starter_id,
    homeStarterName: g.home_starter_name,
    homeStarterProfile: pitcherProfile(g.home_starter_id),
    awayStarterId: g.away_starter_id,
    awayStarterName: g.away_starter_name,
    awayStarterProfile: pitcherProfile(g.away_starter_id),
    homeLineupConfirmed: confirmedByTeam.has(g.home_team),
    homeLineupConfirmedAt: confirmedByTeam.get(g.home_team) ?? null,
    awayLineupConfirmed: confirmedByTeam.has(g.away_team),
    awayLineupConfirmedAt: confirmedByTeam.get(g.away_team) ?? null,
  }));
}

// Panel 2, moneyline tab: the existing filter's picks, unchanged, enriched
// with both starters' Savant profiles, both teams' trailing-10-game
// offense, and the "blowout-inflated" flag -- all display-only per the
// spec ("calculate at display time, not in the filter").
async function enrichMoneylinePicks(pool, gameDate, picks) {
  if (!picks.length) return picks;
  const season = Number(String(gameDate).slice(0, 4));
  const mlbGameIds = picks.map((p) => p.mlbGameId).filter(Boolean);
  const { rows: games } = mlbGameIds.length
    ? await pool.query(
        `SELECT mlb_game_id, home_starter_id, away_starter_id FROM games WHERE mlb_game_id = ANY($1)`,
        [mlbGameIds]
      )
    : { rows: [] };
  const gameByMlbId = new Map(games.map((g) => [g.mlb_game_id, g]));

  const starterIds = games.flatMap((g) => [g.home_starter_id, g.away_starter_id]).filter(Boolean);
  const { rows: forms } = starterIds.length
    ? await pool.query(
        `SELECT pitcher_id, savant_era, savant_xera, savant_k_pct, savant_bb_pct, savant_whiff_pct, savant_hard_hit_pct
           FROM pitcher_form WHERE game_date = $1 AND pitcher_id = ANY($2)`,
        [gameDate, starterIds]
      )
    : { rows: [] };
  const formById = new Map(forms.map((f) => [f.pitcher_id, f]));

  const out = [];
  for (const p of picks) {
    const g = gameByMlbId.get(p.mlbGameId);
    const [homeRunsPerGame, awayRunsPerGame, blowoutFlag] = await Promise.all([
      trailingRunsPerGame(p.homeTeam, gameDate),
      trailingRunsPerGame(p.awayTeam, gameDate),
      g?.away_starter_id ? isBlowoutInflated(pool, g.away_starter_id) : Promise.resolve(false),
    ]);
    const hf = g?.home_starter_id ? formById.get(g.home_starter_id) : null;
    const af = g?.away_starter_id ? formById.get(g.away_starter_id) : null;
    out.push({
      ...p,
      homeStarterSavant: hf ? { era: num(hf.savant_era), xera: num(hf.savant_xera), kPct: num(hf.savant_k_pct), bbPct: num(hf.savant_bb_pct), whiffPct: num(hf.savant_whiff_pct), hardHitPct: num(hf.savant_hard_hit_pct) } : null,
      awayStarterSavant: af ? { era: num(af.savant_era), xera: num(af.savant_xera), kPct: num(af.savant_k_pct), bbPct: num(af.savant_bb_pct), whiffPct: num(af.savant_whiff_pct), hardHitPct: num(af.savant_hard_hit_pct) } : null,
      homeRunsPerGame,
      awayRunsPerGame,
      awayStarterBlowoutInflated: blowoutFlag,
    });
  }
  return out;
}

// Runs scored per game isn't stored anywhere in this app (batter_game_logs
// is per-batter, not per-team-game, and there's no final-scores table) --
// rather than invent a number from an unrelated proxy stat, this reads it
// straight from the MLB schedule API, which already returns final scores
// for completed games (the same endpoint buildSlate uses). Scoped to a
// 30-day lookback window and cached per team+date for the life of one
// dashboard request.
const runsCache = new Map();
async function trailingRunsPerGame(teamName, asOfDate, n = 10) {
  if (!teamName) return null;
  const cacheKey = `${teamName}:${asOfDate}`;
  if (runsCache.has(cacheKey)) return runsCache.get(cacheKey);

  const end = new Date(`${asOfDate}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const iso = (d) => d.toISOString().slice(0, 10);

  let result = null;
  try {
    const byDate = await mlb.fetchScheduleRange(iso(start), iso(end));
    const finals = [];
    for (const dateKey of Object.keys(byDate).sort().reverse()) {
      for (const g of byDate[dateKey]) {
        if (g.abstractState !== 'Final') continue;
        if (g.home?.name === teamName && g.home.score !== null) finals.push(g.home.score);
        else if (g.away?.name === teamName && g.away.score !== null) finals.push(g.away.score);
        if (finals.length >= n) break;
      }
      if (finals.length >= n) break;
    }
    result = finals.length ? Math.round((finals.reduce((s, r) => s + r, 0) / finals.length) * 10) / 10 : null;
  } catch (err) {
    console.warn(`  Dashboard: trailing runs/game lookup failed for ${teamName}: ${err.message}`);
    result = null;
  }
  runsCache.set(cacheKey, result);
  return result;
}

// A single start is "blowout-inflated" if removing it (the worst of the
// last 3, by earned runs) drops the resulting 2-start ERA below 4.50 --
// i.e. the trailing-ERA number that got this pick qualified is being
// carried by one bad outing, not a consistently bad recent stretch.
async function isBlowoutInflated(pool, pitcherId, n = 3) {
  const { rows } = await pool.query(
    `SELECT innings_pitched, earned_runs FROM pitcher_game_logs
      WHERE player_id = $1 ORDER BY game_date DESC LIMIT $2`,
    [pitcherId, n]
  );
  if (rows.length < n) return false;
  let best = Infinity;
  for (let skip = 0; skip < rows.length; skip++) {
    let ip = 0, er = 0;
    rows.forEach((r, i) => {
      if (i === skip) return;
      ip += Number(r.innings_pitched) || 0;
      er += Number(r.earned_runs) || 0;
    });
    if (ip > 0) best = Math.min(best, (er / ip) * 9);
  }
  return Number.isFinite(best) && best < 4.5;
}

// The full dashboard payload for one date: slate overview + all three
// signal tabs. Each signal's filter runs unmodified; moneyline gets the
// display enrichment above, K props and hit props are already scored
// with the corrected logic (see lib/grading.js).
export async function buildDashboardData(pool, gameDate) {
  const [slate, strikeouts, hitProps, moneyline] = await Promise.all([
    buildSlateOverview(pool, gameDate),
    runStrikeoutFilter(pool, gameDate),
    runHitStreakFilter(pool, gameDate),
    runMoneylineFilter(pool, gameDate),
  ]);
  const moneylinePicks = await enrichMoneylinePicks(pool, gameDate, moneyline.picks);
  return {
    gameDate,
    slate,
    strikeouts: strikeouts.watchList,
    hitProps: hitProps.watchList,
    moneyline: { signal: moneyline.signal, picks: moneylinePicks, otherGames: moneyline.otherGames },
  };
}

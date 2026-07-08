import { pool } from './db.js';
import * as mlb from './sources/mlbStats.js';
import { fetchMoneylines, normalizeTeam } from './sources/odds.js';
import { fetchWindAt } from './sources/weather.js';
import { isWindBlowingOut } from './geo.js';
import { computeTrailingPitcherStats, upsertPitcherForm } from './pitcherForm.js';
import { computeBatterStats, upsertBatterForm } from './batterForm.js';
import { runMoneylineFilter } from './filters/moneyline.js';
import { runHitStreakFilter } from './filters/hitStreak.js';
import { runWindHrFilter } from './filters/windHr.js';
import { saveDigest } from './digest.js';
import { buildTopPicks } from './topPicks.js';
import { recordTrackedPicks } from './trackedPicks.js';

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function upsertGame(g, gameDate) {
  await pool.query(
    `INSERT INTO games
       (game_date, mlb_game_id, home_team, away_team, game_time_utc, venue,
        home_starter_id, home_starter_name, away_starter_id, away_starter_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (mlb_game_id) DO UPDATE SET
       home_team = EXCLUDED.home_team,
       away_team = EXCLUDED.away_team,
       game_time_utc = EXCLUDED.game_time_utc,
       venue = EXCLUDED.venue,
       home_starter_id = EXCLUDED.home_starter_id,
       home_starter_name = EXCLUDED.home_starter_name,
       away_starter_id = EXCLUDED.away_starter_id,
       away_starter_name = EXCLUDED.away_starter_name`,
    [
      gameDate,
      g.mlbGameId,
      g.homeTeamName,
      g.awayTeamName,
      g.gameDate,
      g.venue,
      g.homeStarterId,
      g.homeStarterName,
      g.awayStarterId,
      g.awayStarterName,
    ]
  );
}

// The full daily pipeline: fetch, upsert, compute, filter, save digest.
// Shared by the CLI (job.js) and the web dashboard's boot/refresh/daily
// timer (server.js) so there's exactly one implementation.
export async function runPipeline(gameDate = todayIsoDate()) {
  const season = gameDate.slice(0, 4);
  const warnings = [];
  const log = (msg) => console.log(`  ${msg}`);

  console.log(`Running MLB daily pipeline for ${gameDate}...`);

  // 1. Schedule + probable starters
  let scheduleGames = [];
  try {
    scheduleGames = await mlb.fetchScheduleWithProbables(gameDate);
    for (const g of scheduleGames) {
      await upsertGame(g, gameDate);
    }
    log(`Schedule: ${scheduleGames.length} game(s) upserted.`);
  } catch (err) {
    warnings.push(`MLB schedule unavailable — check manually. (${err.message})`);
    console.warn(`  Schedule fetch failed: ${err.message}`);
  }

  // 2. Odds — matched against the in-memory schedule by team name. A
  // single unmatched/missing game is logged and skipped, not fatal.
  if (!process.env.ODDS_API_KEY) {
    warnings.push('Odds data unavailable — ODDS_API_KEY not set. Check manually.');
  } else {
    try {
      const moneylines = await fetchMoneylines(process.env.ODDS_API_KEY);
      let matched = 0;
      for (const g of scheduleGames) {
        const m = moneylines.find(
          (o) =>
            normalizeTeam(o.homeTeam) === normalizeTeam(g.homeTeamName) &&
            normalizeTeam(o.awayTeam) === normalizeTeam(g.awayTeamName)
        );
        if (!m || (m.homeMl === null && m.awayMl === null)) {
          console.warn(`  Odds: no match/line for ${g.awayTeamName} @ ${g.homeTeamName} — skipping.`);
          continue;
        }
        await pool.query('UPDATE games SET home_ml = $1, away_ml = $2 WHERE mlb_game_id = $3', [
          m.homeMl,
          m.awayMl,
          g.mlbGameId,
        ]);
        matched++;
      }
      log(`Odds: matched ${matched}/${scheduleGames.length} game(s).`);
    } catch (err) {
      warnings.push(`Odds data unavailable — check manually. (${err.message})`);
      console.warn(`  Odds fetch failed: ${err.message}`);
    }
  }

  // 3. Pitcher form — every probable starter, home and away, deduped.
  const starterIds = new Map();
  for (const g of scheduleGames) {
    if (g.homeStarterId) starterIds.set(g.homeStarterId, g.homeStarterName);
    if (g.awayStarterId) starterIds.set(g.awayStarterId, g.awayStarterName);
  }
  let pitcherOk = 0;
  for (const [pitcherId, pitcherName] of starterIds) {
    try {
      const [gameLog, seasonEra] = await Promise.all([
        mlb.fetchPitcherGameLog(pitcherId, season),
        mlb.fetchPitcherSeasonEra(pitcherId, season),
      ]);
      const trailing = computeTrailingPitcherStats(gameLog);
      await upsertPitcherForm(pool, { gameDate, pitcherId, pitcherName, seasonEra, ...trailing });
      pitcherOk++;
    } catch (err) {
      warnings.push(`Pitcher form unavailable for ${pitcherName ?? pitcherId} — check manually. (${err.message})`);
      console.warn(`  Pitcher form failed for ${pitcherName ?? pitcherId}: ${err.message}`);
    }
  }
  log(`Pitcher form: ${pitcherOk}/${starterIds.size} pitcher(s) updated.`);

  // 4. Batter form — confirmed lineup if it's out yet, else active roster
  // position players as a "regulars" stand-in. Calls are sequential on
  // purpose: this hits the free, unauthenticated MLB Stats API dozens of
  // times a day and sequential requests are kinder to it than a burst.
  let battersOk = 0;
  let battersTotal = 0;
  for (const g of scheduleGames) {
    const sides = [
      { side: 'home', teamId: g.homeTeamId, team: g.homeTeamName },
      { side: 'away', teamId: g.awayTeamId, team: g.awayTeamName },
    ];
    for (const { side, teamId, team } of sides) {
      let hitters = [];
      let lineupConfirmed = false;
      try {
        hitters = await mlb.fetchConfirmedLineup(g.gamePk, side);
        if (hitters.length) {
          lineupConfirmed = true;
        } else {
          hitters = await mlb.fetchActiveHitters(teamId);
          lineupConfirmed = false;
        }
      } catch (err) {
        warnings.push(`Batter lineup unavailable for ${team} — check manually. (${err.message})`);
        console.warn(`  Lineup fetch failed for ${team}: ${err.message}`);
        continue;
      }
      if (!lineupConfirmed) {
        warnings.push(`${team}'s lineup isn't posted yet — showing active roster regulars instead (may not match tonight's actual batting order).`);
      }
      for (const hitter of hitters) {
        battersTotal++;
        try {
          const batterLog = await mlb.fetchBatterGameLog(hitter.id, season);
          const stats = computeBatterStats(batterLog);
          await upsertBatterForm(pool, {
            gameDate,
            batterId: hitter.id,
            batterName: hitter.fullName,
            team,
            lineupConfirmed,
            position: hitter.position,
            jerseyNumber: hitter.jerseyNumber,
            ...stats,
          });
          battersOk++;
        } catch (err) {
          warnings.push(`Batter form unavailable for ${hitter.fullName ?? hitter.id} — check manually. (${err.message})`);
        }
      }
    }
  }
  log(`Batter form: ${battersOk}/${battersTotal} batter(s) updated.`);

  // 5. Weather — one lookup per unique venue playing today.
  const venues = new Map();
  for (const g of scheduleGames) {
    if (g.venue && !venues.has(g.venue)) venues.set(g.venue, g.gameDate);
  }
  let windOk = 0;
  let windSkippedUnverified = 0;
  for (const [venue, gameTimeUtc] of venues) {
    try {
      const { rows } = await pool.query(
        'SELECT latitude, longitude, out_bearing_degrees, confidence FROM park_orientations WHERE lower(venue) = lower($1)',
        [venue]
      );
      if (!rows.length) {
        warnings.push(`No park orientation data for venue "${venue}" — wind check skipped.`);
        continue;
      }
      const { latitude, longitude, out_bearing_degrees } = rows[0];
      if (out_bearing_degrees === null) {
        // Bearing is unverified (see migration 004) — computing "blowing
        // out" from an unknown orientation would be exactly the silent
        // guess this table was fixed to stop doing. Explicitly clear any
        // stale wind_blowing_out from a prior run rather than leaving it.
        windSkippedUnverified++;
        warnings.push(`Park orientation for "${venue}" is unverified (no confirmed bearing) — wind check skipped.`);
        await pool.query('UPDATE games SET wind_speed_mph = NULL, wind_blowing_out = NULL WHERE game_date = $1 AND venue = $2', [
          gameDate,
          venue,
        ]);
        continue;
      }
      const wind = await fetchWindAt(latitude, longitude, gameTimeUtc);
      if (!wind) {
        warnings.push(`Weather data unavailable for ${venue} — check manually.`);
        continue;
      }
      const blowingOut = isWindBlowingOut(wind.windDirectionFromDegrees, Number(out_bearing_degrees), wind.windSpeedMph);
      await pool.query('UPDATE games SET wind_speed_mph = $1, wind_blowing_out = $2 WHERE game_date = $3 AND venue = $4', [
        wind.windSpeedMph,
        blowingOut,
        gameDate,
        venue,
      ]);
      windOk++;
    } catch (err) {
      warnings.push(`Weather data unavailable for ${venue} — check manually. (${err.message})`);
      console.warn(`  Weather fetch failed for ${venue}: ${err.message}`);
    }
  }
  log(`Weather: ${windOk}/${venues.size} venue(s) updated (${windSkippedUnverified} skipped — unverified park orientation).`);

  // Filters + digest
  const moneyline = await runMoneylineFilter(pool, gameDate);
  const hitStreak = await runHitStreakFilter(pool, gameDate);
  const windHr = await runWindHrFilter(pool, gameDate);
  warnings.push(...(windHr.warnings || []));

  // Pooled cross-category ranking for the dashboard's Top 3 hero section.
  // Heuristic and explainable, not a model — see lib/topPicks.js.
  const topPicks = buildTopPicks({ moneyline, hitStreak, windHr });

  await saveDigest(pool, gameDate, 'moneyline', moneyline);
  await saveDigest(pool, gameDate, 'hit_streak', hitStreak);
  await saveDigest(pool, gameDate, 'wind_hr', windHr);
  await saveDigest(pool, gameDate, 'top_picks', { picks: topPicks });

  const trackedCount = await recordTrackedPicks(pool, gameDate, { moneyline, hitStreak, windHr });
  log(`Tracked picks: ${trackedCount} new row(s) added to the ledger.`);

  return { gameDate, warnings, moneyline, hitStreak, windHr, topPicks };
}

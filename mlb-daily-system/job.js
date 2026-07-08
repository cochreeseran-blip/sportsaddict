import 'dotenv/config';
import { pool } from './lib/db.js';
import * as mlb from './lib/sources/mlbStats.js';
import { fetchMoneylines, normalizeTeam } from './lib/sources/odds.js';
import { fetchWindAt } from './lib/sources/weather.js';
import { isWindBlowingOut } from './lib/geo.js';
import { computeTrailingPitcherStats, upsertPitcherForm } from './lib/pitcherForm.js';
import { computeBatterStats, upsertBatterForm } from './lib/batterForm.js';
import { runMoneylineFilter } from './lib/filters/moneyline.js';
import { runHitStreakFilter } from './lib/filters/hitStreak.js';
import { runWindHrFilter } from './lib/filters/windHr.js';
import { saveDigest, printDigest } from './lib/digest.js';

function todayIsoDate() {
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

async function main() {
  // Optional CLI override: `node job.js 2026-07-08`. Defaults to today (UTC
  // calendar date, which is what the MLB schedule endpoint expects).
  const gameDate = process.argv[2] || todayIsoDate();
  const season = gameDate.slice(0, 4);
  const warnings = [];

  console.log(`Running MLB daily pipeline for ${gameDate}...`);

  // 1. Schedule + probable starters
  let scheduleGames = [];
  try {
    scheduleGames = await mlb.fetchScheduleWithProbables(gameDate);
    for (const g of scheduleGames) {
      await upsertGame(g, gameDate);
    }
    console.log(`  Schedule: ${scheduleGames.length} game(s) upserted.`);
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
      console.log(`  Odds: matched ${matched}/${scheduleGames.length} game(s).`);
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
  console.log(`  Pitcher form: ${pitcherOk}/${starterIds.size} pitcher(s) updated.`);

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
      try {
        hitters = await mlb.fetchConfirmedLineup(g.gamePk, side);
        if (!hitters.length) {
          hitters = await mlb.fetchActiveHitters(teamId);
        }
      } catch (err) {
        warnings.push(`Batter lineup unavailable for ${team} — check manually. (${err.message})`);
        console.warn(`  Lineup fetch failed for ${team}: ${err.message}`);
        continue;
      }
      for (const hitter of hitters) {
        battersTotal++;
        try {
          const log = await mlb.fetchBatterGameLog(hitter.id, season);
          const stats = computeBatterStats(log);
          await upsertBatterForm(pool, { gameDate, batterId: hitter.id, batterName: hitter.fullName, team, ...stats });
          battersOk++;
        } catch (err) {
          warnings.push(`Batter form unavailable for ${hitter.fullName ?? hitter.id} — check manually. (${err.message})`);
        }
      }
    }
  }
  console.log(`  Batter form: ${battersOk}/${battersTotal} batter(s) updated.`);

  // 5. Weather — one lookup per unique venue playing today.
  const venues = new Map();
  for (const g of scheduleGames) {
    if (g.venue && !venues.has(g.venue)) venues.set(g.venue, g.gameDate);
  }
  let windOk = 0;
  for (const [venue, gameTimeUtc] of venues) {
    try {
      const { rows } = await pool.query(
        'SELECT latitude, longitude, out_bearing_degrees FROM park_orientations WHERE lower(venue) = lower($1)',
        [venue]
      );
      if (!rows.length) {
        warnings.push(`No park orientation data for venue "${venue}" — wind check skipped.`);
        continue;
      }
      const { latitude, longitude, out_bearing_degrees } = rows[0];
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
  console.log(`  Weather: ${windOk}/${venues.size} venue(s) updated.`);

  // Filters + digest
  const moneyline = await runMoneylineFilter(pool, gameDate);
  const hitStreak = await runHitStreakFilter(pool, gameDate);
  const windHr = await runWindHrFilter(pool, gameDate);

  await saveDigest(pool, gameDate, 'moneyline', moneyline);
  await saveDigest(pool, gameDate, 'hit_streak', hitStreak);
  await saveDigest(pool, gameDate, 'wind_hr', windHr);

  printDigest({ gameDate, warnings, moneyline, hitStreak, windHr });
}

main()
  .catch((err) => {
    console.error('Job failed with an unexpected error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

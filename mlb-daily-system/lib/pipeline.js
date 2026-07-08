import { pool } from './db.js';
import * as mlb from './sources/mlbStats.js';
import { fetchMoneylines, normalizeTeam } from './sources/odds.js';
import { fetchWindAt } from './sources/weather.js';
import { isWindBlowingOut } from './geo.js';
import { computeTrailingPitcherStats, upsertPitcherForm } from './pitcherForm.js';
import { computeBatterStats, upsertBatterForm } from './batterForm.js';
import { runMoneylineFilter, BAND_LOW, BAND_HIGH } from './filters/moneyline.js';
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
      const unmatched = [];
      for (const g of scheduleGames) {
        const m = moneylines.find(
          (o) =>
            normalizeTeam(o.homeTeam) === normalizeTeam(g.homeTeamName) &&
            normalizeTeam(o.awayTeam) === normalizeTeam(g.awayTeamName)
        );
        if (!m || (m.homeMl === null && m.awayMl === null)) {
          unmatched.push(`${g.awayTeamName} @ ${g.homeTeamName}`);
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
      // Per-game mismatches used to only go to console.warn, which nobody
      // using the site could ever see — this was the second half of the
      // "moneyline is empty and nobody knows why" bug (the first half was
      // the top-level ODDS_API_KEY check above). Surface it for real.
      if (scheduleGames.length > 0 && matched === 0) {
        const sample = moneylines.slice(0, 5).map((m) => `${m.awayTeam} @ ${m.homeTeam}`).join('; ');
        warnings.push(
          `Odds data fetched but matched 0 of ${scheduleGames.length} games by team name — check manually. ` +
            `The Odds API returned ${moneylines.length} game(s)${sample ? `, e.g. ${sample}` : ''}.`
        );
      } else if (unmatched.length) {
        warnings.push(`No moneyline found for ${unmatched.length} game(s): ${unmatched.join('; ')}`);
      }
    } catch (err) {
      warnings.push(`Odds data unavailable — check manually. (${err.message})`);
      console.warn(`  Odds fetch failed: ${err.message}`);
    }
  }

  // 3. Full active roster — every pitcher and every position player on
  // both teams' 26-man active rosters, for every game today. Not just
  // today's two probable starters and the confirmed lineup: the whole
  // staff and the whole bench. More API calls and a longer run than
  // pulling just the narrow slice, done sequentially on purpose (kinder
  // to the free, unauthenticated MLB Stats API), but it means every
  // signal is scored off a complete roster picture, and a probable-
  // pitcher swap or a hot bench bat doesn't need its own extra live
  // fetch — the data's already on file from this pass.
  const gameSideByTeam = new Map(); // teamId -> { gamePk, side }
  const teamNameById = new Map();
  for (const g of scheduleGames) {
    if (g.homeTeamId) {
      teamNameById.set(g.homeTeamId, g.homeTeamName);
      if (!gameSideByTeam.has(g.homeTeamId)) gameSideByTeam.set(g.homeTeamId, { gamePk: g.gamePk, side: 'home' });
    }
    if (g.awayTeamId) {
      teamNameById.set(g.awayTeamId, g.awayTeamName);
      if (!gameSideByTeam.has(g.awayTeamId)) gameSideByTeam.set(g.awayTeamId, { gamePk: g.gamePk, side: 'away' });
    }
  }

  let pitcherOk = 0;
  let pitcherTotal = 0;
  let battersOk = 0;
  let battersTotal = 0;

  for (const [teamId, team] of teamNameById) {
    const gameSide = gameSideByTeam.get(teamId);
    let confirmedSet = null;
    if (gameSide) {
      try {
        const confirmed = await mlb.fetchConfirmedLineup(gameSide.gamePk, gameSide.side);
        if (confirmed.length) confirmedSet = new Set(confirmed.map((p) => p.id));
      } catch (err) {
        warnings.push(`Batter lineup unavailable for ${team} — check manually. (${err.message})`);
        console.warn(`  Lineup fetch failed for ${team}: ${err.message}`);
      }
    }
    if (!confirmedSet) {
      warnings.push(`${team}'s lineup isn't posted yet — batter status will show as projected until it is.`);
    }

    let roster;
    try {
      roster = await mlb.fetchActiveRoster(teamId);
    } catch (err) {
      warnings.push(`Active roster unavailable for ${team} — check manually. (${err.message})`);
      console.warn(`  Roster fetch failed for ${team}: ${err.message}`);
      continue;
    }

    for (const pitcher of roster.pitchers) {
      pitcherTotal++;
      try {
        const [gameLog, seasonEra] = await Promise.all([
          mlb.fetchPitcherGameLog(pitcher.id, season),
          mlb.fetchPitcherSeasonEra(pitcher.id, season),
        ]);
        const trailing = computeTrailingPitcherStats(gameLog);
        await upsertPitcherForm(pool, { gameDate, pitcherId: pitcher.id, pitcherName: pitcher.fullName, seasonEra, ...trailing });
        pitcherOk++;
      } catch (err) {
        warnings.push(`Pitcher form unavailable for ${pitcher.fullName ?? pitcher.id} — check manually. (${err.message})`);
      }
    }

    for (const hitter of roster.hitters) {
      battersTotal++;
      try {
        const batterLog = await mlb.fetchBatterGameLog(hitter.id, season);
        const stats = computeBatterStats(batterLog);
        await upsertBatterForm(pool, {
          gameDate,
          batterId: hitter.id,
          batterName: hitter.fullName,
          team,
          lineupConfirmed: confirmedSet ? confirmedSet.has(hitter.id) : false,
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
  log(`Pitcher form: ${pitcherOk}/${pitcherTotal} pitcher(s) updated across ${teamNameById.size} team(s).`);
  log(`Batter form: ${battersOk}/${battersTotal} batter(s) updated across ${teamNameById.size} team(s).`);

  // 3b. Re-confirm the away starter for games that already clear the
  // moneyline odds band. Probable starters are usually announced well
  // before game day and are far more stable than same-day lineups, but a
  // late scratch or doubleheader shuffle would otherwise silently lock a
  // pick to whichever pitcher was probable at the last full schedule
  // fetch. Scoped to just the odds-qualifying games (typically a
  // handful, not the whole slate). The full-roster pass above already
  // has trailing ERA on file for whoever's on the active roster, so a
  // swap usually needs no extra fetch here — only an emergency call-up
  // who wasn't on the roster yet at pull time falls back to a live one.
  const { rows: bandGames } = await pool.query(
    'SELECT mlb_game_id, home_team, away_team, away_starter_id, away_starter_name FROM games WHERE game_date = $1 AND home_ml IS NOT NULL AND home_ml BETWEEN $2 AND $3',
    [gameDate, BAND_LOW, BAND_HIGH]
  );
  let pitcherSwaps = 0;
  for (const g of bandGames) {
    try {
      const fresh = await mlb.fetchGameProbables(g.mlb_game_id);
      if (!fresh || !fresh.awayStarterId) continue;
      if (fresh.awayStarterId !== g.away_starter_id) {
        pitcherSwaps++;
        warnings.push(
          `Probable starter changed for ${g.away_team} @ ${g.home_team}: was ${g.away_starter_name ?? 'unknown'}, ` +
            `now ${fresh.awayStarterName ?? 'unknown'}. Refreshed before scoring this pick.`
        );
        await pool.query('UPDATE games SET away_starter_id = $1, away_starter_name = $2 WHERE mlb_game_id = $3', [
          fresh.awayStarterId,
          fresh.awayStarterName,
          g.mlb_game_id,
        ]);
        const { rows: existing } = await pool.query(
          'SELECT 1 FROM pitcher_form WHERE game_date = $1 AND pitcher_id = $2',
          [gameDate, fresh.awayStarterId]
        );
        if (!existing.length) {
          const [gameLog, seasonEra] = await Promise.all([
            mlb.fetchPitcherGameLog(fresh.awayStarterId, season),
            mlb.fetchPitcherSeasonEra(fresh.awayStarterId, season),
          ]);
          const trailing = computeTrailingPitcherStats(gameLog);
          await upsertPitcherForm(pool, {
            gameDate,
            pitcherId: fresh.awayStarterId,
            pitcherName: fresh.awayStarterName,
            seasonEra,
            ...trailing,
          });
        }
      }
    } catch (err) {
      warnings.push(`Could not re-confirm the probable starter for ${g.away_team} @ ${g.home_team} — check manually. (${err.message})`);
    }
  }
  if (bandGames.length) {
    log(`Pitcher re-confirmation: checked ${bandGames.length} moneyline-band game(s), ${pitcherSwaps} swap(s) found.`);
  }

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
  // Persisted so a past date's digest still shows why its data may be
  // incomplete (e.g. odds unavailable that day), not just the most recent
  // run's in-memory warnings.
  await saveDigest(pool, gameDate, 'warnings', { warnings });

  const trackedCount = await recordTrackedPicks(pool, gameDate, { moneyline, hitStreak, windHr });
  log(`Tracked picks: ${trackedCount} new row(s) added to the ledger.`);

  return { gameDate, warnings, moneyline, hitStreak, windHr, topPicks };
}

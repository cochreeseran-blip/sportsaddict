import { pool } from './db.js';
import * as mlb from './sources/mlbStats.js';
import { fetchMoneylines, normalizeTeam } from './sources/odds.js';
import { fetchWindAt } from './sources/weather.js';
import { isWindBlowingOut } from './geo.js';
import { computeTrailingPitcherStats, computeStrikeoutStats, upsertPitcherForm } from './pitcherForm.js';
import { computeBatterStats, upsertBatterForm } from './batterForm.js';
import { runMoneylineFilter, BAND_LOW, BAND_HIGH } from './filters/moneyline.js';
import { runHitStreakFilter } from './filters/hitStreak.js';
import { runWindHrFilter } from './filters/windHr.js';
import { runStrikeoutFilter } from './filters/strikeouts.js';
import { saveDigest } from './digest.js';
import { buildTopPicks } from './topPicks.js';
import { recordTrackedPicks } from './trackedPicks.js';
import { runWithConcurrency } from './util/concurrency.js';
import { syncParkBearings } from './parkBearings.js';

// How many player stat lookups run in flight at once during the full-roster
// pass. Sequential would mean ~1,000+ calls back to back on a full slate;
// unbounded parallel would slam a free, unauthenticated API with hundreds of
// simultaneous connections. This is the middle ground.
const PLAYER_FETCH_CONCURRENCY = 5;

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
  // staff and the whole bench. Many more API calls than pulling just the
  // narrow slice, capped at PLAYER_FETCH_CONCURRENCY in flight at once so
  // a full slate stays fast without slamming the free, unauthenticated
  // MLB Stats API. Every signal ends up scored off a complete roster
  // picture, and a probable-pitcher swap or a hot bench bat doesn't need
  // its own extra live
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

  const lineupsPending = [];
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
      lineupsPending.push(team);
    }

    let roster;
    try {
      roster = await mlb.fetchActiveRoster(teamId);
    } catch (err) {
      warnings.push(`Active roster unavailable for ${team} — check manually. (${err.message})`);
      console.warn(`  Roster fetch failed for ${team}: ${err.message}`);
      continue;
    }

    await runWithConcurrency(roster.pitchers, PLAYER_FETCH_CONCURRENCY, async (pitcher) => {
      pitcherTotal++;
      try {
        const [gameLog, seasonEra] = await Promise.all([
          mlb.fetchPitcherGameLog(pitcher.id, season),
          mlb.fetchPitcherSeasonEra(pitcher.id, season),
        ]);
        const trailing = computeTrailingPitcherStats(gameLog);
        const strikeouts = computeStrikeoutStats(gameLog);
        await upsertPitcherForm(pool, { gameDate, pitcherId: pitcher.id, pitcherName: pitcher.fullName, seasonEra, ...trailing, ...strikeouts });
        pitcherOk++;
      } catch (err) {
        warnings.push(`Pitcher form unavailable for ${pitcher.fullName ?? pitcher.id} — check manually. (${err.message})`);
      }
    });

    await runWithConcurrency(roster.hitters, PLAYER_FETCH_CONCURRENCY, async (hitter) => {
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
    });
  }
  log(`Pitcher form: ${pitcherOk}/${pitcherTotal} pitcher(s) updated across ${teamNameById.size} team(s).`);
  log(`Batter form: ${battersOk}/${battersTotal} batter(s) updated across ${teamNameById.size} team(s).`);
  // One status line, not one warning per team. Unposted lineups before
  // game time are normal (MLB posts them 1-3 hours before first pitch),
  // and a 30-line wall of "lineup isn't posted" reads like the app is
  // broken when nothing is wrong.
  if (lineupsPending.length) {
    warnings.push(
      `Lineups not posted yet for ${lineupsPending.length} of ${teamNameById.size} team(s) — normal until 1-3 hours ` +
        `before each game. Their batters show as projected, and refresh again closer to game time to pick them up.`
    );
  }

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
    `SELECT mlb_game_id, home_team, away_team,
            home_starter_id, home_starter_name, away_starter_id, away_starter_name
     FROM games WHERE game_date = $1 AND home_ml IS NOT NULL AND home_ml BETWEEN $2 AND $3`,
    [gameDate, BAND_LOW, BAND_HIGH]
  );

  // Make sure this pitcher's trailing/season ERA is on file, fetching it
  // live only if the full-roster pass didn't already capture it (e.g. an
  // emergency call-up who wasn't rostered at pull time).
  async function ensurePitcherForm(pitcherId, pitcherName) {
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM pitcher_form WHERE game_date = $1 AND pitcher_id = $2',
      [gameDate, pitcherId]
    );
    if (existing.length) return;
    const [gameLog, seasonEra] = await Promise.all([
      mlb.fetchPitcherGameLog(pitcherId, season),
      mlb.fetchPitcherSeasonEra(pitcherId, season),
    ]);
    await upsertPitcherForm(pool, {
      gameDate,
      pitcherId,
      pitcherName,
      seasonEra,
      ...computeTrailingPitcherStats(gameLog),
      ...computeStrikeoutStats(gameLog),
    });
  }

  // The new moneyline screener compares BOTH starters (home must have the
  // better ERA), so re-confirm both probables here, not just the visitor.
  let pitcherSwaps = 0;
  for (const g of bandGames) {
    let fresh;
    try {
      fresh = await mlb.fetchGameProbables(g.mlb_game_id);
    } catch (err) {
      warnings.push(`Could not re-confirm the probable starters for ${g.away_team} @ ${g.home_team} — check manually. (${err.message})`);
      continue;
    }
    if (!fresh) continue;
    const sides = [
      { side: 'home', col: 'home_starter', freshId: fresh.homeStarterId, freshName: fresh.homeStarterName, oldId: g.home_starter_id, oldName: g.home_starter_name },
      { side: 'away', col: 'away_starter', freshId: fresh.awayStarterId, freshName: fresh.awayStarterName, oldId: g.away_starter_id, oldName: g.away_starter_name },
    ];
    for (const s of sides) {
      if (!s.freshId || s.freshId === s.oldId) continue;
      pitcherSwaps++;
      warnings.push(
        `${s.side === 'home' ? g.home_team : g.away_team}'s probable starter changed: was ${s.oldName ?? 'unknown'}, ` +
          `now ${s.freshName ?? 'unknown'}. Refreshed before scoring this pick.`
      );
      await pool.query(
        `UPDATE games SET ${s.col}_id = $1, ${s.col}_name = $2 WHERE mlb_game_id = $3`,
        [s.freshId, s.freshName, g.mlb_game_id]
      );
      try {
        await ensurePitcherForm(s.freshId, s.freshName);
      } catch (err) {
        warnings.push(`Could not load form for ${s.freshName ?? s.freshId} — check manually. (${err.message})`);
      }
    }
  }
  if (bandGames.length) {
    log(`Pitcher re-confirmation: checked ${bandGames.length} moneyline-band game(s), ${pitcherSwaps} swap(s) found.`);
  }

  // 4b. Park bearings — sync every venue's field orientation from MLB's
  // venues endpoint (one request), validated against the league-wide
  // orientation band before anything is stored. This is what feeds the
  // wind/HR filter; without it every park sits at "unverified" and the
  // whole wind category stays dark.
  const bearingSync = await syncParkBearings(pool, season);
  if (bearingSync.warning) {
    warnings.push(bearingSync.warning);
  }
  log(`Park bearings: ${bearingSync.updated} venue(s) synced from MLB${bearingSync.skipped ? `, ${bearingSync.skipped} skipped` : ''}.`);

  // 5. Weather — one lookup per unique venue playing today.
  const venues = new Map();
  for (const g of scheduleGames) {
    if (g.venue && !venues.has(g.venue)) venues.set(g.venue, g.gameDate);
  }
  let windOk = 0;
  let windSkippedUnverified = 0;
  const unverifiedVenues = [];
  for (const [venue, gameTimeUtc] of venues) {
    try {
      const { rows } = await pool.query(
        'SELECT latitude, longitude, out_bearing_degrees, confidence FROM park_orientations WHERE lower(venue) = lower($1)',
        [venue]
      );
      if (!rows.length) {
        unverifiedVenues.push(venue);
        continue;
      }
      const { latitude, longitude, out_bearing_degrees } = rows[0];
      if (out_bearing_degrees === null) {
        // Bearing is unverified — computing "blowing out" from an unknown
        // orientation would be a silent guess. Explicitly clear any stale
        // wind_blowing_out from a prior run rather than leaving it.
        windSkippedUnverified++;
        unverifiedVenues.push(venue);
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
  if (unverifiedVenues.length) {
    warnings.push(
      `Wind check skipped at ${unverifiedVenues.length} park(s) with no verified orientation: ${unverifiedVenues.join(', ')}.`
    );
  }
  log(`Weather: ${windOk}/${venues.size} venue(s) updated (${windSkippedUnverified} skipped — unverified park orientation).`);

  // Filters + digest
  const moneyline = await runMoneylineFilter(pool, gameDate);
  const hitStreak = await runHitStreakFilter(pool, gameDate);
  const windHr = await runWindHrFilter(pool, gameDate);
  const strikeouts = await runStrikeoutFilter(pool, gameDate);
  warnings.push(...(windHr.warnings || []));

  // Pooled cross-category ranking for the dashboard's Top 3 hero section.
  // Heuristic and explainable, not a model — see lib/topPicks.js.
  const topPicks = buildTopPicks({ moneyline, hitStreak, windHr });

  await saveDigest(pool, gameDate, 'moneyline', moneyline);
  await saveDigest(pool, gameDate, 'hit_streak', hitStreak);
  await saveDigest(pool, gameDate, 'wind_hr', windHr);
  await saveDigest(pool, gameDate, 'strikeouts', strikeouts);
  await saveDigest(pool, gameDate, 'top_picks', { picks: topPicks });
  // Persisted so a past date's digest still shows why its data may be
  // incomplete (e.g. odds unavailable that day), not just the most recent
  // run's in-memory warnings.
  await saveDigest(pool, gameDate, 'warnings', { warnings });

  const trackedCount = await recordTrackedPicks(pool, gameDate, { moneyline, hitStreak, windHr });
  log(`Tracked picks: ${trackedCount} new row(s) added to the ledger.`);

  return { gameDate, warnings, moneyline, hitStreak, windHr, strikeouts, topPicks };
}

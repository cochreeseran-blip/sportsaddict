// End-to-end tests for the tiered hit board, the home run board, and the
// performance breakdown. Runs against LOCAL Postgres only (asserted
// below), seeding a controlled fixture slate so every assertion is about
// this code's behaviour, never about whatever real data happens to exist.
import 'dotenv/config';
import { pool } from '../lib/db.js';
import { runMigrations } from '../lib/migrate.js';
import { ensureAuthSchema } from '../lib/auth.js';
import { ensureInsertSafety } from '../lib/schemaGuard.js';
import { runHitStreakFilter } from '../lib/filters/hitStreak.js';
import { runWindHrFilter } from '../lib/filters/windHr.js';
import { projectHits } from '../lib/hitProjection.js';
import { scoreHomeRunProp } from '../lib/grading.js';
import { buildPerformanceBreakdown, MIN_GRADED_FOR_RATE } from '../lib/performance.js';
import { multiHitCandidates, hitPropCandidates, homeRunCandidates } from '../lib/topPicks.js';
import { computeBatterStats } from '../lib/batterForm.js';

const LOCAL = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
if (!LOCAL) {
  console.error('REFUSING TO RUN: DATABASE_URL is not local.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const DATE = '2031-05-05'; // far-future fixture date, cannot collide with real data
const GAME = 'SIGTEST1';

// Remove every fixture row this script creates. Published tracked_picks
// rows cannot be deleted through a normal DELETE (the tracked_picks_guard
// trigger refuses, which is exactly the protection the product's public
// record depends on), so that protection is dropped for this one targeted
// cleanup inside a transaction and restored immediately. Safe only because
// this script refuses to run against anything but local Postgres, asserted
// at the top of the file. Same pattern as scripts/test-admin.js.
//
// Called at BOTH ends of the run: leftovers from a previous failed run
// would otherwise block the next seed, since a published row survives.
async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE tracked_picks DISABLE TRIGGER USER');
    await c.query('DELETE FROM tracked_picks WHERE game_date = $1', [DATE]);
    await c.query('ALTER TABLE tracked_picks ENABLE TRIGGER USER');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  await pool.query('DELETE FROM batter_form WHERE game_date = $1', [DATE]);
  await pool.query('DELETE FROM pitcher_form WHERE game_date = $1', [DATE]);
  await pool.query('DELETE FROM games WHERE game_date = $1', [DATE]);
  await pool.query('DELETE FROM pitcher_game_logs WHERE player_id IN (9001, 9002)');
  await pool.query('DELETE FROM savant_batter_metrics WHERE player_id IN (8001, 8002, 8003)');
  await pool.query('DELETE FROM savant_pitcher_metrics WHERE player_id IN (9001, 9002)');
}

async function seed() {
  await cleanup();

  await pool.query(
    `INSERT INTO games (game_date, mlb_game_id, home_team, away_team, game_time_utc, venue,
                        home_starter_id, home_starter_name, away_starter_id, away_starter_name, home_ml)
     VALUES ($1, $2, 'Detroit Tigers', 'Chicago White Sox', now() + interval '6 hours', 'Comerica Park',
             9001, 'Home Arm', 9002, 'Batting Practice', -140)`,
    [DATE, GAME]
  );

  // Three batters with deliberately different profiles:
  //  8001 elite leadoff masher  -> should top both hit tiers and the HR board
  //  8002 slap hitter, 9-hole   -> 1+ tier only, never 2+
  //  8003 low-average power bat -> HR board only
  const batters = [
    [8001, 'Elite Masher', 'Detroit Tigers', 8, 0.355, 62, 0.40, 1, 0.47, 15],
    [8002, 'Slap Hitter', 'Detroit Tigers', 2, 0.301, 55, 0.02, 9, 0.07, 15],
    [8003, 'Power Only', 'Detroit Tigers', 0, 0.223, 48, 0.33, 4, 0.13, 15],
  ];
  for (const [id, name, team, streak, avg, ab, hrRate, slot, multiHitRate, games] of batters) {
    await pool.query(
      `INSERT INTO batter_form (game_date, batter_id, batter_name, team, hit_streak, trailing_15_avg,
                                trailing_15_ab, trailing_15_hr_rate, lineup_confirmed, last5_results,
                                batting_order_slot, trailing_15_multi_hit_rate, trailing_15_games)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,'[]',$9,$10,$11)`,
      [DATE, id, name, team, streak, avg, ab, hrRate, slot, multiHitRate, games]
    );
  }

  // Away starter: gets hit hard and gives up homers.
  await pool.query(
    `INSERT INTO pitcher_form (game_date, pitcher_id, pitcher_name, trailing_era, season_era)
     VALUES ($1, 9002, 'Batting Practice', 7.20, 6.10), ($1, 9001, 'Home Arm', 3.10, 3.30)`,
    [DATE]
  );
  // Game logs behind the H/9 and HR/9 the filters compute from.
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO pitcher_game_logs (player_id, player_name, team_abbr, game_date, game_pk, opponent_abbr,
                                      innings_pitched, hits_allowed, runs_allowed, earned_runs, walks,
                                      strikeouts, home_runs_allowed)
       VALUES (9002, 'Batting Practice', 'CWS', $1, $2, 'DET', 5.0, 8, 5, 5, 2, 3, 2)
       ON CONFLICT (player_id, game_pk) DO NOTHING`,
      [`2031-04-0${i + 1}`, 990000 + i]
    );
  }

  // Savant: masher has elite barrel/exit velo, slap hitter has none of it.
  const savant = [
    [8001, 0.315, 0.610, 16.5, 52.0, 94.5],
    [8002, 0.268, 0.330, 2.1, 26.0, 85.2],
    [8003, 0.232, 0.505, 13.0, 47.0, 92.8],
  ];
  for (const [id, xba, xslg, barrel, hardHit, elo] of savant) {
    await pool.query(
      `INSERT INTO savant_batter_metrics (player_id, season, pull_date, xba, xslg, barrel_pct, hard_hit_pct, avg_exit_velo)
       VALUES ($1, 2031, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (player_id, pull_date) DO UPDATE SET xba = EXCLUDED.xba`,
      [id, DATE, xba, xslg, barrel, hardHit, elo]
    );
  }
  await pool.query(
    `INSERT INTO savant_pitcher_metrics (player_id, season, pull_date, barrel_pct, hard_hit_pct, k_pct)
     VALUES (9002, 2031, $1, 12.5, 48.0, 15.0)
     ON CONFLICT (player_id, pull_date) DO UPDATE SET barrel_pct = EXCLUDED.barrel_pct`,
    [DATE]
  );
}

async function main() {
  await runMigrations(pool);
  await ensureAuthSchema(pool);
  await ensureInsertSafety(pool);
  await seed();

  // --- 1. The projection model itself -------------------------------------
  const elite = projectHits({ trailing15Avg: 0.355, xba: 0.315, opposingHitsPer9: 14.4, battingOrderSlot: 1 });
  const weak = projectHits({ trailing15Avg: 0.240, xba: 0.235, opposingHitsPer9: 6.0, battingOrderSlot: 9 });
  check(
    '1. Projection ranks a leadoff masher above a 9-hole slap hitter on both tiers',
    elite.pAtLeastOne > weak.pAtLeastOne && elite.pAtLeastTwo > weak.pAtLeastTwo,
    `elite P(1+)=${elite.pAtLeastOne} P(2+)=${elite.pAtLeastTwo}; weak P(1+)=${weak.pAtLeastOne} P(2+)=${weak.pAtLeastTwo}`
  );
  check(
    '2. P(2+) is always below P(1+) (tiers cannot contradict)',
    elite.pAtLeastTwo < elite.pAtLeastOne && weak.pAtLeastTwo < weak.pAtLeastOne,
    'nested probabilities hold'
  );
  const noSavant = projectHits({ trailing15Avg: 0.300, xba: null, opposingHitsPer9: null, battingOrderSlot: 3 });
  check(
    '3. Projection still returns a usable number with no Savant data',
    noSavant.pAtLeastOne > 0 && noSavant.pAtLeastOne < 1,
    `P(1+)=${noSavant.pAtLeastOne} from ${noSavant.basis}`
  );
  const lucky = projectHits({ trailing15Avg: 0.380, xba: 0.215, opposingHitsPer9: 8.6, battingOrderSlot: 2 });
  check(
    '4. A lucky-streak bat is pulled down by weak xBA',
    lucky.hitProbPerAb < 0.380,
    `.380 average blends down to ${lucky.hitProbPerAb} per at-bat`
  );

  // --- 2. The hit board ----------------------------------------------------
  const hits = await runHitStreakFilter(pool, DATE);
  const multiNames = (hits.multiHit || []).map((b) => b.batterName);
  check(
    '5. Hit filter returns the 2+ board, and no retired 1+ board',
    Array.isArray(hits.multiHit) && hits.singleHit === undefined,
    `2+ tier: [${multiNames.join(', ')}]; singleHit is ${hits.singleHit === undefined ? 'absent as intended' : 'STILL PRESENT'}`
  );
  check(
    '6. The elite leadoff bat leads the 2+ tier',
    multiNames[0] === 'Elite Masher',
    `top of 2+ board is ${multiNames[0] ?? '(empty)'}`
  );
  check(
    '7. The 9-hole slap hitter never reaches the 2+ tier',
    !multiNames.includes('Slap Hitter'),
    'excluded as designed'
  );
  const eliteRow = (hits.multiHit || []).find((b) => b.batterName === 'Elite Masher');
  check(
    '8. Every hit card carries its projection and its empirical multi-hit rate',
    eliteRow && eliteRow.expectedHits > 0 && eliteRow.pAtLeastTwo > 0 && eliteRow.multiHitRate === 0.47,
    eliteRow ? `xH=${eliteRow.expectedHits}, P(2+)=${eliteRow.pAtLeastTwo}, actual multi-hit rate=${eliteRow.multiHitRate}` : 'row missing'
  );
  const sortedDesc = (hits.multiHit || []).every((b, i, arr) => i === 0 || arr[i - 1].pAtLeastTwo >= b.pAtLeastTwo);
  check('9. 2+ tier is ordered by P(2+) descending', sortedDesc, 'ordering verified');

  // --- 3. Candidate shaping (what lands in the ledger) ---------------------
  const multiCands = multiHitCandidates(hits);
  const singleCands = hitPropCandidates(hits);
  const eliteFromBoard = (hits.multiHit || []).find((b) => b.batterName === 'Elite Masher');
  check(
    '10. Multi-hit candidates carry signal_type multi_hit and a 2+ headline',
    multiCands.length > 0 && multiCands[0].type === 'multi_hit' && /2\+ hits/.test(multiCands[0].headline),
    multiCands[0]?.headline ?? 'none'
  );
  // The 1+ tier is retired: it must generate NOTHING new, while P(1+) is
  // still computed and carried on each card as supporting context.
  check(
    '11. The retired 1+ tier generates no new picks, but P(1+) is still carried',
    singleCands.length === 0 && eliteFromBoard && eliteFromBoard.pAtLeastOne > 0,
    `hitPropCandidates returned ${singleCands.length}; P(1+) on the card is still ${eliteFromBoard?.pAtLeastOne}`
  );

  // --- 4. The home run board ----------------------------------------------
  const hr = await runWindHrFilter(pool, DATE);
  const hrNames = (hr.watchList || []).map((b) => b.batterName);
  check(
    '12. HR board surfaces power bats and excludes the slap hitter',
    hrNames.includes('Elite Masher') && hrNames.includes('Power Only') && !hrNames.includes('Slap Hitter'),
    `board: [${hrNames.join(', ')}]`
  );
  const hrTop = (hr.watchList || [])[0];
  check(
    '13. HR cards carry the Statcast inputs the score is built from',
    hrTop && hrTop.barrelPct !== null && hrTop.avgExitVelo !== null && hrTop.opposingHrPer9 !== null,
    hrTop ? `${hrTop.batterName}: barrel ${hrTop.barrelPct}%, ${hrTop.avgExitVelo} mph, opposing ${hrTop.opposingHrPer9} HR/9` : 'empty board'
  );
  const noBarrel = scoreHomeRunProp({
    barrelPct: null, avgExitVelo: null, hardHitPct: null, xslg: null,
    trailing15HrRate: 0.60, opposingHrPer9: 2.5, opposingBarrelPct: 12, windBlowingOut: true, windSpeedMph: 20, battingOrderSlot: 3,
  });
  check(
    '14. Without Savant barrel data an HR pick cannot grade above B',
    noBarrel.score <= 69,
    `hot-streak-only bat capped at ${noBarrel.score} (${noBarrel.grade})`
  );
  const hrCands = homeRunCandidates(hr);
  check(
    '15. HR candidates carry signal_type home_run',
    hrCands.length > 0 && hrCands.every((c) => c.type === 'home_run'),
    `${hrCands.length} candidate(s)`
  );

  // --- 5. Multi-hit rate computation --------------------------------------
  const splits = [
    { stat: { plateAppearances: 4, atBats: 4, hits: 2, homeRuns: 0 } },
    { stat: { plateAppearances: 4, atBats: 4, hits: 3, homeRuns: 1 } },
    { stat: { plateAppearances: 4, atBats: 4, hits: 1, homeRuns: 0 } },
    { stat: { plateAppearances: 4, atBats: 4, hits: 0, homeRuns: 0 } },
  ];
  const stats = computeBatterStats(splits);
  check(
    '16. Multi-hit rate counts only games with 2+ hits',
    stats.trailing15MultiHitRate === 0.5 && stats.trailing15Games === 4,
    `2 of 4 games were multi-hit -> ${stats.trailing15MultiHitRate}`
  );

  // --- 6. Grading thresholds ----------------------------------------------
  // A 1-hit game must win the 1+ pick and lose the 2+ pick on the same day.
  await pool.query(
    `INSERT INTO tracked_picks (game_date, signal_type, mlb_game_id, description, qualifying_metrics, result, published)
     VALUES ($1,'hit_streak',$2,'1+ test','{"batterId":8001,"grade":"A"}','win',true),
            ($1,'multi_hit',$2,'2+ test','{"batterId":8001,"grade":"A"}','loss',true),
            ($1,'home_run',$2,'HR test','{"batterId":8003,"grade":"B"}','loss',false),
            ($1,'strikeout',$2,'K test','{"pitcherId":9001,"grade":"A+"}','win',true)`,
    [DATE, GAME]
  );
  const perf = await buildPerformanceBreakdown(pool, {});
  const sigTypes = perf.algorithm.signals.map((s) => s.signalType);
  check(
    '17. Performance breakdown separates every signal type',
    sigTypes.includes('multi_hit') && sigTypes.includes('home_run') && sigTypes.includes('hit_streak') && sigTypes.includes('strikeout'),
    `signals: ${sigTypes.join(', ')}`
  );
  const kRow = perf.algorithm.signals.find((s) => s.signalType === 'strikeout');
  check(
    '18. Win rate is suppressed under the sample threshold, raw W-L still shown',
    kRow && kRow.winRate === null && kRow.wins >= 1 && kRow.rateSuppressed === true,
    `K props ${kRow?.wins}-${kRow?.losses}, rate withheld until ${MIN_GRADED_FOR_RATE} graded`
  );
  const pubOverall = perf.published.overall;
  const algOverall = perf.algorithm.overall;
  check(
    '19. Published scope is a strict subset of the algorithm scope',
    pubOverall.graded <= algOverall.graded && pubOverall.graded > 0,
    `published ${pubOverall.wins}-${pubOverall.losses} of algorithm ${algOverall.wins}-${algOverall.losses}`
  );
  const gradeRows = perf.algorithm.signals.find((s) => s.signalType === 'strikeout')?.grades ?? [];
  check(
    '20. Per-grade breakdown exists inside each signal',
    gradeRows.length > 0 && gradeRows[0].grade === 'A+',
    `strikeout grades: ${gradeRows.map((g) => `${g.grade} ${g.wins}-${g.losses}`).join(', ')}`
  );

  // --- 7. Board shape: slot gate, per-team cap, show-all ------------------
  {
    // Eight more Tigers, all strong enough to qualify, so the per-team cap
    // has something to bite on. Slots 1-6 only, to isolate the cap from
    // the slot gate.
    for (let i = 0; i < 8; i++) {
      await pool.query(
        `INSERT INTO batter_form (game_date, batter_id, batter_name, team, hit_streak, trailing_15_avg,
                                  trailing_15_ab, trailing_15_hr_rate, lineup_confirmed, last5_results,
                                  batting_order_slot, trailing_15_multi_hit_rate, trailing_15_games)
         VALUES ($1,$2,$3,'Detroit Tigers',7,$4,60,0.30,true,'[]',$5,0.40,15)`,
        [DATE, 8100 + i, `Depth Bat ${i}`, 0.330 - i * 0.002, (i % 6) + 1]
      );
      await pool.query(
        `INSERT INTO savant_batter_metrics (player_id, season, pull_date, xba, xslg, barrel_pct, hard_hit_pct, avg_exit_velo)
         VALUES ($1, 2031, $2, 0.305, 0.560, 14.0, 48.0, 93.0)
         ON CONFLICT (player_id, pull_date) DO UPDATE SET xba = EXCLUDED.xba`,
        [8100 + i, DATE]
      );
    }
    // A genuine bottom-of-the-order bat with elite form: the slot gate has
    // to drop him despite numbers that would otherwise top the board.
    await pool.query(
      `INSERT INTO batter_form (game_date, batter_id, batter_name, team, hit_streak, trailing_15_avg,
                                trailing_15_ab, trailing_15_hr_rate, lineup_confirmed, last5_results,
                                batting_order_slot, trailing_15_multi_hit_rate, trailing_15_games)
       VALUES ($1, 8200, 'Eighth Hitter', 'Detroit Tigers', 12, 0.400, 70, 0.40, true, '[]', 8, 0.55, 15)`,
      [DATE]
    );
    await pool.query(
      `INSERT INTO savant_batter_metrics (player_id, season, pull_date, xba, xslg, barrel_pct, hard_hit_pct, avg_exit_velo)
       VALUES (8200, 2031, $1, 0.350, 0.650, 18.0, 55.0, 95.0)
       ON CONFLICT (player_id, pull_date) DO UPDATE SET xba = EXCLUDED.xba`,
      [DATE]
    );

    const hits = await runHitStreakFilter(pool, DATE);
    const names = (hits.multiHit || []).map((b) => b.batterName);
    const allNames = (hits.multiHitAll || []).map((b) => b.batterName);

    check(
      '21. A batter below the lineup-slot cutoff never reaches the board',
      !allNames.includes('Eighth Hitter') && hits.limits.minLineupSlot === 6,
      `slot-8 bat with .400/18% barrel excluded; cutoff is slot ${hits.limits.minLineupSlot}`
    );

    const tigersOnBoard = (hits.multiHit || []).filter((b) => b.team === 'Detroit Tigers').length;
    const tigersRanked = (hits.multiHitAll || []).filter((b) => b.team === 'Detroit Tigers').length;
    check(
      '22. Per-team cap limits the published board but not the ranked list',
      tigersOnBoard <= hits.limits.perTeam && tigersRanked > tigersOnBoard,
      `board has ${tigersOnBoard} Tigers (cap ${hits.limits.perTeam}), full ranked list has ${tigersRanked}`
    );

    check(
      '23. The capped board keeps each team\'s best, not an arbitrary slice',
      names.length > 0 && allNames.slice(0, names.length).join('|') === names.join('|'),
      `board is the top ${names.length} of the ranked list, in order`
    );
  }

  // --- 8. Wind weighting on home runs -------------------------------------
  {
    const base = {
      barrelPct: 15.0, avgExitVelo: 93.2, hardHitPct: 49, xslg: 0.550,
      trailing15HrRate: 0.30, opposingHrPer9: 1.9, opposingBarrelPct: 10.5, battingOrderSlot: 3,
    };
    const noWind = scoreHomeRunProp({ ...base, windBlowingOut: false });
    const lightWind = scoreHomeRunProp({ ...base, windBlowingOut: true, windSpeedMph: 6 });
    const gale = scoreHomeRunProp({ ...base, windBlowingOut: true, windSpeedMph: 18 });

    check(
      '24. Wind out scales with speed instead of a flat bonus',
      gale.score > lightWind.score && lightWind.score > noWind.score,
      `no wind ${noWind.score} < 6 mph ${lightWind.score} < 18 mph ${gale.score}`
    );

    // The confluence bonus fires only when all three conditions hold, so a
    // gale on a weak bat must NOT collect it.
    const weakBatGale = scoreHomeRunProp({
      ...base, barrelPct: 7.0, windBlowingOut: true, windSpeedMph: 18,
    });
    const hasConfluence = (r) => r.reasons.some((x) => x.includes('power bat + homer-prone arm + wind out'));
    check(
      '25. The wind confluence bonus needs all three legs, not just wind',
      hasConfluence(gale) && !hasConfluence(weakBatGale) && !hasConfluence(noWind),
      `elite+arm+gale=${hasConfluence(gale)}, weak bat in same gale=${hasConfluence(weakBatGale)}`
    );

    check(
      '26. The top of the HR scale is reachable without clamping at 100',
      gale.score < 100 && gale.grade === 'A+',
      `best realistic spot scores ${gale.score} (${gale.grade}), leaving headroom to rank within A+`
    );
  }

  await cleanup();

  console.log(`\n${passed}/${passed + failed} tests passed.`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Test run failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});

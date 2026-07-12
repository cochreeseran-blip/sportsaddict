function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// splits must already be sorted most-recent-first. Only counts games the
// batter actually appeared in (plateAppearances > 0), so DNPs in the log
// don't break the hit streak or dilute the trailing average.
export function computeBatterStats(splits, trailingGames = 15) {
  const played = (splits || []).filter((s) => Number(s.stat?.plateAppearances ?? 0) > 0);

  let hitStreak = 0;
  for (const s of played) {
    if (Number(s.stat?.hits ?? 0) >= 1) {
      hitStreak++;
    } else {
      break;
    }
  }

  const last15 = played.slice(0, trailingGames);
  const abSum = last15.reduce((sum, s) => sum + Number(s.stat?.atBats ?? 0), 0);
  const hitsSum = last15.reduce((sum, s) => sum + Number(s.stat?.hits ?? 0), 0);
  const hrSum = last15.reduce((sum, s) => sum + Number(s.stat?.homeRuns ?? 0), 0);

  // Oldest-to-newest so it reads left-to-right as a normal form guide, most
  // recent game on the right.
  const last5Results = played
    .slice(0, 5)
    .map((s) => Number(s.stat?.hits ?? 0) >= 1)
    .reverse();

  return {
    hitStreak,
    trailing15Avg: abSum > 0 ? round3(hitsSum / abSum) : null,
    // Total at-bats behind that average. A tiny denominator (a callup
    // with 2 at-bats going 2-for-2) produces a real but meaningless
    // 1.000, this is what lets a caller tell the two apart, see the
    // MIN_TRAILING_AB gate in lib/filters/hitStreak.js.
    trailing15Ab: abSum,
    trailing15HrRate: last15.length > 0 ? round3(hrSum / last15.length) : null,
    gamesConsidered: last15.length,
    last5Results,
  };
}

export async function upsertBatterForm(pool, record) {
  await pool.query(
    `INSERT INTO batter_form
       (game_date, batter_id, batter_name, team, hit_streak, trailing_15_avg, trailing_15_ab, trailing_15_hr_rate,
        lineup_confirmed, last5_results, position, jersey_number, batting_order_slot, lineup_confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             CASE WHEN $9 THEN now() ELSE NULL END)
     ON CONFLICT (game_date, batter_id) DO UPDATE SET
       batter_name = EXCLUDED.batter_name,
       team = EXCLUDED.team,
       hit_streak = EXCLUDED.hit_streak,
       trailing_15_avg = EXCLUDED.trailing_15_avg,
       trailing_15_ab = EXCLUDED.trailing_15_ab,
       trailing_15_hr_rate = EXCLUDED.trailing_15_hr_rate,
       lineup_confirmed = EXCLUDED.lineup_confirmed,
       last5_results = EXCLUDED.last5_results,
       position = COALESCE(EXCLUDED.position, batter_form.position),
       jersey_number = COALESCE(EXCLUDED.jersey_number, batter_form.jersey_number),
       -- Once a batting order slot is known for the day, keep it even if a
       -- later pass (e.g. the roster-wide pass, which knows nothing about
       -- order) would otherwise null it back out.
       batting_order_slot = COALESCE(EXCLUDED.batting_order_slot, batter_form.batting_order_slot),
       -- Remember the FIRST moment the lineup showed up confirmed that day.
       lineup_confirmed_at = CASE
         WHEN EXCLUDED.lineup_confirmed THEN COALESCE(batter_form.lineup_confirmed_at, now())
         ELSE batter_form.lineup_confirmed_at
       END`,
    [
      record.gameDate,
      record.batterId,
      record.batterName,
      record.team,
      record.hitStreak,
      record.trailing15Avg,
      record.trailing15Ab ?? 0,
      record.trailing15HrRate,
      record.lineupConfirmed,
      JSON.stringify(record.last5Results ?? []),
      record.position ?? null,
      record.jerseyNumber ?? null,
      record.battingOrderSlot ?? null,
    ]
  );
}

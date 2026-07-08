import { fmtOdds } from './util/format.js';
import { buildTopPicks } from './topPicks.js';

function fmtLast5(results) {
  if (!results || !results.length) return 'no data';
  return results.map((hit) => (hit ? 'H' : '-')).join('');
}

function fmtLineup(confirmed) {
  if (confirmed === true) return 'confirmed lineup';
  if (confirmed === false) return 'PROJECTED, not confirmed';
  return 'lineup status unknown';
}

export async function saveDigest(pool, gameDate, signalType, details) {
  await pool.query(
    'INSERT INTO daily_digest (game_date, signal_type, details) VALUES ($1, $2, $3)',
    [gameDate, signalType, JSON.stringify(details)]
  );
}

export function printDigest({ gameDate, warnings, moneyline, hitStreak, windHr }) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log(`MLB DAILY DIGEST — ${gameDate}`);
  console.log(line);

  if (warnings.length) {
    console.log('\n[WARNINGS]');
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const topPicks = buildTopPicks({ moneyline, hitStreak, windHr });
  console.log('\n--- TOP 3 PICKS TODAY ---');
  if (!topPicks.length) {
    console.log('  Not enough qualifying signals today for a top 3.');
  } else {
    topPicks.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.headline}`);
      console.log(`     ${p.detail}`);
    });
  }

  console.log('\n--- MONEYLINE ---');
  if (moneyline.signal === 'SIT') {
    console.log('  SIT — no qualifying games today.');
  } else {
    for (const p of moneyline.picks) {
      console.log(
        `  ${p.homeTeam} (${fmtOdds(p.homeMl)}) over ${p.awayTeam} — ` +
          `${p.awayStarterName ?? 'TBD'} trailing ERA ${p.awayStarterTrailingEra?.toFixed(2)} ` +
          `(season ${p.awayStarterSeasonEra !== null ? p.awayStarterSeasonEra.toFixed(2) : 'n/a'})`
      );
    }
  }
  if (moneyline.otherGames?.length) {
    console.log('  Other home favorites considered:');
    for (const g of moneyline.otherGames) {
      console.log(`    - ${g.awayTeam} @ ${g.homeTeam} (${fmtOdds(g.homeMl)}) — ${g.reason}`);
    }
  }

  console.log('\n--- HIT STREAK / CONTACT WATCH ---');
  if (!hitStreak.watchList.length) {
    console.log('  No qualifying batters today.');
  } else {
    for (const b of hitStreak.watchList) {
      const tag = b.highConfidence ? '[HIGH CONFIDENCE] ' : '';
      console.log(
        `  ${tag}${b.batterName} (${b.team}) [${fmtLineup(b.lineupConfirmed)}] — streak ${b.hitStreak}, avg ${b.trailing15Avg?.toFixed(3)}, last 5: ${fmtLast5(b.last5Results)} ` +
          `vs ${b.opposingStarterName ?? 'TBD'} (ERA ${b.opposingStarterTrailingEra?.toFixed(2) ?? 'n/a'})`
      );
    }
  }

  console.log('\n--- WIND / HR WATCH ---');
  if (!windHr.watchList.length) {
    console.log('  No qualifying batters today.');
  } else {
    console.log(`  (top-third HR rate threshold today: ${windHr.hrRateThreshold?.toFixed(3)})`);
    for (const b of windHr.watchList) {
      const tag = b.highConfidence ? '[HIGH CONFIDENCE] ' : '';
      console.log(
        `  ${tag}${b.batterName} (${b.team}) [${fmtLineup(b.lineupConfirmed)}] — HR rate ${b.trailing15HrRate?.toFixed(3)}, last 5: ${fmtLast5(b.last5Results)} @ ${b.venue} ` +
          `(wind ${b.windSpeedMph?.toFixed(1)} mph out) vs ${b.opposingStarterName ?? 'TBD'} ` +
          `(ERA ${b.opposingStarterTrailingEra?.toFixed(2) ?? 'n/a'})`
      );
    }
  }

  console.log(`\n${line}\n`);
}

import { ipStringToOuts, outsToDecimalInnings } from './util/innings.js';

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Trailing ERA over a pitcher's last N starts (default 5, the moneyline
// screener compares recent form across both starters on that window),
// computed from true outs (not the .1/.2 IP notation) so partial innings
// sum correctly: ERA = earned runs * 27 / outs.
//
// Judgment call: game logs can occasionally include a relief appearance
// mixed into a starter's season log. We filter to entries the API marks as
// starts (stat.gamesStarted >= 1) when that field is present, and just take
// the most recent entries otherwise.
export function computeTrailingPitcherStats(splits, startsCount = 5) {
  const starts = (splits || [])
    .filter((s) => {
      const gs = s.stat?.gamesStarted;
      return gs === undefined || gs === null || Number(gs) >= 1;
    })
    .slice(0, startsCount);

  let outs = 0;
  let er = 0;
  for (const s of starts) {
    outs += ipStringToOuts(s.stat?.inningsPitched);
    er += Number(s.stat?.earnedRuns ?? 0);
  }

  const trailingEra = outs > 0 ? round2((er * 27) / outs) : null;
  return {
    trailingStarts: starts.length,
    trailingIp: round2(outsToDecimalInnings(outs)),
    trailingEr: er,
    trailingEra,
  };
}

// Per-start strikeout counts over the last N starts, from the same game
// log splits the ERA numbers use. last5StartKs reads oldest-to-newest so
// it renders left-to-right as a form guide, most recent start on the
// right.
export function computeStrikeoutStats(splits, startsCount = 5) {
  const starts = (splits || [])
    .filter((s) => {
      const gs = s.stat?.gamesStarted;
      return gs === undefined || gs === null || Number(gs) >= 1;
    })
    .slice(0, startsCount);

  const ks = starts.map((s) => Number(s.stat?.strikeOuts ?? 0));
  return {
    last5StartKs: [...ks].reverse(),
    trailingKPerStart: ks.length ? round2(ks.reduce((a, b) => a + b, 0) / ks.length) : null,
  };
}

export async function upsertPitcherForm(pool, record) {
  await pool.query(
    `INSERT INTO pitcher_form
       (game_date, pitcher_id, pitcher_name, season_era, trailing_starts, trailing_ip, trailing_er, trailing_era,
        last5_start_ks, trailing_k_per_start)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (game_date, pitcher_id) DO UPDATE SET
       pitcher_name = EXCLUDED.pitcher_name,
       season_era = EXCLUDED.season_era,
       trailing_starts = EXCLUDED.trailing_starts,
       trailing_ip = EXCLUDED.trailing_ip,
       trailing_er = EXCLUDED.trailing_er,
       trailing_era = EXCLUDED.trailing_era,
       last5_start_ks = EXCLUDED.last5_start_ks,
       trailing_k_per_start = EXCLUDED.trailing_k_per_start`,
    [
      record.gameDate,
      record.pitcherId,
      record.pitcherName,
      record.seasonEra,
      record.trailingStarts,
      record.trailingIp,
      record.trailingEr,
      record.trailingEra,
      JSON.stringify(record.last5StartKs ?? []),
      record.trailingKPerStart ?? null,
    ]
  );
}

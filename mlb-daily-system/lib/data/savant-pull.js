// Baseball Savant's custom-leaderboard CSV export. Unlike lib/sources/savant.js
// (which scrapes today's probable-pitchers page for just today's starters),
// this pulls the FULL qualified leaderboard for a season in one request --
// what backs both the daily batter/pitcher Savant snapshot (savant_pitcher_
// metrics / savant_batter_metrics) and the historical backfill.
//
// Savant has no documented, versioned public API. This endpoint shape can
// change or throttle without notice, so everything here follows the same
// rule as lib/sources/savant.js: log and degrade to "no Savant data today",
// never fail the pipeline. Every pull's raw CSV is stored in
// savant_raw_pulls before parsing, so a parsing bug never loses data that
// was actually fetched -- reparse from the stored raw text instead of
// re-pulling.
const BASE = process.env.SAVANT_BASE || 'https://baseballsavant.mlb.com';
const USER_AGENT = 'Mozilla/5.0 (compatible; SlatefinderResearch/1.0; +https://slatefinder.lol)';

async function fetchCsv(url, { retried = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Baseball Savant ${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (!retried) {
      // Retry once after 30s, per spec: Savant occasionally throttles a
      // first request and is fine on a second try a beat later.
      await new Promise((r) => setTimeout(r, 30000));
      return fetchCsv(url, { retried: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Minimal CSV parser: handles quoted fields (with embedded commas/quotes),
// which is all a leaderboard export of names + numbers needs. Not a
// general-purpose RFC4180 parser, but sufficient for this one shape.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx]])));
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Reads the first present column out of several candidate header names --
// Savant's export column names have shifted before and aren't documented,
// so this is deliberately tolerant rather than pinned to one exact name.
function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== '') return row[n];
  }
  return null;
}

function pickNum(row, names) {
  return num(pick(row, names));
}

async function pullLeaderboardCsv(type, season) {
  const url = `${BASE}/leaderboard/custom?n=qualified&year=${season}&type=${type}&min=1&csv=true`;
  const csv = await fetchCsv(url);
  const rows = parseCsv(csv);
  return { csv, rows };
}

// Pulls, stores raw, parses, and upserts today's pitcher Savant snapshot
// for a season. Returns { written, rowCount } or throws -- callers (the
// pipeline) are expected to catch and log, same as every other best-effort
// external source in this app.
export async function pullAndStoreSavantPitchers(pool, season, pullDate) {
  const { csv, rows } = await pullLeaderboardCsv('pitcher', season);
  await pool.query(
    `INSERT INTO savant_raw_pulls (pull_type, season, pull_date, raw_csv, row_count) VALUES ('pitcher', $1, $2, $3, $4)`,
    [season, pullDate, csv, rows.length]
  );
  if (!rows.length) {
    console.warn(`  Savant pitcher leaderboard returned no rows for ${season} on ${pullDate} (endpoint shape may have changed).`);
    return { written: 0, rowCount: 0 };
  }
  let written = 0;
  for (const row of rows) {
    const playerId = pickNum(row, ['player_id', 'mlbam_id', 'playerid', 'pitcher_id']);
    if (!playerId) continue;
    await pool.query(
      `INSERT INTO savant_pitcher_metrics
         (player_id, season, pull_date, k_pct, bb_pct, whiff_pct, hard_hit_pct, xera, era, xba_against, barrel_pct, avg_exit_velo, hits_per_9)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (player_id, pull_date) DO UPDATE SET
         k_pct = EXCLUDED.k_pct, bb_pct = EXCLUDED.bb_pct, whiff_pct = EXCLUDED.whiff_pct,
         hard_hit_pct = EXCLUDED.hard_hit_pct, xera = EXCLUDED.xera, era = EXCLUDED.era,
         xba_against = EXCLUDED.xba_against, barrel_pct = EXCLUDED.barrel_pct,
         avg_exit_velo = EXCLUDED.avg_exit_velo, hits_per_9 = EXCLUDED.hits_per_9`,
      [
        playerId, season, pullDate,
        pickNum(row, ['k_percent', 'k_pct', 'so_percent']),
        pickNum(row, ['bb_percent', 'bb_pct', 'walk_percent']),
        pickNum(row, ['whiff_percent', 'whiff_pct']),
        pickNum(row, ['hard_hit_percent', 'hardhit_percent', 'hard_hit_pct']),
        pickNum(row, ['xera', 'x_era', 'est_era']),
        pickNum(row, ['era']),
        pickNum(row, ['xba', 'est_ba', 'xba_against']),
        pickNum(row, ['barrel_percent', 'barrel_pct', 'brl_percent']),
        pickNum(row, ['exit_velocity_avg', 'avg_hit_speed', 'avg_exit_velo']),
        pickNum(row, ['h_per_9', 'hits_per_9']),
      ]
    );
    written++;
  }
  return { written, rowCount: rows.length };
}

export async function pullAndStoreSavantBatters(pool, season, pullDate) {
  const { csv, rows } = await pullLeaderboardCsv('batter', season);
  await pool.query(
    `INSERT INTO savant_raw_pulls (pull_type, season, pull_date, raw_csv, row_count) VALUES ('batter', $1, $2, $3, $4)`,
    [season, pullDate, csv, rows.length]
  );
  if (!rows.length) {
    console.warn(`  Savant batter leaderboard returned no rows for ${season} on ${pullDate} (endpoint shape may have changed).`);
    return { written: 0, rowCount: 0 };
  }
  let written = 0;
  for (const row of rows) {
    const playerId = pickNum(row, ['player_id', 'mlbam_id', 'playerid', 'batter_id']);
    if (!playerId) continue;
    await pool.query(
      `INSERT INTO savant_batter_metrics
         (player_id, season, pull_date, xba, xslg, barrel_pct, hard_hit_pct, k_pct, bb_pct, avg_exit_velo, sprint_speed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (player_id, pull_date) DO UPDATE SET
         xba = EXCLUDED.xba, xslg = EXCLUDED.xslg, barrel_pct = EXCLUDED.barrel_pct,
         hard_hit_pct = EXCLUDED.hard_hit_pct, k_pct = EXCLUDED.k_pct, bb_pct = EXCLUDED.bb_pct,
         avg_exit_velo = EXCLUDED.avg_exit_velo, sprint_speed = EXCLUDED.sprint_speed`,
      [
        playerId, season, pullDate,
        pickNum(row, ['xba', 'est_ba']),
        pickNum(row, ['xslg', 'est_slg']),
        pickNum(row, ['barrel_percent', 'barrel_pct', 'brl_percent']),
        pickNum(row, ['hard_hit_percent', 'hardhit_percent', 'hard_hit_pct']),
        pickNum(row, ['k_percent', 'k_pct']),
        pickNum(row, ['bb_percent', 'bb_pct']),
        pickNum(row, ['exit_velocity_avg', 'avg_hit_speed', 'avg_exit_velo']),
        pickNum(row, ['sprint_speed']),
      ]
    );
    written++;
  }
  return { written, rowCount: rows.length };
}

// Best-effort wrapper for the pipeline: pulls both leaderboards, never
// throws (logs and returns zeros on failure), never runs more than the
// caller schedules it (twice a day per the spec -- enforced by the
// scheduler calling this, not by this function).
export async function runSavantSnapshotPull(pool, season, pullDate) {
  const result = { pitchers: { written: 0, rowCount: 0 }, batters: { written: 0, rowCount: 0 } };
  try {
    result.pitchers = await pullAndStoreSavantPitchers(pool, season, pullDate);
  } catch (err) {
    console.warn(`  Savant pitcher snapshot pull failed: ${err.message}`);
  }
  try {
    result.batters = await pullAndStoreSavantBatters(pool, season, pullDate);
  } catch (err) {
    console.warn(`  Savant batter snapshot pull failed: ${err.message}`);
  }
  return result;
}

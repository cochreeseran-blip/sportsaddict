// Baseball Savant's probable-pitchers page (baseballsavant.mlb.com) is a
// browse-only page: no documented public API, no stable published JSON
// contract. Everything below is best-effort scraping of whatever the page
// happens to embed on a given day, wrapped so a change to Savant's page
// (or Savant being unreachable) degrades to "no bonus data today", never
// a pipeline failure. The season/trailing ERA the rest of the app already
// computes from MLB Stats API game logs never depends on this file
// returning anything.
const BASE = process.env.SAVANT_BASE || 'https://baseballsavant.mlb.com';

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SlatefinderResearch/1.0; +https://slatefinder.lol)' },
    });
    if (!res.ok) throw new Error(`Baseball Savant ${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Pulls every plausible top-level JSON blob out of a <script> body: either
// the whole thing (a JSON-typed script tag) or the right-hand side of a
// `var x = {...};` / `window.x = [...];` style assignment. Over-broad on
// purpose, JSON.parse below throws away anything that isn't valid JSON.
function extractJsonCandidates(scriptBody) {
  const candidates = [];
  const trimmed = scriptBody.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  const assignRe = /=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/;
  const m = scriptBody.match(assignRe);
  if (m) candidates.push(m[1]);
  return candidates;
}

const IDENTITY_KEYS = new Set(['pitcher', 'pitcher_name', 'player_name', 'name', 'pitcher_id', 'mlbam_id', 'player_id', 'id']);

// Walks a parsed JSON tree looking for objects that look like a single
// pitcher's stat line: something with an ERA-shaped field and a
// name/id-shaped field sitting next to it. Depth/node caps keep a
// pathologically large page from being expensive to scan.
function collectPitcherRecords(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8 || out.length > 500) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPitcherRecords(item, out, seen, depth + 1);
    return;
  }
  const keys = Object.keys(node);
  const lower = keys.map((k) => k.toLowerCase());
  const hasEra = lower.some((k) => k === 'era' || k.endsWith('_era'));
  const hasIdentity = lower.some((k) => IDENTITY_KEYS.has(k));
  if (hasEra && hasIdentity && !seen.has(node)) {
    seen.add(node);
    out.push(node);
  }
  for (const k of keys) collectPitcherRecords(node[k], out, seen, depth + 1);
}

function firstNumeric(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

function firstString(obj, keys) {
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k].trim();
  }
  return null;
}

function normalizeRecord(r) {
  const idRaw = r.pitcher_id ?? r.mlbam_id ?? r.player_id ?? r.id ?? null;
  const id = idRaw !== null && idRaw !== undefined ? Number(idRaw) : null;
  return {
    id: Number.isFinite(id) ? id : null,
    name: firstString(r, ['pitcher_name', 'player_name', 'name', 'pitcher']),
    era: firstNumeric(r, ['era']),
    xera: firstNumeric(r, ['xera', 'x_era', 'est_era', 'estimated_era']),
    kPct: firstNumeric(r, ['k_percent', 'so_percent', 'k_pct', 'strikeout_percent']),
    bbPct: firstNumeric(r, ['bb_percent', 'walk_percent', 'bb_pct']),
    whiffPct: firstNumeric(r, ['whiff_percent', 'whiff_pct']),
    hardHitPct: firstNumeric(r, ['hard_hit_percent', 'hardhit_percent', 'hard_hit_pct']),
  };
}

export function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Returns { byId: Map<mlbamId, metrics>, byName: Map<normalizedName, metrics>, count }.
// Matching prefers id (Savant and MLB Stats API both key off the same
// MLBAM player id when Savant's page exposes it); name is the fallback
// since Savant's page may only surface names for some layouts.
export async function fetchSavantProbablePitchers(dateStr) {
  const byId = new Map();
  const byName = new Map();
  try {
    const html = await fetchText(`${BASE}/probable-pitchers?date=${dateStr}`);
    const records = [];
    const seen = new Set();
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRe.exec(html))) {
      const body = match[1];
      if (!body || body.length < 20) continue;
      for (const candidate of extractJsonCandidates(body)) {
        try {
          collectPitcherRecords(JSON.parse(candidate), records, seen);
        } catch {
          // Not valid/parseable JSON, not our data, move on.
        }
      }
    }
    for (const raw of records) {
      const n = normalizeRecord(raw);
      if (n.era === null && n.xera === null && n.kPct === null) continue; // nothing usable on this record
      if (n.id !== null) byId.set(n.id, n);
      if (n.name) byName.set(normalizeName(n.name), n);
    }
    if (!byId.size && !byName.size) {
      console.warn(`  Baseball Savant probable-pitchers returned no readable stat data for ${dateStr} (page format may not match what this scraper expects).`);
    }
  } catch (err) {
    console.warn(`  Baseball Savant probable-pitchers unavailable for ${dateStr}: ${err.message}`);
  }
  return { byId, byName, count: byId.size + Math.max(0, byName.size - byId.size) };
}

// Writes whatever Savant metrics matched today's probable starters onto
// their already-existing pitcher_form row (see migrations/015). Silent
// no-op per starter with no match, this is a bonus layer, not a required
// field.
export async function applySavantMetrics(pool, gameDate, starters, savantData) {
  let matched = 0;
  for (const s of starters) {
    if (!s.pitcherId) continue;
    let m = savantData.byId.get(Number(s.pitcherId));
    if (!m && s.pitcherName) m = savantData.byName.get(normalizeName(s.pitcherName));
    if (!m) continue;
    await pool.query(
      `UPDATE pitcher_form SET
         savant_era = $1, savant_xera = $2, savant_k_pct = $3, savant_bb_pct = $4,
         savant_whiff_pct = $5, savant_hard_hit_pct = $6, savant_updated_at = now()
       WHERE game_date = $7 AND pitcher_id = $8`,
      [m.era, m.xera, m.kPct, m.bbPct, m.whiffPct, m.hardHitPct, gameDate, s.pitcherId]
    );
    matched++;
  }
  return matched;
}

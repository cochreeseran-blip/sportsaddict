const MIN_STARTS = 4;
const MIN_FLOOR_KS = 4;
const MAX_WATCH = 10;

// The largest whole-strikeout count the pitcher has reached in at least
// hitsNeeded of his recent starts. That count minus 0.5 is the highest
// over line his own recent form says he clears reliably - the "floor".
// Example: last 5 starts of 7, 5, 8, 6, 9 Ks reach 5+ in all 5 starts,
// so the floor is 5 and the suggested line is over 4.5.
function consistentFloor(ks, hitsNeeded) {
  const sorted = [...ks].sort((a, b) => b - a);
  if (sorted.length < hitsNeeded) return null;
  return sorted[hitsNeeded - 1];
}

// Today's probable starters whose recent strikeout counts have a high,
// consistent floor - the research base for K prop overs. This is form
// only: it does not know the opposing lineup's strikeout rate or the
// actual book line, so it says "his last 5 starts support over N.5", not
// "bet it".
export async function runStrikeoutFilter(pool, gameDate) {
  const { rows: games } = await pool.query(
    'SELECT mlb_game_id, home_team, away_team, home_starter_id, home_starter_name, away_starter_id, away_starter_name FROM games WHERE game_date = $1',
    [gameDate]
  );

  const starters = [];
  for (const g of games) {
    if (g.home_starter_id) {
      starters.push({ pitcherId: g.home_starter_id, pitcherName: g.home_starter_name, team: g.home_team, opponent: g.away_team, mlbGameId: g.mlb_game_id });
    }
    if (g.away_starter_id) {
      starters.push({ pitcherId: g.away_starter_id, pitcherName: g.away_starter_name, team: g.away_team, opponent: g.home_team, mlbGameId: g.mlb_game_id });
    }
  }
  if (!starters.length) return { watchList: [] };

  const { rows: forms } = await pool.query(
    'SELECT pitcher_id, pitcher_name, last5_start_ks, trailing_k_per_start, trailing_era FROM pitcher_form WHERE game_date = $1 AND pitcher_id = ANY($2)',
    [gameDate, starters.map((s) => s.pitcherId)]
  );
  const formById = new Map(forms.map((f) => [f.pitcher_id, f]));

  const watchList = [];
  for (const s of starters) {
    const form = formById.get(s.pitcherId);
    const ks = Array.isArray(form?.last5_start_ks) ? form.last5_start_ks.map(Number) : [];
    if (ks.length < MIN_STARTS) continue;

    // Floor across all recent starts, and the softer floor that allows
    // one dud. The strict floor is the headline; the softer one shows how
    // much room there is above it.
    const strictFloor = consistentFloor(ks, ks.length);
    const softFloor = consistentFloor(ks, Math.max(1, ks.length - 1));
    if (strictFloor === null || strictFloor < MIN_FLOOR_KS) continue;

    const suggestedLine = strictFloor - 0.5;
    watchList.push({
      mlbGameId: s.mlbGameId,
      pitcherId: s.pitcherId,
      pitcherName: form.pitcher_name ?? s.pitcherName,
      team: s.team,
      opponent: s.opponent,
      last5StartKs: ks,
      kPerStart: form.trailing_k_per_start !== null ? Number(form.trailing_k_per_start) : null,
      strictFloorKs: strictFloor,
      softFloorKs: softFloor,
      suggestedLine,
      clearedRate: ks.filter((k) => k >= strictFloor).length / ks.length,
    });
  }

  watchList.sort((a, b) => b.strictFloorKs - a.strictFloorKs || (b.kPerStart ?? 0) - (a.kPerStart ?? 0));
  return { watchList: watchList.slice(0, MAX_WATCH) };
}

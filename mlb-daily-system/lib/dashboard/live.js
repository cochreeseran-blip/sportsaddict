import * as mlb from '../sources/mlbStats.js';

// One live snapshot for a single game: score, inning, and pitcher-change
// detection for both sides against the starters recorded in `games` at
// generation time. When a side's current pitcher differs from its
// recorded starter, this fetches the DEPARTED starter's final in-game
// line (so a K-prop being tracked shows exactly how many Ks he left with,
// dead or alive) and the new pitcher's live line.
export async function liveGameSnapshot(pool, game, gameDate) {
  const { mlb_game_id: gamePk, home_starter_id: homeStarterId, away_starter_id: awayStarterId } = game;
  let linescore;
  try {
    linescore = await mlb.fetchLinescore(gamePk);
  } catch (err) {
    return { mlbGameId: gamePk, error: err.message };
  }

  // K-prop lines for THIS game's starters, from today's already-computed
  // strikeout signal (not re-run here -- the dashboard's main payload
  // already has it; this just needs the suggested line to know hit/dead).
  const kPropLineByPitcherId = new Map();
  if (gameDate) {
    try {
      const { rows } = await pool.query(
        `SELECT details FROM daily_digest WHERE game_date = $1 AND signal_type = 'strikeouts'`,
        [gameDate]
      );
      for (const w of rows[0]?.details?.watchList || []) {
        if (w.mlbGameId === gamePk && w.pitcherId) kPropLineByPitcherId.set(w.pitcherId, w.suggestedLine);
      }
    } catch { /* best-effort */ }
  }

  // fetchLinescore only reports the currently-active DEFENSIVE pitcher
  // (whichever side is pitching right now), not both sides' current
  // pitchers independently. Treat it as "the side currently on defense".
  const currentPitcherId = linescore.pitcherId;

  const snapshot = {
    mlbGameId: gamePk,
    homeScore: linescore.homeRuns,
    awayScore: linescore.awayRuns,
    inning: linescore.currentInning,
    inningState: linescore.inningState,
    outs: linescore.outs,
    currentDefensivePitcherId: currentPitcherId,
    currentDefensivePitcherName: linescore.pitcherName,
  };

  // Pitcher-change alert: only meaningful for whichever starter is
  // relevant right now (the side currently pitching). If the live
  // defensive pitcher id doesn't match EITHER recorded starter id, a
  // change has happened for that side.
  const recordedIds = [homeStarterId, awayStarterId].filter(Boolean);
  if (currentPitcherId && recordedIds.length && !recordedIds.includes(currentPitcherId)) {
    snapshot.pitcherChanged = true;
    snapshot.newPitcherId = currentPitcherId;
    snapshot.newPitcherName = linescore.pitcherName;
    // Whichever recorded starter this replaced -- best effort, both sides
    // checked since we don't know here which side is on defense.
    for (const [side, starterId] of [['home', homeStarterId], ['away', awayStarterId]]) {
      if (!starterId) continue;
      try {
        const line = await mlb.fetchLivePitcherLine(gamePk, side, starterId);
        if (line) {
          const suggestedLine = kPropLineByPitcherId.get(starterId);
          const kPropStatus = suggestedLine !== undefined && line.strikeouts !== null
            ? (line.strikeouts > suggestedLine ? 'hit' : 'dead')
            : null;
          snapshot.departedStarter = snapshot.departedStarter || {};
          snapshot.departedStarter[side] = { pitcherId: starterId, ...line, suggestedLine: suggestedLine ?? null, kPropStatus };
        }
      } catch { /* best-effort */ }
    }
  } else {
    snapshot.pitcherChanged = false;
  }

  return snapshot;
}

export async function liveMonitorSnapshot(pool, gameDate) {
  const { rows: games } = await pool.query(
    `SELECT mlb_game_id, home_team, away_team, home_starter_id, away_starter_id
       FROM games WHERE game_date = $1 AND mlb_game_id IS NOT NULL`,
    [gameDate]
  );
  const results = await Promise.all(games.map((g) => liveGameSnapshot(pool, g, gameDate).catch(() => null)));
  return games.map((g, i) => ({
    mlbGameId: g.mlb_game_id,
    homeTeam: g.home_team,
    awayTeam: g.away_team,
    ...(results[i] || {}),
  }));
}

import { fmtOdds, fmtNum } from './util/format.js';

const ERA_STRUGGLE_GATE = 6.0;
const UNCONFIRMED_LINEUP_PENALTY = 2.5;

function lineupWarning(lineupConfirmed) {
  return lineupConfirmed === false
    ? " Today's lineup isn't posted yet, this is a projected regular, not a confirmed starter."
    : '';
}

// Every signal type here already gates on "the opposing/away pitcher is
// struggling" (trailing ERA >= 6.00), that's the one thing moneyline,
// hit-streak, and wind/HR picks all have in common, so it anchors the
// score across categories. Each type adds its own bonus on top for how
// strong that category's specific signal is (how bad the ERA really is,
// how hot the hitter is, how much wind/power is in play). This is a
// simple, explainable heuristic, not a statistical model, good enough to
// rank "which of these is the strongest single pick today," not to size a
// real edge.
function moneylineCandidates(moneyline) {
  return (moneyline?.picks || []).map((p) => {
    // Score = how big the home starter's ERA advantage is, scaled to sit
    // on the same rough range as the batter signals' scores.
    const edge = p.eraEdge ?? 0;
    return {
      type: 'moneyline',
      key: `ml:${p.homeTeam}:${p.awayTeam}`,
      score: 6 + edge * 1.5,
      mlbGameId: p.mlbGameId ?? null,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      headline: `${p.homeTeam} (${fmtOdds(p.homeMl)}) to beat ${p.awayTeam}`,
      detail: `${p.homeStarterName ?? 'The home starter'} (${fmtNum(p.homeStarterTrailingEra ?? p.homeStarterSeasonEra)} ERA) holds the pitching edge over ${p.awayStarterName ?? 'the visitor'} (${fmtNum(p.awayStarterTrailingEra ?? p.awayStarterSeasonEra)}), ${p.eraBasis ?? 'recent form'}.`,
    };
  });
}

function hitStreakCandidates(hitStreak) {
  return (hitStreak?.highConfidence || []).map((b) => {
    const era = b.opposingStarterTrailingEra ?? ERA_STRUGGLE_GATE;
    const hotBonus = (b.hitStreak ?? 0) * 0.3 + Math.max(0, (b.trailing15Avg ?? 0) - 0.3) * 20;
    const penalty = b.lineupConfirmed === false ? UNCONFIRMED_LINEUP_PENALTY : 0;
    return {
      type: 'hit_streak',
      key: `batter:${b.batterName}:${b.team}`,
      score: era + hotBonus - penalty,
      mlbGameId: b.mlbGameId ?? null,
      batterId: b.batterId ?? null,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jerseyNumber ?? null,
      lineupConfirmed: b.lineupConfirmed,
      last5Results: b.last5Results,
      headline: `${b.batterName} (${b.team}) to get a hit`,
      detail: `${b.hitStreak >= 5 ? `On a ${b.hitStreak}-game hit streak` : `Batting ${fmtNum(b.trailing15Avg, 3)} over his last 15 games`}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
    };
  });
}

function windHrCandidates(windHr) {
  return (windHr?.highConfidence || []).map((b) => {
    const era = b.opposingStarterTrailingEra ?? ERA_STRUGGLE_GATE;
    const powerBonus = (b.trailing15HrRate ?? 0) * 5 + Math.max(0, (b.windSpeedMph ?? 10) - 10) * 0.1;
    const penalty = b.lineupConfirmed === false ? UNCONFIRMED_LINEUP_PENALTY : 0;
    return {
      type: 'wind_hr',
      key: `batter:${b.batterName}:${b.team}`,
      score: era + powerBonus - penalty,
      mlbGameId: b.mlbGameId ?? null,
      batterId: b.batterId ?? null,
      team: b.team,
      position: b.position ?? null,
      jerseyNumber: b.jerseyNumber ?? null,
      lineupConfirmed: b.lineupConfirmed,
      last5Results: b.last5Results,
      headline: `${b.batterName} (${b.team}) to go deep`,
      detail: `Wind blowing out ${fmtNum(b.windSpeedMph, 1)} mph at ${b.venue}, facing ${b.opposingStarterName ?? 'a struggling pitcher'} (${fmtNum(b.opposingStarterTrailingEra)} ERA).${lineupWarning(b.lineupConfirmed)}`,
    };
  });
}

// Pools moneyline picks + high-confidence hit-streak batters + high-
// confidence wind/HR batters into one ranked list. Dedupes by
// batter/game so the same player doesn't take two of the three slots.
export function buildTopPicks({ moneyline, hitStreak, windHr }, limit = 3) {
  const all = [
    ...moneylineCandidates(moneyline),
    ...hitStreakCandidates(hitStreak),
    ...windHrCandidates(windHr),
  ].sort((a, b) => b.score - a.score);

  const seen = new Set();
  const top = [];
  for (const c of all) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    top.push(c);
    if (top.length >= limit) break;
  }
  return top;
}

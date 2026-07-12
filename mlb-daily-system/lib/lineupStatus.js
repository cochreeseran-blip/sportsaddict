// Lineup status helpers shared by the batter-prop filters (hit streak,
// wind/HR).
//
// The subtlety these exist for: an individual batter_form row carries
// lineup_confirmed as a plain boolean, but false means two completely
// different things —
//   (a) his team's lineup hasn't been posted yet (nobody's confirmed), or
//   (b) his team's lineup IS posted and he simply isn't in it (benched/out).
// For a prop those are opposite outcomes: (a) is "wait, still projected",
// (b) is "there is no prop, he isn't starting". You can't tell them apart
// from the batter's own row — you need to know whether the TEAM's lineup
// is posted at all, which is what postedLineupTeams answers.

export async function postedLineupTeams(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT DISTINCT team FROM batter_form WHERE game_date = $1 AND lineup_confirmed = true`,
    [gameDate]
  );
  return new Set(rows.map((r) => r.team));
}

// True when we KNOW this batter isn't starting: his team's lineup is
// posted and he isn't in it. Before the lineup posts (team not in
// postedTeams) this is false — he stays a projected candidate.
export function benchedOut(batter, postedTeams) {
  return postedTeams.has(batter.team) && !batter.lineup_confirmed;
}

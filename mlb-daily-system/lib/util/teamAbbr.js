// MLB Stats API's schedule/games endpoints return full team names
// ("Chicago White Sox"), which is what `games.home_team`/`away_team` and
// `batter_form.team` store throughout this app. The new historical tables
// (team_batting_aggregates, game logs) key off the standard 3-letter
// abbreviation instead, because that's what MLB's gameLog splits return
// for team/opponent. This is the bridge between the two, needed anywhere
// a full team name has to look up an abbreviation-keyed row.
const NAME_TO_ABBR = {
  'Arizona Diamondbacks': 'AZ',
  'Atlanta Braves': 'ATL',
  'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS',
  'Chicago Cubs': 'CHC',
  'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN',
  'Cleveland Guardians': 'CLE',
  'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET',
  'Houston Astros': 'HOU',
  'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA',
  'Los Angeles Dodgers': 'LAD',
  'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL',
  'Minnesota Twins': 'MIN',
  'New York Mets': 'NYM',
  'New York Yankees': 'NYY',
  'Oakland Athletics': 'OAK',
  'Athletics': 'ATH', // MLB Stats API dropped the city name starting the club's Sacramento seasons
  'Philadelphia Phillies': 'PHI',
  'Pittsburgh Pirates': 'PIT',
  'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF',
  'Seattle Mariners': 'SEA',
  'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB',
  'Texas Rangers': 'TEX',
  'Toronto Blue Jays': 'TOR',
  'Washington Nationals': 'WSH',
};

export function teamAbbr(fullName) {
  return NAME_TO_ABBR[fullName] || null;
}

// MLB's own numeric team ids. Needed for the Stats API's `opposingTeamId`
// parameter (batter-vs-team splits), which takes an id and will not accept
// a name or an abbreviation. Keyed by abbreviation so either direction
// works: name -> abbr -> id.
const ABBR_TO_ID = {
  AZ: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, ATH: 133, OAK: 133,
  PHI: 143, PIT: 134, SD: 135, SF: 137, SEA: 136, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120,
};

export function teamIdFromAbbr(abbr) {
  return ABBR_TO_ID[abbr] ?? null;
}

export function teamId(fullName) {
  const abbr = teamAbbr(fullName);
  return abbr ? teamIdFromAbbr(abbr) : null;
}

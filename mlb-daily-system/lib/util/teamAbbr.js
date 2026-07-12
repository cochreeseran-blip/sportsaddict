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

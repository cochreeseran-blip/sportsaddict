// Boot-time guard against legacy schema drift, run after migrations.
//
// The production database turned out to host tables from an older app
// under the same names (users had role/display_name NOT NULL, etc.).
// CREATE TABLE IF NOT EXISTS silently keeps those tables, and then any
// INSERT from this app dies on a legacy NOT NULL column it never heard
// of. For every table this app inserts into, drop NOT NULL from columns
// that (a) this app's schema doesn't define and (b) have no default —
// data stays untouched, but unknown legacy columns can never block a
// write again.
//
// Per-table allowlists = the columns THIS app's migrations define. A
// NOT NULL column in the list is ours and keeps its constraint (our
// inserts always supply it); anything outside the list is legacy.
const OWNED_COLUMNS = {
  users: ['id', 'email', 'username', 'avatar_seed', 'password_hash', 'created_at'],
  sessions: ['token', 'user_id', 'created_at', 'expires_at'],
  games: [
    'id', 'game_date', 'mlb_game_id', 'home_team', 'away_team', 'game_time_utc', 'venue',
    'home_ml', 'away_ml', 'home_starter_id', 'home_starter_name', 'away_starter_id',
    'away_starter_name', 'wind_speed_mph', 'wind_blowing_out', 'created_at',
  ],
  pitcher_form: [
    'id', 'game_date', 'pitcher_id', 'pitcher_name', 'season_era', 'trailing_starts',
    'trailing_ip', 'trailing_er', 'trailing_era', 'last5_start_ks', 'trailing_k_per_start', 'created_at',
  ],
  batter_form: [
    'id', 'game_date', 'batter_id', 'batter_name', 'team', 'hit_streak', 'trailing_15_avg',
    'trailing_15_hr_rate', 'lineup_confirmed', 'last5_results', 'position', 'jersey_number',
    'lineup_confirmed_at', 'created_at',
  ],
  daily_digest: ['id', 'game_date', 'signal_type', 'details', 'created_at'],
  tracked_picks: [
    'id', 'game_date', 'signal_type', 'mlb_game_id', 'description', 'locked_price',
    'breakeven_pct', 'closing_price', 'clv_pct', 'qualifying_metrics', 'result', 'created_at',
  ],
  bets: [
    'id', 'game_date', 'description', 'odds', 'stake', 'book', 'bet_kind', 'mlb_game_id',
    'batter_id', 'result', 'profit', 'settled_at', 'created_at',
  ],
  subscribers: ['id', 'email', 'unsubscribe_token', 'created_at', 'unsubscribed_at'],
  manual_picks: ['id', 'game_date', 'home_team', 'away_team', 'home_ml', 'reason', 'mlb_game_id', 'created_at'],
  park_orientations: ['venue', 'latitude', 'longitude', 'out_bearing_degrees', 'confidence', 'source'],
};

export async function ensureInsertSafety(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND is_nullable = 'NO' AND column_default IS NULL
       AND table_name = ANY($1)`,
    [Object.keys(OWNED_COLUMNS)]
  );

  for (const { table_name, column_name } of rows) {
    if (OWNED_COLUMNS[table_name].includes(column_name)) continue;
    try {
      // Identifiers can't be parameterized; both values come from
      // information_schema (not user input) and are quoted defensively.
      await pool.query(`ALTER TABLE "${table_name}" ALTER COLUMN "${column_name}" DROP NOT NULL`);
      console.log(`Schema guard: relaxed legacy NOT NULL on ${table_name}.${column_name}`);
    } catch (err) {
      console.warn(`Schema guard: could not relax ${table_name}.${column_name}: ${err.message}`);
    }
  }
}

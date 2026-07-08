-- mlb-daily-system schema
-- Safe to re-run: tables use IF NOT EXISTS, park seed uses ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS games (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  mlb_game_id TEXT UNIQUE,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_time_utc TIMESTAMPTZ,
  venue TEXT,
  home_ml INTEGER,
  away_ml INTEGER,
  home_starter_id INTEGER,
  home_starter_name TEXT,
  away_starter_id INTEGER,
  away_starter_name TEXT,
  wind_speed_mph NUMERIC,
  wind_blowing_out BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pitcher_form (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  pitcher_id INTEGER NOT NULL,
  pitcher_name TEXT,
  season_era NUMERIC,
  trailing_starts INTEGER,
  trailing_ip NUMERIC,
  trailing_er INTEGER,
  trailing_era NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(game_date, pitcher_id)
);

CREATE TABLE IF NOT EXISTS batter_form (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  batter_id INTEGER NOT NULL,
  batter_name TEXT,
  team TEXT,
  hit_streak INTEGER,
  trailing_15_avg NUMERIC,
  trailing_15_hr_rate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(game_date, batter_id)
);

CREATE TABLE IF NOT EXISTS park_orientations (
  venue TEXT PRIMARY KEY,
  latitude NUMERIC,
  longitude NUMERIC,
  out_bearing_degrees NUMERIC
);

CREATE TABLE IF NOT EXISTS daily_digest (
  id SERIAL PRIMARY KEY,
  game_date DATE NOT NULL,
  signal_type TEXT NOT NULL, -- 'moneyline' | 'hit_streak' | 'wind_hr'
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Park seed data: latitude/longitude of each stadium and the compass bearing
-- (0=N, 90=E, 180=S, 270=W) from home plate through center field.
--
-- NOTE (Claude Code build-time judgment call): this environment has no
-- outbound network access to verify these against a live source, so these
-- coordinates/bearings are transcribed from general knowledge of public
-- ballpark-orientation references (e.g. Andrew Clem's ballpark database)
-- rather than fetched live. They're good enough to gate the wind/HR filter
-- but should be spot-checked against an authoritative source before relying
-- on them for real decisions. A few venues are volatile as of 2025/2026 and
-- may need updating: the Athletics are playing at Sutter Health Park
-- (West Sacramento) through at least 2027 pending their Las Vegas ballpark;
-- the Rays have been playing at George M. Steinbrenner Field (Tampa) while
-- Tropicana Field is repaired and may move back; the Astros' park was
-- renamed Daikin Park (from Minute Maid Park) in 2025; the White Sox park
-- was renamed Rate Field (from Guaranteed Rate Field) in 2024. Matching in
-- code is case-insensitive/trimmed, and unmatched venues are skipped with a
-- logged warning rather than crashing the job.
INSERT INTO park_orientations (venue, latitude, longitude, out_bearing_degrees) VALUES
  ('Angel Stadium', 33.8003, -117.8827, 20),
  ('Chase Field', 33.4455, -112.0667, 5),
  ('Truist Park', 33.8908, -84.4678, 90),
  ('Oriole Park at Camden Yards', 39.2839, -76.6217, 30),
  ('Fenway Park', 42.3467, -71.0972, 45),
  ('Wrigley Field', 41.9484, -87.6553, 30),
  ('Rate Field', 41.8299, -87.6338, 40),
  ('Great American Ball Park', 39.0979, -84.5063, 10),
  ('Progressive Field', 41.4962, -81.6852, 5),
  ('Coors Field', 39.7559, -104.9942, 25),
  ('Comerica Park', 42.3390, -83.0485, 40),
  ('Daikin Park', 29.7573, -95.3555, 50),
  ('Kauffman Stadium', 39.0517, -94.4803, 75),
  ('Dodger Stadium', 34.0739, -118.2400, 20),
  ('loanDepot park', 25.7781, -80.2197, 35),
  ('American Family Field', 43.0280, -87.9712, 40),
  ('Target Field', 44.9817, -93.2777, 85),
  ('Citi Field', 40.7571, -73.8458, 30),
  ('Yankee Stadium', 40.8296, -73.9262, 75),
  ('Sutter Health Park', 38.5802, -121.5133, 30),
  ('Citizens Bank Park', 39.9061, -75.1665, 5),
  ('PNC Park', 40.4469, -80.0057, 65),
  ('Petco Park', 32.7073, -117.1566, 20),
  ('Oracle Park', 37.7786, -122.3893, 95),
  ('T-Mobile Park', 47.5914, -122.3325, 45),
  ('Busch Stadium', 38.6226, -90.1928, 90),
  ('George M. Steinbrenner Field', 27.9803, -82.5065, 30),
  ('Globe Life Field', 32.7473, -97.0819, 35),
  ('Rogers Centre', 43.6414, -79.3894, 0),
  ('Nationals Park', 38.8730, -77.0074, 30)
ON CONFLICT (venue) DO NOTHING;

-- Section 1 of the "verify, don't guess" pass on park_orientations.
--
-- The original seed (001_init.sql) was transcribed from general knowledge
-- with no verification and is the highest-risk data in the system — a
-- wrong bearing silently flips the wind/HR filter's "blowing out" call.
-- This migration replaces it with what could actually be verified in this
-- build environment, and is explicit about what could not be.
--
-- What was checked (see the research trail in the session that authored
-- this migration for the exact commands run):
--   - github.com/cageyjames/GeoJSON-Ballparks (git-cloned directly; a
--     current, actively-maintained dataset, "New stadiums date from
--     May 21, 2025" per its README) provides one lat/long point per MLB
--     stadium. That single point is reliable for latitude/longitude, and
--     every value below has been updated from it (the legacy dataset in
--     the same repo supplied Tropicana Field's coordinates, since the
--     current file lists the Rays at George M. Steinbrenner Field).
--   - gist.github.com/the55/2155142 provides a second, older (~2011-2012)
--     single-point dataset. Also single-point, and stale for franchises
--     that have relocated since (Braves/Turner Field, etc.) — not used
--     for coordinates, but corroborates GeoJSON-Ballparks' numbers are in
--     the right place for parks that haven't moved.
--
-- What could NOT be verified, for every single park:
--   - Neither source above provides a SECOND reference point per park
--     (e.g. a center-field marker or second base) — only one point per
--     stadium. The bearing formula specified for this task requires two
--     points; one point cannot produce a bearing.
--   - The two named cross-check sources (baseball-almanac.com's NSEW
--     pages, and the Hardball Times physics-of-orientation article) were
--     both unreachable from this build environment (network policy blocks
--     general web access; only GitHub raw/git, npm, pypi, and a handful
--     of other hosts are allowlisted). No diagram cross-check was
--     possible for any of the 30 parks.
--
-- Net result: out_bearing_degrees is set to NULL and confidence to
-- 'unverified' for every row. Per the explicit instruction this migration
-- was written to follow, a plausible-looking wrong bearing is worse than
-- an honest blank, so no bearing was carried over or guessed. The wind/HR
-- filter and the pipeline's weather step were both updated (see
-- lib/filters/windHr.js and lib/pipeline.js) to skip any park with a NULL
-- bearing rather than silently computing "blowing out" from nothing.
--
-- To move a park from 'unverified' to 'computed': find real home-plate +
-- center-field (or second-base) coordinates for it and run the bearing
-- formula. To move it to 'diagram_crosscheck': visually confirm an
-- orientation against one of the two named diagram sources from an
-- environment that can actually reach them, and set out_bearing_degrees
-- + source by hand.

ALTER TABLE park_orientations ADD COLUMN IF NOT EXISTS confidence TEXT;
ALTER TABLE park_orientations ADD COLUMN IF NOT EXISTS source TEXT;

-- Clear every bearing that was previously a guess. Coordinates are
-- updated to the verified single-point source in the same statement.
UPDATE park_orientations SET
  out_bearing_degrees = NULL,
  confidence = 'unverified',
  source = 'lat/long: GeoJSON-Ballparks (github.com/cageyjames/GeoJSON-Ballparks), May 2025 snapshot, single point per park. Bearing: UNVERIFIED — no second reference point available in any reachable source, and diagram cross-check sources (baseball-almanac.com, tht.fangraphs.com) are unreachable from this build environment.'
WHERE venue != 'UNIQLO Field at Dodger Stadium';

UPDATE park_orientations SET latitude = 33.800278, longitude = -117.883056 WHERE venue = 'Angel Stadium';
UPDATE park_orientations SET latitude = 33.454444, longitude = -112.080278 WHERE venue = 'Chase Field';
UPDATE park_orientations SET latitude = 33.953889, longitude = -84.454722  WHERE venue = 'Truist Park';
UPDATE park_orientations SET latitude = 39.283889, longitude = -76.621667 WHERE venue = 'Oriole Park at Camden Yards';
UPDATE park_orientations SET latitude = 42.346389, longitude = -71.097500 WHERE venue = 'Fenway Park';
UPDATE park_orientations SET latitude = 41.948333, longitude = -87.655556 WHERE venue = 'Wrigley Field';
UPDATE park_orientations SET latitude = 41.830000, longitude = -87.633889 WHERE venue = 'Rate Field';
UPDATE park_orientations SET latitude = 39.095000, longitude = -84.505833 WHERE venue = 'Great American Ball Park';
UPDATE park_orientations SET latitude = 41.495833, longitude = -81.685278 WHERE venue = 'Progressive Field';
UPDATE park_orientations SET latitude = 39.756389, longitude = -104.994444 WHERE venue = 'Coors Field';
UPDATE park_orientations SET latitude = 42.339167, longitude = -83.048611 WHERE venue = 'Comerica Park';
UPDATE park_orientations SET latitude = 29.756944, longitude = -95.355556 WHERE venue = 'Daikin Park';
UPDATE park_orientations SET latitude = 39.051389, longitude = -94.479167 WHERE venue = 'Kauffman Stadium';
UPDATE park_orientations SET latitude = 34.081111, longitude = -118.239444 WHERE venue = 'Dodger Stadium';
UPDATE park_orientations SET latitude = 25.776111, longitude = -80.221389 WHERE venue = 'loanDepot park';
UPDATE park_orientations SET latitude = 43.040833, longitude = -87.968056 WHERE venue = 'American Family Field';
UPDATE park_orientations SET latitude = 44.981667, longitude = -93.278333 WHERE venue = 'Target Field';
UPDATE park_orientations SET latitude = 40.757222, longitude = -73.833333 WHERE venue = 'Citi Field';
UPDATE park_orientations SET latitude = 40.829167, longitude = -73.926389 WHERE venue = 'Yankee Stadium';
UPDATE park_orientations SET latitude = 38.580278, longitude = -121.513889 WHERE venue = 'Sutter Health Park';
UPDATE park_orientations SET latitude = 39.905833, longitude = -75.166389 WHERE venue = 'Citizens Bank Park';
UPDATE park_orientations SET latitude = 40.447500, longitude = -80.009722 WHERE venue = 'PNC Park';
UPDATE park_orientations SET latitude = 32.707778, longitude = -117.156944 WHERE venue = 'Petco Park';
UPDATE park_orientations SET latitude = 37.795000, longitude = -122.389722 WHERE venue = 'Oracle Park';
UPDATE park_orientations SET latitude = 47.591389, longitude = -122.332500 WHERE venue = 'T-Mobile Park';
UPDATE park_orientations SET latitude = 38.625000, longitude = -90.193056 WHERE venue = 'Busch Stadium';
UPDATE park_orientations SET latitude = 27.980278, longitude = -82.506667 WHERE venue = 'George M. Steinbrenner Field';
UPDATE park_orientations SET latitude = 32.751389, longitude = -97.083056 WHERE venue = 'Globe Life Field';
UPDATE park_orientations SET latitude = 43.641389, longitude = -79.390000 WHERE venue = 'Rogers Centre';
UPDATE park_orientations SET latitude = 38.873889, longitude = -77.008889 WHERE venue = 'Nationals Park';

-- Tropicana Field: not in the current GeoJSON-Ballparks file (which lists
-- the Rays at Steinbrenner Field), but its legacy dataset in the same
-- repo has a precise point under the team's old "Devil Rays" name for the
-- same physical, unmoved stadium.
UPDATE park_orientations SET
  latitude = 27.768016, longitude = -82.653246,
  confidence = 'unverified',
  source = 'lat/long: GeoJSON-Ballparks legacy_ballpark.geojson (github.com/cageyjames/GeoJSON-Ballparks), listed under "Tampa Bay Devil Rays" but same unmoved physical stadium. Bearing: UNVERIFIED, same reason as all other parks.'
WHERE venue = 'Tropicana Field';

-- UNIQLO Field at Dodger Stadium is a 2026-season sponsorship rename of
-- Dodger Stadium (same physical park, confirmed via live MLB Stats API
-- schedule data in production) - alias its coordinates from that row.
UPDATE park_orientations SET
  latitude = 34.081111, longitude = -118.239444,
  out_bearing_degrees = NULL,
  confidence = 'unverified',
  source = 'Alias of "Dodger Stadium" (2026 sponsorship rename, same physical park, confirmed via live MLB Stats API schedule data). lat/long: GeoJSON-Ballparks. Bearing: UNVERIFIED, same reason as all other parks.'
WHERE venue = 'UNIQLO Field at Dodger Stadium';

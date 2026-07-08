import * as mlb from './sources/mlbStats.js';

// Every park orientation used to be hand-transcribed and unverifiable, so
// migration 004 blanked them all and the wind/HR filter went dormant.
// MLB's own Stats API publishes each venue's field orientation as
// location.azimuthAngle, which fixes that for good - but since the field
// is undocumented, we do not trust it blindly. Every documented survey of
// MLB park orientations (MLB Rule 1.04's east-northeast guidance, Baseball
// Almanac's NSEW charts, ballparks.com's diagrams) agrees on one physical
// constraint: no park's home-plate-through-center-field line points
// anywhere between south-southeast (150 degrees) and northwest (315
// degrees), because that would put the setting sun in the batter's eyes.
// So before storing anything we check the whole league's angles against
// that band. If the API's convention were anything other than the
// home-to-center bearing (say, flipped 180), the bulk of the league would
// land inside the forbidden arc and the sync refuses to store any of it.
const FORBIDDEN_ARC_START = 150;
const FORBIDDEN_ARC_END = 315;
const MIN_VENUES_FOR_CONVENTION_CHECK = 20;
const MIN_BAND_FRACTION = 0.9;

function normalizeAngle(a) {
  const n = ((a % 360) + 360) % 360;
  return n;
}

function inAllowedBand(angle) {
  const a = normalizeAngle(angle);
  return !(a > FORBIDDEN_ARC_START && a < FORBIDDEN_ARC_END);
}

// Fetches all MLB venues and upserts verified bearings + coordinates into
// park_orientations. Returns { updated, skipped, warning } - warning is a
// human-readable string when the sync could not run or refused to trust
// the data, null when everything is fine.
export async function syncParkBearings(pool, season) {
  let venues;
  try {
    venues = await mlb.fetchVenues(season);
  } catch (err) {
    return { updated: 0, skipped: 0, warning: `Could not fetch venue orientations from MLB - wind checks stay off until the next run. (${err.message})` };
  }

  const withAngle = venues.filter((v) => v.azimuthAngle !== null);
  if (withAngle.length < MIN_VENUES_FOR_CONVENTION_CHECK) {
    return {
      updated: 0,
      skipped: venues.length,
      warning: `MLB venue data only had orientation angles for ${withAngle.length} park(s) - too few to validate the convention, so none were stored.`,
    };
  }

  const inBand = withAngle.filter((v) => inAllowedBand(v.azimuthAngle));
  if (inBand.length / withAngle.length < MIN_BAND_FRACTION) {
    return {
      updated: 0,
      skipped: venues.length,
      warning:
        `MLB venue orientation angles failed the sanity check (${inBand.length}/${withAngle.length} inside the physically ` +
        `possible band) - the field convention may have changed, so none were stored.`,
    };
  }

  let updated = 0;
  let skipped = 0;
  for (const v of withAngle) {
    if (!inAllowedBand(v.azimuthAngle)) {
      // League passed the check but this one park is an outlier - store
      // nothing for it rather than a suspect bearing.
      skipped++;
      continue;
    }
    await pool.query(
      `INSERT INTO park_orientations (venue, latitude, longitude, out_bearing_degrees, confidence, source)
       VALUES ($1, $2, $3, $4, 'mlb_statsapi', $5)
       ON CONFLICT (venue) DO UPDATE SET
         latitude = COALESCE(EXCLUDED.latitude, park_orientations.latitude),
         longitude = COALESCE(EXCLUDED.longitude, park_orientations.longitude),
         out_bearing_degrees = EXCLUDED.out_bearing_degrees,
         confidence = EXCLUDED.confidence,
         source = EXCLUDED.source`,
      [
        v.name,
        v.latitude,
        v.longitude,
        normalizeAngle(v.azimuthAngle),
        `MLB Stats API venues?hydrate=location azimuthAngle (venue id ${v.id}), league-wide convention check passed at import.`,
      ]
    );
    updated++;
  }
  return { updated, skipped, warning: null };
}

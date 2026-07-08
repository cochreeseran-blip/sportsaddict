function angularDiff(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Open-Meteo's winddirection is the meteorological convention: the
// direction the wind is blowing FROM. A park's out_bearing_degrees is the
// direction from home plate THROUGH center field. For wind to be "blowing
// out" it has to travel toward center field, i.e. blow FROM the opposite
// side of that bearing - so we flip it 180 before comparing.
export function isWindBlowingOut(windDirectionFromDegrees, outBearingDegrees, windSpeedMph) {
  if (
    windDirectionFromDegrees === null || windDirectionFromDegrees === undefined ||
    outBearingDegrees === null || outBearingDegrees === undefined ||
    windSpeedMph === null || windSpeedMph === undefined
  ) {
    return null;
  }
  const windBlowingToward = (windDirectionFromDegrees + 180) % 360;
  const diff = angularDiff(windBlowingToward, outBearingDegrees);
  return windSpeedMph >= 10 && diff <= 60;
}

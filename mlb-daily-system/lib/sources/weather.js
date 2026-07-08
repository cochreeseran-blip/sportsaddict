async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Open-Meteo ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { windSpeedMph, windDirectionFromDegrees } for the hour closest
// to gameTimeUtc at the given coordinates, or null if no data returned.
export async function fetchWindAt(latitude, longitude, gameTimeUtc) {
  const dateStr = new Date(gameTimeUtc).toISOString().slice(0, 10);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=windspeed_10m,winddirection_10m&start_date=${dateStr}&end_date=${dateStr}` +
    `&timezone=UTC&windspeed_unit=mph`;
  const data = await fetchJson(url);
  const times = data.hourly?.time || [];
  const speeds = data.hourly?.windspeed_10m || [];
  const directions = data.hourly?.winddirection_10m || [];
  if (!times.length) return null;

  const target = new Date(gameTimeUtc).getTime();
  let bestIdx = 0;
  let bestDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });

  return {
    windSpeedMph: speeds[bestIdx] ?? null,
    windDirectionFromDegrees: directions[bestIdx] ?? null,
  };
}

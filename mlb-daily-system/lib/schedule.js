// Scheduling helpers for the engine (worker.js).
//
// The daily moneyline generation runs at 8:00 AM PACIFIC, and Pacific
// observes DST, so a fixed UTC hour would drift by an hour twice a year
// (8 AM PT is 15:00 UTC in summer, 16:00 UTC in winter). We therefore
// never hardcode a UTC hour for generation: the worker ticks at the top
// of every hour and asks "is it currently the generation hour in
// America/Los_Angeles?" via Intl, which is DST-correct by construction.

// The Pacific wall-clock hour (0-23) for a given instant.
export function pacificHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'America/Los_Angeles',
    }).format(date)
  );
}

// The Pacific calendar date (YYYY-MM-DD) for a given instant. The MLB
// "game date" the engine generates for is the Pacific date at generation
// time (8 AM PT), which is the same calendar day everywhere in the US.
export function pacificDateIso(date = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/Los_Angeles',
  }).format(date);
}

// The hour (Pacific) the daily moneyline board is generated. Overridable
// for testing / a future schedule change, defaults to 8 AM PT.
export const GENERATION_HOUR_PT = Number(process.env.GENERATION_HOUR_PT || 8);

// True at (and only at) the top of the generation hour in Pacific time.
// The worker calls this once per hourly tick; exactly one tick per day
// satisfies it.
export function isGenerationHour(date = new Date()) {
  return pacificHour(date) === GENERATION_HOUR_PT;
}

// Milliseconds until the next top-of-hour (UTC minute 0). The worker
// sleeps this long between ticks so every hour boundary is hit once.
export function msUntilNextTopOfHour(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0));
  return next.getTime() - now.getTime();
}

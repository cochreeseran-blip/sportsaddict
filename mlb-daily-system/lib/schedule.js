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

// Phase 1 research-dashboard data pulls are specified in ET. Same
// DST-correct Intl approach as pacificHour above.
export function easternHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(date)
  );
}
export function easternMinute(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: 'America/New_York' }).format(date)
  );
}

// Game logs once daily at 6am ET (yesterday's completed games are final
// and posted by then).
export const GAME_LOG_PULL_HOUR_ET = Number(process.env.GAME_LOG_PULL_HOUR_ET || 6);

// Savant snapshot: TWO pulls a day, each with a purpose, not three on a
// round-number schedule --
//   8:00 AM ET - Savant updates overnight with the previous day's data, so
//     this is the earliest a pull is both fresh AND complete; it needs to
//     land before anyone's actually looking at the dashboard to make a call.
//   1:30 PM ET - catches any corrections Savant makes to the morning data
//     during the day, and refreshes before afternoon games get underway.
// A third pull late in the day (4 PM) was cut: by then the day's picks are
// already made, so a pull at that hour has no decision it actually feeds,
// just extra load against an unmetered-but-not-infinite scrape target.
// Each entry is {hour, minute} in ET; the half-hour slot needs real
// minute-level scheduling, not just the top-of-hour tick the rest of the
// engine runs on -- see startSavantPullPoll in worker.js.
export const SAVANT_PULL_TIMES_ET = (process.env.SAVANT_PULL_TIMES_ET || '8:00,13:30')
  .split(',')
  .map((s) => {
    const [h, m] = s.split(':').map(Number);
    return { hour: h, minute: m || 0 };
  });

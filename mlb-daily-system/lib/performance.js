// Per-signal and per-grade performance off the tracked_picks ledger.
//
// This is the proof layer. The product's claim is "K props hit at X%" and
// the only thing that makes that claim worth anything is that it's
// computed from an append-only ledger the app cannot edit (see the
// tracked_picks_guard trigger in migrations/017). Every number here is a
// straight count over that ledger, no smoothing, no dropping of bad
// stretches, no "since we improved the model" cutoff.
//
// Two scopes, both always available:
//   algorithm - every pick the pipeline generated, published or not. The
//               honest measure of the system.
//   published - only picks that were published before first pitch. The
//               public record, i.e. what was actually called out loud.

// Below this many graded picks, a percentage is noise dressed as a fact.
// Raw W-L is always shown; the rate is withheld until the sample earns it.
// Same threshold the header badge and /record already use, kept in one
// place so the whole app agrees on when a rate becomes claimable.
export const MIN_GRADED_FOR_RATE = 25;

// Display names and ordering for the signals. Anything in the ledger that
// isn't listed here (legacy 'wind_hr' rows) still gets counted, just under
// its raw key, so a rename can never silently drop history.
export const SIGNAL_LABELS = {
  strikeout: 'Strikeout props',
  multi_hit: '2+ hit props',
  hit_streak: 'Hit props (1+)',
  home_run: 'Home run props',
  moneyline: 'Moneyline',
  wind_hr: 'Home run props (legacy)',
};
const SIGNAL_ORDER = ['strikeout', 'multi_hit', 'hit_streak', 'home_run', 'moneyline', 'wind_hr'];

function rate(wins, losses) {
  const graded = wins + losses;
  if (graded < MIN_GRADED_FOR_RATE) return null;
  return Math.round((wins / graded) * 1000) / 1000;
}

function emptyBucket() {
  return { wins: 0, losses: 0, pushes: 0, pending: 0 };
}

function summarize(bucket, label) {
  const graded = bucket.wins + bucket.losses;
  return {
    label,
    wins: bucket.wins,
    losses: bucket.losses,
    pushes: bucket.pushes,
    pending: bucket.pending,
    graded,
    winRate: rate(bucket.wins, bucket.losses),
    // Explicit so the UI never has to re-derive why a rate is missing.
    rateSuppressed: graded > 0 && graded < MIN_GRADED_FOR_RATE,
    needsForRate: Math.max(0, MIN_GRADED_FOR_RATE - graded),
  };
}

function tally(bucket, result) {
  if (result === 'win') bucket.wins++;
  else if (result === 'loss') bucket.losses++;
  else if (result === 'push') bucket.pushes++;
  else bucket.pending++;
}

// One pass over the ledger produces both scopes and both breakdowns.
// `sinceDays` limits the window (null = all time).
export async function buildPerformanceBreakdown(pool, { sinceDays = null } = {}) {
  const params = [];
  let where = '';
  if (Number.isInteger(sinceDays) && sinceDays > 0) {
    params.push(sinceDays);
    where = `WHERE game_date >= current_date - ($1::int || ' days')::interval`;
  }

  const { rows } = await pool.query(
    `SELECT signal_type, result, published, qualifying_metrics
       FROM tracked_picks ${where}`,
    params
  );

  const scopes = {
    algorithm: { bySignal: new Map(), byGrade: new Map(), overall: emptyBucket() },
    published: { bySignal: new Map(), byGrade: new Map(), overall: emptyBucket() },
  };

  for (const row of rows) {
    const grade = row.qualifying_metrics?.grade ?? null;
    const targets = row.published ? ['algorithm', 'published'] : ['algorithm'];

    for (const scopeName of targets) {
      const scope = scopes[scopeName];
      tally(scope.overall, row.result);

      if (!scope.bySignal.has(row.signal_type)) scope.bySignal.set(row.signal_type, emptyBucket());
      tally(scope.bySignal.get(row.signal_type), row.result);

      // Grade breakdown is per signal AND per grade: "A-grade K props hit
      // 82%" is a useful, checkable claim; "A-grade picks hit 82%" pools
      // three different markets into one meaningless number.
      if (grade) {
        const key = `${row.signal_type}|${grade}`;
        if (!scope.byGrade.has(key)) scope.byGrade.set(key, emptyBucket());
        tally(scope.byGrade.get(key), row.result);
      }
    }
  }

  const shape = (scope) => {
    const signals = [...scope.bySignal.entries()]
      .map(([signalType, bucket]) => {
        const grades = [...scope.byGrade.entries()]
          .filter(([key]) => key.startsWith(`${signalType}|`))
          .map(([key, gradeBucket]) => ({
            grade: key.split('|')[1],
            ...summarize(gradeBucket, key.split('|')[1]),
          }))
          .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade));
        return {
          signalType,
          ...summarize(bucket, SIGNAL_LABELS[signalType] || signalType),
          grades,
        };
      })
      .sort((a, b) => {
        const ai = SIGNAL_ORDER.indexOf(a.signalType);
        const bi = SIGNAL_ORDER.indexOf(b.signalType);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
    return { overall: summarize(scope.overall, 'All signals'), signals };
  };

  return {
    minGradedForRate: MIN_GRADED_FOR_RATE,
    sinceDays: sinceDays ?? null,
    algorithm: shape(scopes.algorithm),
    published: shape(scopes.published),
  };
}

const GRADE_ORDER = ['A+', 'A', 'B+', 'B', 'C+', 'C'];
function gradeRank(grade) {
  const i = GRADE_ORDER.indexOf(grade);
  return i === -1 ? 99 : i;
}

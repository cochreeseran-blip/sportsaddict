import 'dotenv/config';
import http from 'node:http';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { runPipeline, todayIsoDate } from './lib/pipeline.js';
import { buildTopPicks } from './lib/topPicks.js';
import { fmtOdds, fmtNum } from './lib/util/format.js';

// Railway injects PORT dynamically — binding to a fixed port would fail.
const PORT = process.env.PORT || 3000;

// MLB teams usually don't post the actual starting lineup until 1-3 hours
// before that specific game's first pitch, and games are staggered all
// day, so no single fixed time catches everyone. Instead we run a few
// times a day: once in the morning for schedule/odds/pitcher data (which
// IS known well ahead of time), then twice more in the afternoon/evening
// as lineups trickle in. Defaults: 9am, 4pm, 7pm ET. Override with a
// comma-separated list of UTC hours, e.g. DIGEST_REFRESH_HOURS_UTC=13,20,23.
const REFRESH_HOURS_UTC = (process.env.DIGEST_REFRESH_HOURS_UTC || '13,20,23')
  .split(',')
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isFinite(h) && h >= 0 && h <= 23);

let isRefreshing = false;
let refreshStartedAt = null;
let lastRunAt = null;
let lastRunError = null;

async function triggerPipelineRun(gameDate = todayIsoDate()) {
  if (isRefreshing) return { skipped: true };
  isRefreshing = true;
  refreshStartedAt = new Date();
  try {
    await runPipeline(gameDate);
    lastRunAt = new Date();
    lastRunError = null;
  } catch (err) {
    console.error('Pipeline run failed:', err);
    lastRunError = err.message;
  } finally {
    isRefreshing = false;
    refreshStartedAt = null;
  }
  return { skipped: false };
}

function msUntilNextRun(hourUtc) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

// Human-friendly ET label for a UTC hour, computed against today's actual
// date so it accounts for daylight saving automatically.
function etLabel(hourUtc) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(d);
}

function scheduleDailyRunAt(hourUtc) {
  const delay = msUntilNextRun(hourUtc);
  console.log(`Next scheduled pipeline run at ${hourUtc}:00 UTC (~${etLabel(hourUtc)} ET) in ${(delay / 3600000).toFixed(1)}h.`);
  setTimeout(async () => {
    await triggerPipelineRun();
    scheduleDailyRunAt(hourUtc);
  }, delay);
}

function scheduleDailyRuns() {
  for (const hourUtc of REFRESH_HOURS_UTC) {
    scheduleDailyRunAt(hourUtc);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


async function listDigestDates() {
  const { rows } = await pool.query(
    'SELECT DISTINCT game_date FROM daily_digest ORDER BY game_date DESC LIMIT 14'
  );
  return rows.map((r) => r.game_date.toISOString().slice(0, 10));
}

async function loadDigest(gameDate) {
  const { rows } = await pool.query(
    'SELECT signal_type, details FROM daily_digest WHERE game_date = $1',
    [gameDate]
  );
  const byType = Object.fromEntries(rows.map((r) => [r.signal_type, r.details]));
  return {
    moneyline: byType.moneyline || { signal: 'SIT', picks: [] },
    hitStreak: byType.hit_streak || { watchList: [], highConfidence: [] },
    windHr: byType.wind_hr || { watchList: [], highConfidence: [], hrRateThreshold: null },
  };
}

function pitcherBadge(era) {
  if (era === null || era === undefined) return '';
  return era >= 6.0
    ? `<span class="badge bad">STRUGGLING (${fmtNum(era)} ERA)</span>`
    : `<span class="badge good">PITCHING WELL (${fmtNum(era)} ERA)</span>`;
}

const TOP_PICK_LABEL = {
  moneyline: '💰 Moneyline',
  hit_streak: '🔥 Hot hitter',
  wind_hr: '💨 Home run weather',
};

function renderLast5(results) {
  if (!results || !results.length) return '<span class="muted">no data</span>';
  return `<span class="last5">${results.map((hit) => (hit ? '✅' : '❌')).join(' ')}</span>`;
}

function lineupBadge(confirmed) {
  if (confirmed === true) return '<span class="badge good">✅ Confirmed lineup</span>';
  if (confirmed === false) return '<span class="badge warn">⚠️ Projected — not confirmed</span>';
  return '';
}

function renderTopPicks(topPicks) {
  if (!topPicks.length) {
    return `<p class="empty">Not enough qualifying signals today for a top 3 — check the sections below, or try again once more games have data.</p>`;
  }
  const cards = topPicks
    .map(
      (p, i) => `
      <div class="card top-pick">
        <div class="top-pick-rank">#${i + 1}</div>
        <div class="top-pick-body">
          <div class="badge hot">${TOP_PICK_LABEL[p.type] ?? 'Pick'}</div>
          ${p.lineupConfirmed !== undefined ? `<div>${lineupBadge(p.lineupConfirmed)}</div>` : ''}
          <div class="card-title">${escapeHtml(p.headline)}</div>
          <div class="card-row muted">${escapeHtml(p.detail)}</div>
          ${p.last5Results ? `<div class="card-row">Last 5 games: ${renderLast5(p.last5Results)}</div>` : ''}
        </div>
      </div>`
    )
    .join('');
  return `<div class="cards top-picks">${cards}</div>`;
}

function renderOtherGames(otherGames) {
  if (!otherGames?.length) return '';
  const rows = otherGames
    .map(
      (g) => `
      <div class="card miss">
        <div class="card-title">${escapeHtml(g.awayTeam)} @ ${escapeHtml(g.homeTeam)} <span class="odds miss">${fmtOdds(g.homeMl)}</span></div>
        <div class="card-row muted">${escapeHtml(g.reason)}</div>
      </div>`
    )
    .join('');
  return `<p class="muted" style="margin-top:16px;">Games that came close but didn't make the cut:</p><div class="cards">${rows}</div>`;
}

function renderMoneylineSection(moneyline) {
  const picksHtml =
    moneyline.signal === 'SIT' || !moneyline.picks?.length
      ? `<p class="empty">SIT — nobody qualifies today. No games where the home team is a modest favorite AND the visiting pitcher is struggling. See below for the closest ones.</p>`
      : `<div class="cards">${moneyline.picks
          .map(
            (p) => `
            <div class="card play">
              <div class="card-title">Bet on ${escapeHtml(p.homeTeam)} <span class="odds">${fmtOdds(p.homeMl)}</span></div>
              <div class="card-sub">to beat ${escapeHtml(p.awayTeam)}</div>
              <div class="card-row">
                Why: ${escapeHtml(p.awayStarterName ?? 'their pitcher')}, ${escapeHtml(p.awayTeam)}'s starting pitcher, has been getting hit hard lately.
                ${pitcherBadge(p.awayStarterTrailingEra)}
                <span class="muted">(his ERA for the whole season is ${fmtNum(p.awayStarterSeasonEra)} — this pick only cares about his last 3 starts, not the full season)</span>
              </div>
            </div>`
          )
          .join('')}</div>`;
  return picksHtml + renderOtherGames(moneyline.otherGames);
}

function renderBatterRow(b, headline, subline) {
  return `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td>${escapeHtml(b.batterName)}<div class="muted">${escapeHtml(b.team)}</div><div>${lineupBadge(b.lineupConfirmed)}</div></td>
      <td>${headline}<div class="muted">${subline}</div></td>
      <td>${renderLast5(b.last5Results)}</td>
      <td>${escapeHtml(b.opposingStarterName ?? 'TBD')}<div>${pitcherBadge(b.opposingStarterTrailingEra)}</div></td>
      <td>${b.highConfidence ? '<span class="badge hot">🎯 GREAT MATCHUP</span>' : ''}</td>
    </tr>`;
}

function renderHitStreakSection(hitStreak) {
  if (!hitStreak.watchList?.length) {
    return `<p class="empty">No batters are hot enough to qualify today.</p>`;
  }
  const rows = hitStreak.watchList
    .map((b) =>
      renderBatterRow(
        b,
        b.hitStreak >= 5 ? `🔥 Hit in ${b.hitStreak} straight games` : `Batting ${fmtNum(b.trailing15Avg, 3)} lately`,
        `${fmtNum(b.trailing15Avg, 3)} average over his last 15 games`
      )
    )
    .join('');
  return `<p class="muted">Batters who are hitting well right now (5+ game hit streak, or batting .320+ over their last 15 games).</p>
    <table><thead><tr><th>Hot hitter</th><th>Recent form</th><th>Last 5 games</th><th>Today's opposing pitcher</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderWindHrSection(windHr) {
  if (!windHr.watchList?.length) {
    return `<p class="empty">No games today have wind strong enough (10+ mph) blowing toward the outfield, or no power hitters cleared today's bar.</p>`;
  }
  const rows = windHr.watchList
    .map((b) =>
      renderBatterRow(
        b,
        `💨 Playing at ${escapeHtml(b.venue ?? '')}`,
        `wind blowing out at ${fmtNum(b.windSpeedMph, 1)} mph — ${fmtNum(b.trailing15HrRate, 2)} HR per game lately`
      )
    )
    .join('');
  return `<p class="muted">Wind is blowing out today (helps fly balls carry over the fence) at these parks — showing power hitters (top third of everyone playing today by recent home-run rate) on both teams.</p>
    <table><thead><tr><th>Power hitter</th><th>Conditions</th><th>Last 5 games</th><th>Today's opposing pitcher</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPage({ gameDate, availableDates, digest }) {
  const dateOptions = availableDates
    .map((d) => `<option value="${d}" ${d === gameDate ? 'selected' : ''}>${d}</option>`)
    .join('');
  let statusLine;
  if (isRefreshing) {
    const elapsedSec = Math.round((Date.now() - refreshStartedAt.getTime()) / 1000);
    statusLine = `refreshing… (${elapsedSec}s so far — this fetches live data and usually takes under a minute, page will reload automatically)`;
  } else if (lastRunError) {
    statusLine = `last run failed: ${escapeHtml(lastRunError)}`;
  } else if (lastRunAt) {
    statusLine = `last updated ${lastRunAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  } else {
    statusLine = 'no pipeline run yet since this deploy started';
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MLB Daily Digest — ${escapeHtml(gameDate)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px 16px 64px; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1.05rem; margin-top: 2.5rem; border-bottom: 1px solid rgba(128,128,128,0.3); padding-bottom: 6px; }
  .sub { color: #888; margin-top: 0; }
  select { font-size: 1rem; padding: 4px 8px; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.92rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid rgba(128,128,128,0.2); }
  th { color: #888; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  tr.hc { background: rgba(255, 200, 0, 0.08); }
  .badge { display: inline-block; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; margin-top: 2px; }
  .badge.hot { background: #d97706; color: white; }
  .badge.bad { background: rgba(220, 38, 38, 0.15); color: #dc2626; }
  .badge.good { background: rgba(22, 163, 74, 0.15); color: #16a34a; }
  .badge.warn { background: rgba(217, 119, 6, 0.15); color: #d97706; }
  .last5 { letter-spacing: 2px; white-space: nowrap; }
  .empty { color: #888; font-style: italic; }
  .muted { color: #888; font-size: 0.85rem; }
  .cards { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .card { border: 1px solid rgba(128,128,128,0.3); border-radius: 8px; padding: 12px 16px; }
  .card.play { border-left: 4px solid #16a34a; }
  .card.miss { border-left: 4px solid rgba(128,128,128,0.4); padding: 8px 16px; }
  .card-title { font-weight: 600; font-size: 1.05rem; }
  .card-sub { color: #888; margin-bottom: 6px; }
  .odds { color: #16a34a; font-weight: 600; }
  .odds.miss { color: #888; font-weight: 600; }
  form { display: inline; }
  .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(128,128,128,0.4); background: transparent; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .intro { background: rgba(128,128,128,0.08); border-radius: 8px; padding: 14px 16px; margin: 16px 0; font-size: 0.92rem; }
  .glossary { font-size: 0.85rem; color: #888; }
  .glossary summary { cursor: pointer; color: inherit; font-size: 0.9rem; margin-bottom: 8px; }
  .glossary ul { margin: 8px 0 0; padding-left: 20px; }
  .glossary li { margin-bottom: 6px; }
  .top-picks .card.top-pick { display: flex; gap: 14px; align-items: flex-start; border-left: 4px solid #d97706; }
  .top-pick-rank { font-size: 1.6rem; font-weight: 700; color: #d97706; min-width: 34px; }
  .top-pick-body .badge { margin-bottom: 4px; }
</style>
</head>
<body>
  <h1>MLB Daily Digest</h1>
  <p class="sub toolbar">
    ${escapeHtml(gameDate)}
    <form method="get">
      <select name="date" onchange="this.form.submit()">${dateOptions}</select>
    </form>
    <form method="post" action="/refresh">
      <button type="submit" ${isRefreshing ? 'disabled' : ''} title="Re-fetches everything, including which batters are actually in tonight's confirmed lineup">${isRefreshing ? 'Refreshing…' : 'Refresh now'}</button>
    </form>
    <span class="muted">${statusLine}</span>
  </p>
  <p class="muted" style="margin-top:-6px;">Automatic checks run daily around ${REFRESH_HOURS_UTC.map(etLabel).join(', ')} ET. Lineups usually aren't posted until 1-3 hours before a given game, so for the most accurate ✅/⚠️ status, hit "Refresh now" yourself shortly before first pitch.</p>

  <h2 style="margin-top:1rem;">🏆 Top 3 Picks Today</h2>
  ${renderTopPicks(buildTopPicks(digest))}
  <p class="muted" style="margin-top:8px;">The strongest pick from each category, pooled and ranked together — not a recommendation to parlay them, just today's best individual looks.</p>

  <p class="intro">This page looks for three simple situations in today's MLB games: a home team favored against a struggling opposing pitcher, hitters who are on a hot streak, and parks where the wind is helping the ball fly out for home runs. Nothing here is a guarantee — it's just numbers worth a second look.</p>

  <details class="glossary">
    <summary>What do these terms mean?</summary>
    <ul>
      <li><strong>ERA (Earned Run Average)</strong> — average runs a pitcher gives up per 9 innings. Lower is better. Under ~4.00 is good, 6.00+ means he's been getting hit hard ("struggling").</li>
      <li><strong>Trailing ERA</strong> — a pitcher's ERA over just his last 3 starts, not the whole season. This page cares about recent form, not the season total.</li>
      <li><strong>Hit streak</strong> — number of games in a row where a batter has gotten at least 1 hit.</li>
      <li><strong>HR rate</strong> — home runs per game over a batter's last 15 games played.</li>
      <li><strong>Wind blowing out</strong> — the wind is blowing from the infield toward the outfield fence, which helps fly balls carry for home runs.</li>
      <li><strong>Last 5 games</strong> — whether the batter got a hit (✅) or not (❌) in each of his last 5 games played, oldest game on the left, most recent on the right.</li>
      <li><strong>✅ Confirmed lineup / ⚠️ Projected</strong> — MLB usually doesn't post the actual starting lineup until a couple hours before first pitch. Until then, batters shown are the team's regular starters based on their active roster, not a guarantee they're playing tonight. Always double check an ⚠️ batter is actually starting before betting on him.</li>
      <li><strong>🎯 Great matchup</strong> — a hot hitter facing a pitcher who is also struggling. Both signs point the same way.</li>
    </ul>
  </details>

  <h2>Moneyline: who to bet on</h2>
  ${renderMoneylineSection(digest.moneyline)}

  <h2>Hot Hitters to Watch</h2>
  ${renderHitStreakSection(digest.hitStreak)}

  <h2>Home Run Weather</h2>
  ${renderWindHrSection(digest.windHr)}

  <p class="muted" style="margin-top:3rem;">Research signals only — not betting advice. Verify starters/lineups before game time.</p>
  ${isRefreshing ? `<script>
    (function poll() {
      fetch('/status.json').then((r) => r.json()).then((s) => {
        if (!s.isRefreshing) { location.reload(); } else { setTimeout(poll, 3000); }
      }).catch(() => setTimeout(poll, 5000));
    })();
  </script>` : ''}
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      triggerPipelineRun(); // fire-and-forget; page shows "Refreshing…" until it's done
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    if (url.pathname === '/status.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        isRefreshing,
        refreshStartedAt,
        lastRunAt,
        lastRunError,
      }));
      return;
    }

    const availableDates = await listDigestDates();
    const requestedDate = url.searchParams.get('date');
    const gameDate = requestedDate || availableDates[0] || new Date().toISOString().slice(0, 10);

    if (!availableDates.length) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage({ gameDate, availableDates: [gameDate], digest: await loadDigest(gameDate) }));
      return;
    }

    const digest = await loadDigest(gameDate);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage({ gameDate, availableDates, digest }));
  } catch (err) {
    console.error('Request failed:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Internal error: ${err.message}`);
  }
});

async function start() {
  await runMigrations(pool);

  // Bind the port immediately so Railway's healthcheck passes right away —
  // don't make first boot wait on a full pipeline run (batter form alone
  // can take ~a minute against ~400 hitters).
  server.listen(PORT, () => {
    console.log(`MLB digest dashboard listening on :${PORT}`);
  });

  triggerPipelineRun(); // fire-and-forget initial populate
  scheduleDailyRuns();
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

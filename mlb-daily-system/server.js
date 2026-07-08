import 'dotenv/config';
import http from 'node:http';
import { pool } from './lib/db.js';
import { runMigrations } from './lib/migrate.js';
import { runPipeline, todayIsoDate } from './lib/pipeline.js';

// Railway injects PORT dynamically — binding to a fixed port would fail.
const PORT = process.env.PORT || 3000;
const REFRESH_HOUR_UTC = Number(process.env.DIGEST_REFRESH_HOUR_UTC ?? 13); // ~9am ET

let isRefreshing = false;
let lastRunAt = null;
let lastRunError = null;

async function triggerPipelineRun(gameDate = todayIsoDate()) {
  if (isRefreshing) return { skipped: true };
  isRefreshing = true;
  try {
    await runPipeline(gameDate);
    lastRunAt = new Date();
    lastRunError = null;
  } catch (err) {
    console.error('Pipeline run failed:', err);
    lastRunError = err.message;
  } finally {
    isRefreshing = false;
  }
  return { skipped: false };
}

function msUntilNextRun(hourUtc) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function scheduleDailyRun() {
  const delay = msUntilNextRun(REFRESH_HOUR_UTC);
  console.log(`Next scheduled pipeline run in ${(delay / 3600000).toFixed(1)}h (target ${REFRESH_HOUR_UTC}:00 UTC).`);
  setTimeout(async () => {
    await triggerPipelineRun();
    scheduleDailyRun();
  }, delay);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtOdds(ml) {
  if (ml === null || ml === undefined) return 'n/a';
  return ml > 0 ? `+${ml}` : `${ml}`;
}

function fmtNum(n, digits = 2) {
  return n === null || n === undefined ? 'n/a' : Number(n).toFixed(digits);
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
  return `<p class="muted" style="margin-top:16px;">Came close but didn't qualify:</p><div class="cards">${rows}</div>`;
}

function renderMoneylineSection(moneyline) {
  const picksHtml =
    moneyline.signal === 'SIT' || !moneyline.picks?.length
      ? `<p class="empty">SIT — no qualifying games today.</p>`
      : `<div class="cards">${moneyline.picks
          .map(
            (p) => `
            <div class="card play">
              <div class="card-title">${escapeHtml(p.homeTeam)} <span class="odds">${fmtOdds(p.homeMl)}</span></div>
              <div class="card-sub">over ${escapeHtml(p.awayTeam)}</div>
              <div class="card-row">${escapeHtml(p.awayStarterName ?? 'TBD')} — trailing ERA
                <strong>${fmtNum(p.awayStarterTrailingEra)}</strong>
                <span class="muted">(season ${fmtNum(p.awayStarterSeasonEra)})</span>
              </div>
            </div>`
          )
          .join('')}</div>`;
  return picksHtml + renderOtherGames(moneyline.otherGames);
}

function renderBatterRow(b, extra) {
  return `
    <tr class="${b.highConfidence ? 'hc' : ''}">
      <td>${b.highConfidence ? '<span class="badge">HIGH CONF</span> ' : ''}${escapeHtml(b.batterName)}</td>
      <td>${escapeHtml(b.team)}</td>
      <td>${extra}</td>
      <td>${escapeHtml(b.opposingStarterName ?? 'TBD')}</td>
      <td>${fmtNum(b.opposingStarterTrailingEra)}</td>
    </tr>`;
}

function renderHitStreakSection(hitStreak) {
  if (!hitStreak.watchList?.length) {
    return `<p class="empty">No qualifying batters today.</p>`;
  }
  const rows = hitStreak.watchList
    .map((b) => renderBatterRow(b, `streak ${b.hitStreak}, avg ${fmtNum(b.trailing15Avg, 3)}`))
    .join('');
  return `<table><thead><tr><th>Batter</th><th>Team</th><th>Form</th><th>Opposing SP</th><th>SP ERA (L3)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderWindHrSection(windHr) {
  if (!windHr.watchList?.length) {
    return `<p class="empty">No qualifying batters today.</p>`;
  }
  const threshold = windHr.hrRateThreshold !== null ? `<p class="muted">Top-third HR/game threshold today: ${fmtNum(windHr.hrRateThreshold, 3)}</p>` : '';
  const rows = windHr.watchList
    .map((b) => renderBatterRow(b, `HR/g ${fmtNum(b.trailing15HrRate, 3)} @ ${escapeHtml(b.venue ?? '')} (${fmtNum(b.windSpeedMph, 1)} mph out)`))
    .join('');
  return `${threshold}<table><thead><tr><th>Batter</th><th>Team</th><th>Form</th><th>Opposing SP</th><th>SP ERA (L3)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderPage({ gameDate, availableDates, digest }) {
  const dateOptions = availableDates
    .map((d) => `<option value="${d}" ${d === gameDate ? 'selected' : ''}>${d}</option>`)
    .join('');
  const statusLine = lastRunError
    ? `last run failed: ${escapeHtml(lastRunError)}`
    : lastRunAt
      ? `last updated ${lastRunAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`
      : 'no pipeline run yet since this deploy started';

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
  .badge { background: #d97706; color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
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
      <button type="submit" ${isRefreshing ? 'disabled' : ''}>${isRefreshing ? 'Refreshing…' : 'Refresh now'}</button>
    </form>
    <span class="muted">${statusLine}</span>
  </p>

  <h2>Moneyline</h2>
  ${renderMoneylineSection(digest.moneyline)}

  <h2>Hit Streak / Contact Watch</h2>
  ${renderHitStreakSection(digest.hitStreak)}

  <h2>Wind / HR Watch</h2>
  ${renderWindHrSection(digest.windHr)}

  <p class="muted" style="margin-top:3rem;">Research signals only — not betting advice. Verify starters/lineups before game time.</p>
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
  scheduleDailyRun();
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

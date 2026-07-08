const PREFERRED_BOOKS = ['draftkings', 'fanduel'];

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`The Odds API ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTeam(name) {
  return (name || '').trim().toLowerCase();
}

// Picks one canonical book per game rather than averaging across books, per
// spec. Prefers DraftKings, then FanDuel, then whatever h2h market is first.
function pickCanonicalMarket(bookmakers) {
  for (const preferred of PREFERRED_BOOKS) {
    const book = bookmakers.find((b) => b.key === preferred);
    const market = book?.markets?.find((m) => m.key === 'h2h');
    if (market) return market;
  }
  for (const book of bookmakers || []) {
    const market = book.markets?.find((m) => m.key === 'h2h');
    if (market) return market;
  }
  return null;
}

export async function fetchMoneylines(apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${apiKey}&regions=us&markets=h2h`;
  const data = await fetchJson(url);
  const results = [];
  for (const game of data) {
    const market = pickCanonicalMarket(game.bookmakers || []);
    if (!market) continue;
    const homePrice = market.outcomes?.find((o) => normalizeTeam(o.name) === normalizeTeam(game.home_team));
    const awayPrice = market.outcomes?.find((o) => normalizeTeam(o.name) === normalizeTeam(game.away_team));
    results.push({
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      commenceTime: game.commence_time,
      homeMl: homePrice ? Math.round(homePrice.price) : null,
      awayMl: awayPrice ? Math.round(awayPrice.price) : null,
    });
  }
  return results;
}

export { normalizeTeam };

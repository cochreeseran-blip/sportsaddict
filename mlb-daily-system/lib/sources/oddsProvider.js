// Pluggable odds source.
//
// Today the only provider is The Odds API free tier (500 requests/month),
// which is why odds are pulled exactly twice a day (morning generation +
// closing line). This seam exists so a PAID live-odds provider can be
// dropped in later WITHOUT a rebuild: the pipeline and the closing-line
// job call getOddsProvider() and use whatever's configured, and a live
// provider that supports frequent polling just advertises a different
// `mode`. The decision of how often to pull stays with the caller, but a
// provider declares whether frequent/live pulls are even allowed so the
// caller can't accidentally burn a metered quota.
//
// Env:
//   ODDS_PROVIDER      - provider key, default 'the-odds-api'
//   ODDS_API_KEY       - key for the-odds-api
//   (a future paid provider adds its own key var and registers below)

import { fetchMoneylines as fetchViaTheOddsApi } from './odds.js';

// Each provider is { name, mode, requiresKey, fetchMoneylines(apiKey) }.
//   mode 'scheduled' - metered; caller must ration pulls (default 2/day).
//   mode 'live'      - unmetered/high-cap; caller may poll frequently.
const PROVIDERS = {
  'the-odds-api': {
    name: 'The Odds API (free tier)',
    mode: 'scheduled',
    requiresKey: true,
    keyEnv: 'ODDS_API_KEY',
    fetchMoneylines: (apiKey) => fetchViaTheOddsApi(apiKey),
  },

  // --- PAID LIVE PROVIDER SLOT --------------------------------------------
  // A live provider registers here with mode: 'live' and its own fetch +
  // key. Nothing else in the app changes: the pipeline keeps calling
  // getOddsProvider().fetchMoneylines(key), and because mode is 'live'
  // the caller is free to poll it on a tighter cadence. Left unregistered
  // until a paid plan exists, so we ship on the free tier today and flip
  // one env var later. Example shape:
  //
  // 'live-book-feed': {
  //   name: 'Live book feed',
  //   mode: 'live',
  //   requiresKey: true,
  //   keyEnv: 'LIVE_ODDS_API_KEY',
  //   fetchMoneylines: (apiKey) => fetchViaLiveFeed(apiKey),
  // },
};

export function getOddsProvider() {
  const key = (process.env.ODDS_PROVIDER || 'the-odds-api').trim();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown ODDS_PROVIDER "${key}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

// Convenience: the configured provider's API key from its env var, or
// null when unset (callers already treat a missing key as "skip odds").
export function oddsApiKey(provider = getOddsProvider()) {
  return process.env[provider.keyEnv] || null;
}

// Does the configured provider allow frequent/live polling? Callers use
// this to decide whether a live in-game odds refresh is permitted or
// whether they must stick to the 2x/day scheduled pulls.
export function liveOddsAllowed(provider = getOddsProvider()) {
  return provider.mode === 'live';
}

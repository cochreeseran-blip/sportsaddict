// Reads bet details off a sportsbook screenshot using a Claude vision
// model, so the Tracking tab can be filled in from a photo instead of
// typed in by hand. Overridable base/model so this can point at a fixture
// in tests, same pattern as ODDS_API_BASE.
const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const VISION_MODEL = process.env.BET_SCAN_MODEL || 'claude-haiku-4-5-20251001';

const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXTRACTION_PROMPT = `You are reading a screenshot from a sportsbook app (DraftKings, FanDuel, BetMGM, Caesars, etc). The screenshot may show one bet or a list of several. Extract every distinct bet visible.

For each bet, return:
- description: short human-readable summary, e.g. "Yankees ML vs Red Sox" or "Aaron Judge over 1.5 hits"
- odds: American odds as an integer (e.g. -150 or 120), or null if not visible
- stake: dollar amount risked, as a plain number (no currency symbol), or null if not visible
- book: the sportsbook name if it's identifiable from branding/layout, or null
- gameDate: the game date in YYYY-MM-DD format if visible or clearly inferable, or null

Respond with ONLY strict JSON, no commentary, no markdown fences, in exactly this shape:
{"bets":[{"description":"...","odds":-150,"stake":25,"book":"DraftKings","gameDate":"2026-07-09"}]}

If you can't find any bet in the image, respond with {"bets":[]}.`;

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 image data URL.');
  const [, mediaType, data] = match;
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) throw new Error(`Unsupported image type: ${mediaType}`);
  return { mediaType, data };
}

// Models occasionally wrap JSON in a markdown fence despite instructions
// not to; strip it before parsing rather than failing the whole scan.
function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

function sanitizeBet(b) {
  const odds = Number.isFinite(b.odds) ? Math.round(b.odds) : null;
  const stake = Number.isFinite(b.stake) ? Number(b.stake) : null;
  const gameDate = typeof b.gameDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.gameDate) ? b.gameDate : null;
  return {
    description: String(b.description || '').slice(0, 300),
    odds,
    stake,
    book: b.book ? String(b.book).slice(0, 60) : null,
    gameDate,
  };
}

export async function scanBetSlip(dataUrl) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set, screenshot import is unavailable.');
  const { mediaType, data } = parseDataUrl(dataUrl);

  const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Vision API ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  const payload = await res.json();
  const text = (payload.content || []).find((c) => c.type === 'text')?.text || '';
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    throw new Error('Could not read a bet slip out of that screenshot, try a clearer photo.');
  }
  const bets = Array.isArray(parsed?.bets) ? parsed.bets : [];
  return bets.slice(0, 20).map(sanitizeBet).filter((b) => b.description);
}

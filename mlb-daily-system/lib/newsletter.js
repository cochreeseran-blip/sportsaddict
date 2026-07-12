// Daily email digest via Resend (https://resend.com). Fully dormant until
// RESEND_API_KEY is set. Recipients are the app's own account holders,
// their email is on file from signup, so there's no separate subscribe
// step. Each account carries a newsletter_token for the one-click
// unsubscribe link; unsubscribing sets newsletter_unsubscribed_at.
//
// Env:
//   RESEND_API_KEY     - Resend secret key (starts with "re_")
//   NEWSLETTER_FROM    - verified sender, e.g. "Slatefinder <picks@yourdomain.com>"
//   APP_BASE_URL       - public URL of this app, used for unsubscribe links,
//                        e.g. "https://slatefinder.up.railway.app"
//   OWNER_EMAIL        - always emailed, whether or not it has an account

// A recipient's unsubscribe click, keyed by the per-account token.
export async function unsubscribeAccount(pool, token) {
  if (!token) return false;
  const { rowCount } = await pool.query(
    `UPDATE users SET newsletter_unsubscribed_at = now()
     WHERE newsletter_token = $1 AND newsletter_unsubscribed_at IS NULL`,
    [token]
  );
  return rowCount > 0;
}

// Everyone with an account who hasn't opted out. { email, newsletter_token }.
async function accountRecipients(pool) {
  const { rows } = await pool.query(
    `SELECT email, newsletter_token FROM users
     WHERE email IS NOT NULL AND newsletter_unsubscribed_at IS NULL`
  );
  return rows;
}

// --- email rendering ---------------------------------------------------------
// Email HTML has to be old-school: tables-free simple divs, inline styles,
// no external CSS. Kept deliberately plain, it reads like a note, not a
// marketing blast.

const S = {
  body: 'margin:0;padding:24px 16px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1d23;',
  card: 'max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5ea;border-radius:10px;padding:28px 28px 20px;',
  h1: 'font-size:17px;font-weight:700;margin:0 0 2px;',
  date: 'font-size:13px;color:#6b7380;margin:0 0 18px;',
  h2: 'font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#6b7380;margin:22px 0 8px;border-bottom:1px solid #e3e5ea;padding-bottom:5px;',
  pick: 'margin:0 0 12px;font-size:14px;line-height:1.5;',
  pickHead: 'font-weight:600;',
  detail: 'color:#4b5563;font-size:13px;',
  win: 'color:#1a7f3d;font-weight:600;',
  loss: 'color:#c0303c;font-weight:600;',
  muted: 'color:#9aa1ad;font-size:12px;',
  footer: 'max-width:560px;margin:14px auto 0;text-align:center;font-size:12px;color:#9aa1ad;line-height:1.6;',
};

function fmtOdds(ml) {
  return ml === null || ml === undefined ? '' : ml > 0 ? `+${ml}` : `${ml}`;
}

function pickBlock(p) {
  return `<p style="${S.pick}"><span style="${S.pickHead}">${p.headline}</span><br><span style="${S.detail}">${p.detail}</span></p>`;
}

export function renderDigestEmail({ gameDate, digest, recap, unsubscribeUrl }) {
  const dateLabel = new Date(`${gameDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });

  const empty = (msg) => `<p style="${S.pick}${S.detail}">${msg}</p>`;

  const top = digest.topPicks?.length
    ? digest.topPicks.map((p, i) => pickBlock({ ...p, headline: `${i + 1}. ${p.headline}` })).join('')
    : empty('Nothing cleared the bar today, a sit day.');

  const ml = digest.moneyline?.picks?.length
    ? digest.moneyline.picks
        .map((p) =>
          pickBlock({
            headline: `${p.homeTeam}${fmtOdds(p.homeMl) ? ` (${fmtOdds(p.homeMl)})` : ''} over ${p.awayTeam}`,
            detail: `${p.homeStarterName ?? 'The home starter'} (${(p.homeStarterTrailingEra ?? p.homeStarterSeasonEra)?.toFixed(2) ?? '-'} ERA) is ${p.eraEdge?.toFixed(1) ?? '-'} runs better than ${p.awayStarterName ?? 'the visitor'} (${(p.awayStarterTrailingEra ?? p.awayStarterSeasonEra)?.toFixed(2) ?? '-'}).`,
          })
        )
        .join('')
    : empty('No qualifying games.');

  const hits = digest.hitStreak?.watchList?.length
    ? digest.hitStreak.watchList
        .map((b, i) =>
          pickBlock({
            headline: `${i + 1}. ${b.batterName} (${b.team}) to get a hit`,
            detail: `${b.hitStreak >= 5 ? `${b.hitStreak}-game hit streak` : `batting ${b.trailing15Avg?.toFixed(3) ?? '-'} L15`}, vs ${b.opposingStarterName ?? 'TBD'} (${b.opposingStarterTrailingEra?.toFixed(2) ?? '-'} ERA).`,
          })
        )
        .join('')
    : empty('No qualifying hitters.');

  const kos = digest.strikeouts?.watchList?.length
    ? digest.strikeouts.watchList
        .map((p, i) =>
          pickBlock({
            headline: `${i + 1}. ${p.pitcherName} over ${p.suggestedLine.toFixed(1)} Ks`,
            detail: `reached ${p.strictFloorKs}+ in every recent start (${p.kPerStart?.toFixed(1) ?? '-'} per start${p.trailingEra !== null && p.trailingEra !== undefined ? `, ${p.trailingEra.toFixed(2)} ERA` : ''}), vs ${p.opponent}.`,
          })
        )
        .join('')
    : empty('No qualifying K spots.');

  const recapHtml = recap?.length
    ? recap
        .map(
          (r) =>
            `<p style="${S.pick}"><span style="${r.result === 'win' ? S.win : r.result === 'loss' ? S.loss : S.detail}">${r.result.toUpperCase()}</span> &nbsp;<span style="${S.detail}">${r.description}</span></p>`
        )
        .join('')
    : empty('Nothing graded from yesterday yet.');

  return `<!doctype html><html><body style="${S.body}">
  <div style="${S.card}">
    <p style="${S.h1}">Slatefinder</p>
    <p style="${S.date}">${dateLabel}</p>

    <p style="${S.h2}">Yesterday</p>
    ${recapHtml}

    <p style="${S.h2}">Today's 6 best</p>
    ${top}

    <p style="${S.h2}">All moneyline picks</p>
    ${ml}

    <p style="${S.h2}">Top 15 hit picks</p>
    ${hits}

    <p style="${S.h2}">Top 10 K/O picks</p>
    ${kos}

    <p style="${S.muted}" >Lineups usually post 1&ndash;3 hours before first pitch &mdash; check the site for confirmed lineups before betting a hitter. Research signals only, not betting advice.</p>
  </div>
  <p style="${S.footer}">You get this because you have a Slatefinder account.<br><a href="${unsubscribeUrl}" style="color:#9aa1ad;">Unsubscribe from the daily email</a></p>
</body></html>`;
}

async function resendSend({ apiKey, from, to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Yesterday's graded signal results, for the recap section.
async function yesterdayRecap(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT description, result FROM tracked_picks
     WHERE game_date = $1::date - 1 AND result IN ('win', 'loss', 'push')
     ORDER BY signal_type, id
     LIMIT 12`,
    [gameDate]
  );
  return rows;
}

async function loadDigestForEmail(pool, gameDate) {
  const { rows } = await pool.query(
    'SELECT signal_type, details FROM daily_digest WHERE game_date = $1',
    [gameDate]
  );
  const byType = Object.fromEntries(rows.map((r) => [r.signal_type, r.details]));
  return {
    topPicks: byType.top_picks?.picks || [],
    moneyline: byType.moneyline || { picks: [] },
    hitStreak: byType.hit_streak || { watchList: [] },
    strikeouts: byType.strikeouts || { watchList: [] },
  };
}

export async function sendDailyNewsletter(pool, gameDate) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NEWSLETTER_FROM;
  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase();

  const accounts = await accountRecipients(pool);
  // Every account holder who hasn't opted out, plus OWNER_EMAIL (always,
  // whether or not it has an account), deduped so no address is sent twice.
  const recipients = [...accounts];
  if (ownerEmail && !accounts.some((a) => (a.email || '').toLowerCase() === ownerEmail)) {
    recipients.push({ email: ownerEmail, newsletter_token: null, owner: true });
  }

  if (!recipients.length) {
    console.log('Newsletter: no account holders and no OWNER_EMAIL, skipping.');
    return { sent: 0, skipped: 'no recipients' };
  }
  if (!apiKey || !from) {
    console.log(`Newsletter: ${recipients.length} recipient(s) waiting, but RESEND_API_KEY/NEWSLETTER_FROM not set, skipping send.`);
    return { sent: 0, skipped: 'not configured' };
  }

  const [digest, recap] = await Promise.all([
    loadDigestForEmail(pool, gameDate),
    yesterdayRecap(pool, gameDate),
  ]);

  const dateLabel = new Date(`${gameDate}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const topline = digest.topPicks?.[0]?.headline;
  const subject = topline ? `${dateLabel}: ${topline}` : `${dateLabel}: today's slate`;

  let sent = 0;
  for (const sub of recipients) {
    try {
      const html = renderDigestEmail({
        gameDate,
        digest,
        recap,
        // Owner-only rows have no account token, point their link at home.
        unsubscribeUrl: sub.newsletter_token ? `${baseUrl}/unsubscribe?token=${sub.newsletter_token}` : (baseUrl || '#'),
      });
      await resendSend({ apiKey, from, to: sub.email, subject, html });
      sent++;
    } catch (err) {
      console.warn(`Newsletter: send failed for ${sub.email}: ${err.message}`);
    }
  }
  console.log(`Newsletter: sent ${sent}/${recipients.length}.`);
  return { sent, total: recipients.length };
}

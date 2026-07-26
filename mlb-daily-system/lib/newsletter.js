// Daily email digest via Resend (https://resend.com). Fully dormant until
// RESEND_API_KEY is set. Recipients are the app's own account holders,
// their email is on file from signup, so there's no separate subscribe
// step. Each account carries a newsletter_token for the one-click
// unsubscribe link; unsubscribing sets newsletter_unsubscribed_at.
//
// The daily digest is a PRODUCT email (research the account signed up
// for), distinct from the admin-composed marketing sends in
// lib/adminEmail.js, and it has its own consent switch
// (newsletter_unsubscribed_at, flipped by /unsubscribe). It still
// carries all four compliance elements and refuses to send without
// them, same bar as every other outbound email.
//
// Content tier: the daily digest is a MEMBER surface. While
// PAYWALL_ENABLED is false every account holder gets it; once the
// paywall flips on, only tier = 'member' accounts do.
//
// Env:
//   RESEND_API_KEY     - Resend secret key (starts with "re_")
//   NEWSLETTER_FROM    - verified sender, e.g. "Slatefinder <picks@yourdomain.com>"
//   APP_BASE_URL       - public URL of this app, used for unsubscribe links,
//                        e.g. "https://slatefinder.up.railway.app"
//   OWNER_EMAIL        - always emailed, whether or not it has an account
//   POSTAL_ADDRESS     - physical mailing address rendered into every email
//                        (CAN-SPAM). Sends hard-refuse when unset.
//   PAYWALL_ENABLED    - 'true' gates the digest to member-tier accounts

import { verifyEmailCompliance, REQUIRED_DISCLAIMER, REQUIRED_GAMBLING_LINE } from './emailCompliance.js';

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

// Everyone who should get the digest: account holders who haven't opted
// out, narrowed to member tier once the paywall is live.
async function accountRecipients(pool) {
  const paywalled = String(process.env.PAYWALL_ENABLED || '').toLowerCase() === 'true';
  const { rows } = await pool.query(
    `SELECT email, newsletter_token FROM users
     WHERE email IS NOT NULL AND newsletter_unsubscribed_at IS NULL
       ${paywalled ? `AND tier = 'member'` : ''}`
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

// The shared compliance footer every outbound Slatefinder email carries.
// Exported so the admin compose path (lib/adminEmail.js) renders the
// exact same block instead of a divergent copy.
export function complianceFooter({ unsubscribeUrl, unsubscribeLabel, postalAddress }) {
  return `<p style="${S.footer}">${REQUIRED_DISCLAIMER}<br>${REQUIRED_GAMBLING_LINE}<br>
  <a href="${unsubscribeUrl}" style="color:#9aa1ad;">${unsubscribeLabel}</a><br>
  Slatefinder &middot; ${postalAddress || ''}</p>`;
}

export function renderDigestEmail({ gameDate, digest, recap, unsubscribeUrl, postalAddress }) {
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
            detail: `${p.awayStarterName ?? 'The away starter'} is at ${(p.awayStarterTrailingEra ?? 0).toFixed?.(2) ?? '-'} trailing ERA over ${p.awayStarterTrailingStarts > 0 ? `his last ${p.awayStarterTrailingStarts} start${p.awayStarterTrailingStarts === 1 ? '' : 's'}` : 'his recent starts'} (season ${(p.awayStarterSeasonEra ?? 0).toFixed?.(2) ?? '-'}).`,
          })
        )
        .join('')
    : empty('No qualifying games.');

  // Hit boards: the same projection produces both, so each block leads
  // with its own tier's probability. Falls back to the grade-ranked
  // watchList for digests written before the tiers existed, so an old
  // date's email still renders instead of coming back empty.
  const hitBlock = (list, tier) =>
    list
      .map((b, i) => {
        const prob = tier === 'multi' ? b.pAtLeastTwo : b.pAtLeastOne;
        const pct = prob !== null && prob !== undefined ? `${Math.round(prob * 100)}% ` : '';
        const slot = Number.isInteger(b.battingOrderSlot) ? `batting ${b.battingOrderSlot}` : 'slot not posted';
        return pickBlock({
          headline: `${i + 1}. ${b.batterName} (${b.team}) to get ${tier === 'multi' ? '2+ hits' : 'a hit'}`,
          detail: `${pct}projected${b.expectedHits ? `, ${b.expectedHits.toFixed(2)} expected hits` : ''}. Batting ${b.trailing15Avg?.toFixed(3) ?? '-'} L15 (${b.trailing15Ab ?? 0} AB), ${slot}, vs ${b.opposingStarterName ?? 'TBD'}${b.opposingHitsPer9 ? ` (${b.opposingHitsPer9.toFixed(1)} H/9)` : ''}.`,
        });
      })
      .join('');

  const multiList = digest.hitStreak?.multiHit ?? [];
  const singleList = digest.hitStreak?.singleHit?.length
    ? digest.hitStreak.singleHit
    : (digest.hitStreak?.watchList ?? []);

  const multiHits = multiList.length ? hitBlock(multiList, 'multi') : empty('Nobody projects high enough for a multi-hit call today.');
  const hits = singleList.length ? hitBlock(singleList, 'single') : empty('No qualifying hitters.');

  const homers = digest.windHr?.watchList?.length
    ? digest.windHr.watchList
        .map((b, i) =>
          pickBlock({
            headline: `${i + 1}. ${b.batterName} (${b.team}) to go deep`,
            detail: `${b.barrelPct !== null && b.barrelPct !== undefined ? `${b.barrelPct.toFixed(1)}% barrel rate` : 'recent power form'}${b.avgExitVelo ? `, ${b.avgExitVelo.toFixed(1)} mph exit velo` : ''}, vs ${b.opposingStarterName ?? 'TBD'}${b.opposingHrPer9 !== null && b.opposingHrPer9 !== undefined ? ` (${b.opposingHrPer9.toFixed(2)} HR/9 allowed)` : ''}${b.windBlowingOut ? ', wind blowing out' : ''}.`,
          })
        )
        .join('')
    : empty('No qualifying power spots.');

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

    <p style="${S.h2}">2+ hit candidates</p>
    ${multiHits}

    <p style="${S.h2}">Safest 1+ hit plays</p>
    ${hits}

    <p style="${S.h2}">Home runs</p>
    ${homers}

    <p style="${S.h2}">Top K/O picks</p>
    ${kos}

    <p style="${S.muted}">Lineups usually post 1&ndash;3 hours before first pitch &mdash; check the site for confirmed lineups before betting a hitter.</p>
  </div>
  ${complianceFooter({ unsubscribeUrl, unsubscribeLabel: 'Unsubscribe from the daily email', postalAddress })}
</body></html>`;
}

export async function resendSend({ apiKey, from, to, subject, html }) {
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
    hitStreak: byType.hit_streak || { watchList: [], multiHit: [], singleHit: [] },
    windHr: byType.wind_hr || { watchList: [] },
    strikeouts: byType.strikeouts || { watchList: [] },
  };
}

export async function sendDailyNewsletter(pool, gameDate) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NEWSLETTER_FROM;
  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const postalAddress = (process.env.POSTAL_ADDRESS || '').trim();

  const accounts = await accountRecipients(pool);
  // Every eligible account holder, plus OWNER_EMAIL (always, whether or
  // not it has an account), deduped so no address is sent twice.
  const recipients = [...accounts];
  if (ownerEmail && !accounts.some((a) => (a.email || '').toLowerCase() === ownerEmail)) {
    recipients.push({ email: ownerEmail, newsletter_token: null, owner: true });
  }

  if (!recipients.length) {
    console.log('Newsletter: no eligible recipients, skipping.');
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
      const unsubscribeUrl = sub.newsletter_token
        ? `${baseUrl}/unsubscribe?token=${sub.newsletter_token}`
        : `${baseUrl}/unsubscribe`; // owner rows have no account token
      const html = renderDigestEmail({ gameDate, digest, recap, unsubscribeUrl, postalAddress });

      // Compliance gate: the digest never leaves without all four
      // required elements in the RENDERED output. Not bypassable; a
      // missing POSTAL_ADDRESS env var stops the whole send.
      const check = verifyEmailCompliance(html, { unsubscribePath: '/unsubscribe', postalAddress });
      if (!check.ok) {
        console.error(`Newsletter: send blocked, rendered email is missing: ${check.missing.join('; ')}.`);
        return { sent, blocked: check.missing };
      }

      await resendSend({ apiKey, from, to: sub.email, subject, html });
      sent++;
    } catch (err) {
      console.warn(`Newsletter: send failed for ${sub.email}: ${err.message}`);
    }
  }
  console.log(`Newsletter: sent ${sent}/${recipients.length}.`);
  return { sent, total: recipients.length };
}

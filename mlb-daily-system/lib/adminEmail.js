// Admin-composed marketing email: a short intro plus a selection of
// today's PUBLISHED picks, sent via Resend to users who are both
// email-verified and explicitly opted in to marketing. Unpublished picks
// are not selectable anywhere in this path - they aren't real yet.
//
// Every send is compliance-gated (verifyEmailCompliance) against the
// rendered output and logged to email_sends. The unsubscribe link uses a
// signed, expiring token (lib/emailTokens.js) so it works without login
// and never exposes a raw user id or email address.

import { verifyEmailCompliance } from './emailCompliance.js';
import { complianceFooter, resendSend } from './newsletter.js';
import { makeUnsubscribeToken } from './emailTokens.js';

const S = {
  body: 'margin:0;padding:24px 16px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1d23;',
  card: 'max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5ea;border-radius:10px;padding:28px 28px 20px;',
  h1: 'font-size:17px;font-weight:700;margin:0 0 14px;',
  intro: 'font-size:14px;line-height:1.6;margin:0 0 18px;color:#2a2e36;',
  pick: 'margin:0 0 12px;font-size:14px;line-height:1.5;border-left:3px solid #d7dae0;padding-left:12px;',
  pickHead: 'font-weight:600;',
  detail: 'color:#4b5563;font-size:13px;',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAdminEmail({ intro, picks, unsubscribeUrl, postalAddress }) {
  const pickHtml = (picks || [])
    .map((p) => `<p style="${S.pick}"><span style="${S.pickHead}">${escapeHtml(p.headline)}</span><br><span style="${S.detail}">${escapeHtml(p.detail)}</span></p>`)
    .join('');
  return `<!doctype html><html><body style="${S.body}">
  <div style="${S.card}">
    <p style="${S.h1}">Slatefinder</p>
    ${intro ? `<p style="${S.intro}">${escapeHtml(intro)}</p>` : ''}
    ${pickHtml}
  </div>
  ${complianceFooter({ unsubscribeUrl, unsubscribeLabel: 'Unsubscribe from these emails', postalAddress })}
</body></html>`;
}

// The verified + opted-in marketing list. Both flags required: consent
// without a working address is useless, an address without consent is
// spam.
export async function marketingRecipients(pool) {
  const { rows } = await pool.query(
    `SELECT id, email FROM users
     WHERE email IS NOT NULL AND email_verified = true AND marketing_opt_in = true
     ORDER BY id`
  );
  return rows;
}

// Loads picks by id and verifies every one is published. Returns
// { ok, picks | error }. The headline/detail live in qualifying_metrics,
// same shape the ledger stores.
export async function loadPublishedPicks(pool, pickIds) {
  const ids = (pickIds || []).map(Number).filter(Number.isInteger);
  if (!ids.length) return { ok: false, error: 'Select at least one published pick.' };
  const { rows } = await pool.query(
    `SELECT id, published, description, qualifying_metrics FROM tracked_picks WHERE id = ANY($1)`,
    [ids]
  );
  if (rows.length !== ids.length) return { ok: false, error: 'One or more selected picks do not exist.' };
  const unpublished = rows.filter((r) => !r.published);
  if (unpublished.length) {
    return { ok: false, error: 'Only published picks can be emailed. Unpublished picks are not on the record yet.' };
  }
  return {
    ok: true,
    picks: rows.map((r) => ({
      id: r.id,
      headline: r.qualifying_metrics?.headline ?? r.description,
      detail: r.qualifying_metrics?.detail ?? '',
    })),
  };
}

export async function sendAdminEmail(pool, { adminUserId, intro, pickIds, subject }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NEWSLETTER_FROM;
  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const postalAddress = (process.env.POSTAL_ADDRESS || '').trim();

  const loaded = await loadPublishedPicks(pool, pickIds);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const recipients = await marketingRecipients(pool);
  if (!recipients.length) return { ok: false, error: 'No verified, opted-in recipients yet.' };
  if (!apiKey || !from) return { ok: false, error: 'RESEND_API_KEY / NEWSLETTER_FROM are not configured.' };

  const cleanSubject = String(subject || '').trim() || "Today's published picks";
  const cleanIntro = String(intro || '').trim();

  let sent = 0;
  for (const r of recipients) {
    const token = await makeUnsubscribeToken(pool, r.id);
    const unsubscribeUrl = `${baseUrl}/email/unsubscribe?token=${token}`;
    const html = renderAdminEmail({ intro: cleanIntro, picks: loaded.picks, unsubscribeUrl, postalAddress });

    // Hard compliance gate on the RENDERED output, per recipient (the
    // unsubscribe link is per-recipient). Any missing element aborts the
    // whole send, no partial-compliance blasts.
    const check = verifyEmailCompliance(html, { unsubscribePath: '/email/unsubscribe', postalAddress });
    if (!check.ok) {
      return { ok: false, error: `Send blocked, rendered email is missing: ${check.missing.join('; ')}.`, sent };
    }

    try {
      await resendSend({ apiKey, from, to: r.email, subject: cleanSubject, html });
      sent++;
    } catch (err) {
      console.warn(`Admin email: send failed for user #${r.id}: ${err.message}`);
    }
  }

  await pool.query(
    `INSERT INTO email_sends (admin_user_id, recipient_count, pick_ids, subject)
     VALUES ($1, $2, $3, $4)`,
    [adminUserId, sent, loaded.picks.map((p) => p.id), cleanSubject]
  );

  return { ok: true, sent, total: recipients.length };
}

// One-click marketing unsubscribe, no login: flips marketing_opt_in off
// for the user inside the signed token.
export async function marketingUnsubscribe(pool, userId) {
  const { rowCount } = await pool.query(
    `UPDATE users SET marketing_opt_in = false WHERE id = $1 AND marketing_opt_in = true`,
    [userId]
  );
  return rowCount > 0;
}

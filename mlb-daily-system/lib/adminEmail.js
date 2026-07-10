import { makeUnsubscribeToken, verifyUnsubscribeToken, renderComplianceFooter, checkComplianceRequirements } from './emailCompliance.js';

// The marketing-list unsubscribe link's target: resolves a signed token
// (no login) straight to marketing_opt_in = false. Separate from
// unsubscribeAccount in lib/newsletter.js, which turns off the daily
// research digest, this turns off admin-composed marketing sends. A user
// can be off one and on the other.
export async function unsubscribeMarketing(pool, token) {
  const userId = verifyUnsubscribeToken(token);
  if (!userId) return false;
  const { rowCount } = await pool.query(
    `UPDATE users SET marketing_opt_in = false WHERE id = $1 AND marketing_opt_in = true`,
    [userId]
  );
  return rowCount > 0;
}

// Everyone eligible for a marketing send: verified email AND explicitly
// opted in. Both have to be true — an unverified address is a bounce/spam
// risk, and marketing_opt_in defaults false and is never set without the
// user checking the box themselves (see lib/auth.js createUser).
export async function marketingAudience(pool) {
  const { rows } = await pool.query(
    `SELECT id, email FROM users WHERE email_verified = true AND marketing_opt_in = true ORDER BY id`
  );
  return rows;
}

export async function marketingAudienceCount(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE email_verified = true AND marketing_opt_in = true`
  );
  return rows[0].n;
}

// CSV of the marketing audience. Only ever produced for a POST response
// (a file download), never embedded in a URL/query string/GET response,
// see the route handler in server.js — that's the actual requirement,
// this function just builds the bytes.
export function audienceToCsv(rows) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const header = 'id,email\n';
  const body = rows.map((r) => `${r.id},${esc(r.email)}`).join('\n');
  return header + body + (rows.length ? '\n' : '');
}

// Only PUBLISHED picks are selectable for a compose — an unpublished pick
// "isn't real yet" (per spec), so it can never appear in an outbound
// email regardless of what an admin selects. This is enforced by the
// query itself (published = true is in the WHERE, not a filter the admin
// can override), not just by what the UI happens to show as options.
export async function publishedPicksForDate(pool, gameDate) {
  const { rows } = await pool.query(
    `SELECT id, description, locked_price, breakeven_pct, result, published_at
     FROM tracked_picks WHERE game_date = $1 AND signal_type = 'moneyline' AND published = true
     ORDER BY published_at`,
    [gameDate]
  );
  return rows;
}

function pickBlock(p) {
  const priceLabel = p.locked_price !== null && p.locked_price !== undefined
    ? (p.locked_price > 0 ? `+${p.locked_price}` : `${p.locked_price}`)
    : '';
  return `<p style="margin:0 0 14px;font-size:14px;line-height:1.5"><span style="font-weight:600">${p.description.split('.')[0]}${priceLabel ? ` (${priceLabel})` : ''}</span><br><span style="color:#4b5563;font-size:13px">${p.description}</span></p>`;
}

// Renders the full send-ready HTML: the admin's intro copy, the selected
// published picks, and the compliance footer baked in (not optional, not
// left to the caller to remember). unsubscribeUrl is per-recipient (their
// own signed token), so this gets called once per recipient at send time,
// not once for the whole batch.
export function renderAdminEmail({ intro, picks, unsubscribeUrl }) {
  const picksHtml = picks.length ? picks.map(pickBlock).join('') : '<p style="color:#9aa1ad;font-size:13px">No picks featured in this send.</p>';
  return `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1d23">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5ea;border-radius:10px;padding:28px">
    <p style="font-size:17px;font-weight:700;margin:0 0 16px">Slatefinder</p>
    ${intro ? `<p style="font-size:14px;line-height:1.55;margin:0 0 18px">${intro}</p>` : ''}
    ${picksHtml}
  </div>
  ${renderComplianceFooter(unsubscribeUrl)}
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

// The full compose-and-send flow. Throws (refuses to send anything) if:
//   - any picked id isn't actually published for this date
//   - the rendered compliance footer is missing any of its 4 required
//     elements (checked against the ACTUAL rendered HTML for a real
//     recipient, not assumed present because renderAdminEmail was called)
// Logs one row to email_sends on success. Best-effort per-recipient (one
// bad address doesn't abort the whole batch), same pattern as the daily
// digest sender.
export async function sendAdminEmail(pool, { adminUserId, gameDate, pickIds, intro, subject }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NEWSLETTER_FROM;
  const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (!apiKey || !from) throw new Error('RESEND_API_KEY / NEWSLETTER_FROM are not configured.');

  const available = await publishedPicksForDate(pool, gameDate);
  const availableIds = new Set(available.map((p) => p.id));
  const picks = (pickIds || []).map(Number).filter((id) => availableIds.has(id)).map((id) => available.find((p) => p.id === id));
  if ((pickIds || []).length && picks.length !== pickIds.length) {
    throw new Error('One or more selected picks are not published for this date, refusing to send.');
  }

  const recipients = await marketingAudience(pool);
  if (!recipients.length) throw new Error('No opted-in, verified recipients to send to.');

  // Compliance check against a REAL render for a REAL recipient (their
  // actual unsubscribe URL), not a synthetic/blank check, so a bug that
  // only breaks the footer for some token shapes still gets caught.
  const sampleHtml = renderAdminEmail({
    intro,
    picks,
    unsubscribeUrl: `${baseUrl}/unsubscribe-marketing?token=${makeUnsubscribeToken(recipients[0].id)}`,
  });
  const compliance = checkComplianceRequirements(sampleHtml);
  if (!compliance.ok) {
    throw new Error(`Refusing to send: rendered email is missing required elements: ${compliance.missing.join(', ')}.`);
  }

  let sent = 0;
  for (const r of recipients) {
    try {
      const html = renderAdminEmail({
        intro,
        picks,
        unsubscribeUrl: `${baseUrl}/unsubscribe-marketing?token=${makeUnsubscribeToken(r.id)}`,
      });
      await resendSend({ apiKey, from, to: r.email, subject: subject || 'Slatefinder', html });
      sent++;
    } catch (err) {
      console.warn(`Admin email: send failed for ${r.email}: ${err.message}`);
    }
  }

  await pool.query(
    `INSERT INTO email_sends (sent_by, recipient_count, pick_ids, subject) VALUES ($1, $2, $3, $4)`,
    [adminUserId, sent, picks.map((p) => p.id), subject || null]
  );

  return { sent, total: recipients.length };
}

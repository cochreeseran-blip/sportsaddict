import crypto from 'node:crypto';

// Signed, expiring, stateless unsubscribe tokens: no login required to
// click "unsubscribe" from an email (nobody should have to log in just to
// stop getting mail), and no raw user id or email address ever appears in
// the URL (a bare ?uid=123 link is trivially enumerable/scrapable). The
// token is just base64url(payload) + "." + HMAC-SHA256(payload), verified
// without a database round trip.
//
// JUDGMENT CALL: this needs a stable secret to keep tokens valid across
// restarts. If UNSUBSCRIBE_SECRET isn't set, one is generated at boot as a
// fallback so the feature still works locally/in dev, but every already-
// sent unsubscribe link becomes invalid on the next restart. This is
// fine for verification, not fine for production — set UNSUBSCRIBE_SECRET
// before sending real marketing email, see .env.example.
const SECRET = process.env.UNSUBSCRIBE_SECRET || (() => {
  const fallback = crypto.randomBytes(32).toString('hex');
  console.warn(
    'UNSUBSCRIBE_SECRET is not set, using a random one-time secret. ' +
    'Unsubscribe links sent now will stop working after the next restart. Set UNSUBSCRIBE_SECRET in .env before sending real marketing email.'
  );
  return fallback;
})();

const TOKEN_TTL_DAYS = 30;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadB64).digest());
}

export function makeUnsubscribeToken(userId) {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_DAYS * 86400000 });
  const payloadB64 = b64url(Buffer.from(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Returns the userId on a valid, unexpired, correctly-signed token, or
// null on anything wrong with it (expired, tampered, malformed).
export function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (!Number.isInteger(uid) || !Number.isFinite(exp) || Date.now() > exp) return null;
    return uid;
  } catch {
    return null;
  }
}

// The four things CAN-SPAM (and Resend's own deliverability policy)
// require in every marketing send. Hardcoded copy on the last three —
// they're legal boilerplate, not something an admin composing an email
// should be able to accidentally edit out of a specific send. The postal
// address is the one piece that can't be invented: ADMIN_POSTAL_ADDRESS
// must be set in the environment to a real address, there's no
// placeholder fallback, because a fake address would satisfy "the
// element is present" while failing the actual legal requirement it's
// there for.
export function renderComplianceFooter(unsubscribeUrl) {
  const address = process.env.ADMIN_POSTAL_ADDRESS;
  return `
    <div id="compliance-footer" style="margin-top:24px;padding-top:16px;border-top:1px solid #e3e5ea;font-size:11px;color:#9aa1ad;line-height:1.6;text-align:center">
      <p style="margin:0 0 6px"><a href="${unsubscribeUrl}" style="color:#9aa1ad">Unsubscribe from this list</a></p>
      <p style="margin:0 0 6px">${address ? address.replace(/\n/g, '<br>') : ''}</p>
      <p style="margin:0 0 4px">Research signals only. Not betting advice.</p>
      <p style="margin:0">21+. Gambling problem? Call 1-800-GAMBLER.</p>
    </div>`;
}

// The hard gate the send endpoint runs before ever calling Resend: every
// one of these four has to actually be present in the FINAL rendered
// HTML, not just "we called the function that's supposed to add them".
// Checking the rendered output (not trusting that renderComplianceFooter
// was used) is what makes this un-bypassable by a future edit that
// forgets to include the footer in some new template path.
export function checkComplianceRequirements(renderedHtml) {
  const missing = [];
  if (!/unsubscribe/i.test(renderedHtml)) missing.push('unsubscribe link');
  if (!process.env.ADMIN_POSTAL_ADDRESS || !renderedHtml.includes(process.env.ADMIN_POSTAL_ADDRESS.split('\n')[0])) {
    missing.push('physical postal address (set ADMIN_POSTAL_ADDRESS)');
  }
  if (!renderedHtml.includes('Research signals only')) missing.push('"Research signals only. Not betting advice."');
  if (!renderedHtml.includes('1-800-GAMBLER')) missing.push('"21+. Gambling problem? Call 1-800-GAMBLER."');
  return { ok: missing.length === 0, missing };
}

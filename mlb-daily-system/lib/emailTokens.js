import crypto from 'node:crypto';

// Signed, expiring tokens for one-click email links (marketing
// unsubscribe). The requirements: the link must work WITHOUT login, and
// must never carry a raw user id or email address. So the token is
// base64url(payload).base64url(hmac) where payload = { uid, exp }, signed
// with a server-side secret. The uid is inside the signed blob, opaque
// without the secret and unforgeable with it.
//
// Secret resolution: EMAIL_LINK_SECRET env var when set; otherwise a
// random secret generated once and persisted in app_secrets (see
// migrations/017), so links survive restarts/redeploys without extra
// provisioning.

const TOKEN_TTL_DAYS = 30;

let cachedSecret = null;

export async function emailLinkSecret(pool) {
  if (process.env.EMAIL_LINK_SECRET) return process.env.EMAIL_LINK_SECRET;
  if (cachedSecret) return cachedSecret;
  const fresh = crypto.randomBytes(32).toString('hex');
  // Insert-if-absent then read: two racing boots both end up with the
  // one that won the insert.
  await pool.query(
    `INSERT INTO app_secrets (name, value) VALUES ('email_link_secret', $1)
     ON CONFLICT (name) DO NOTHING`,
    [fresh]
  );
  const { rows } = await pool.query(`SELECT value FROM app_secrets WHERE name = 'email_link_secret'`);
  cachedSecret = rows[0].value;
  return cachedSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export async function makeUnsubscribeToken(pool, userId) {
  const secret = await emailLinkSecret(pool);
  const payload = b64url(JSON.stringify({
    uid: userId,
    exp: Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  }));
  return `${payload}.${sign(payload, secret)}`;
}

// Returns the user id when the token is genuine and unexpired, else null.
export async function verifyUnsubscribeToken(pool, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const secret = await emailLinkSecret(pool);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isInteger(uid) || typeof exp !== 'number' || Date.now() > exp) return null;
    return uid;
  } catch {
    return null;
  }
}

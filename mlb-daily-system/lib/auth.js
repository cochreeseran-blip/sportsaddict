import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Passwords: scrypt with a per-user random salt, packed into one string so
// the parameters can change later without a schema migration.
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, nStr, salt, hash] = parts;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: Number(nStr) }).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Auto-generated usernames: adjective + noun + number, baseball-flavored
// and intentionally ridiculous. The number keeps collisions rare; on a
// unique-violation the caller just asks for another.
const ADJECTIVES = [
  'Sweaty', 'Clutch', 'Rowdy', 'Feral', 'Soggy', 'Crusty', 'Turbo', 'Sneaky',
  'Greasy', 'Majestic', 'Wobbly', 'Spicy', 'Untucked', 'Cranky', 'Slippery',
  'Bodacious', 'Haunted', 'Juiced', 'Backdoor', 'Sidearm', 'Corked', 'Rasty',
  'Moist', 'Unhinged', 'Glorious', 'Suspicious', 'Electric', 'Grizzled',
  'Casual', 'Menacing', 'Humble', 'Slumping', 'RedHot', 'Petty', 'Immaculate',
];
const NOUNS = [
  'Dinger', 'Meatball', 'MoonShot', 'BuntGoblin', 'RallyPossum', 'PineTar',
  'Knuckleball', 'CheeseThrower', 'DugoutGremlin', 'Slugger', 'HotCorner',
  'Eephus', 'WalkOff', 'Squeeze', 'Shortstop', 'Southpaw', 'BigFly', 'Rhubarb',
  'CannonArm', 'Grinder', 'BenchBat', 'MudBall', 'RosinBag', 'Cleats',
  'SeventhInning', 'PickleKing', 'GapShot', 'Tater', 'Riser', 'Sinker',
  'BackupCatcher', 'RallyCap', 'FoulPole', 'WarningTrack', 'GoldGlove',
];

export function generateUsername() {
  const adj = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const num = crypto.randomInt(10, 10000);
  return `${adj}${noun}${num}`;
}

export function generateAvatarSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

// ---------------------------------------------------------------------------
// Schema self-heal, run at every server boot. The migrations directory
// normally handles this, but a deploy that boots older migration files
// against a newer database (or vice versa) must never be able to brick
// signups, CREATE TABLE IF NOT EXISTS silently skips a pre-existing
// users table, which is exactly how avatar_seed went missing in
// production. Everything here is idempotent.
export async function ensureAuthSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      avatar_seed INTEGER,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_seed INTEGER;
    UPDATE users SET avatar_seed = ((id::bigint * 2654435761) % 2147483647)::integer
      WHERE avatar_seed IS NULL;
    -- The daily email goes to account holders (their email is on file).
    -- These two columns carry the opt-out and the per-account unsubscribe
    -- token the email's one-click unsubscribe link uses.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_unsubscribed_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS newsletter_token TEXT;
    UPDATE users SET newsletter_token = md5(random()::text || clock_timestamp()::text || id::text)
      WHERE newsletter_token IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_newsletter_token_uidx ON users (newsletter_token);
  `);

  // The production database turned out to host a users table from an older
  // app, with its own NOT NULL columns (e.g. "role") that this app's INSERT
  // never supplies. Generically relax NOT NULL on any users column we don't
  // own and that has no default, so unknown legacy columns can never block
  // a signup. Data is left untouched.
  await pool.query(`
    DO $$
    DECLARE col record;
    BEGIN
      FOR col IN
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users'
          AND is_nullable = 'NO' AND column_default IS NULL
          AND column_name NOT IN ('id', 'email', 'username', 'password_hash')
      LOOP
        EXECUTE format('ALTER TABLE users ALTER COLUMN %I DROP NOT NULL', col.column_name);
      END LOOP;
    END $$;
  `);

  // On a legacy table the username/email columns we just added have no
  // unique constraint, which createUser's collision-retry depends on.
  // Best-effort: existing duplicate data makes this fail, and that must
  // not block boot.
  for (const idx of [
    'CREATE UNIQUE INDEX IF NOT EXISTS users_username_uidx ON users (username)',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (email)',
  ]) {
    try {
      await pool.query(idx);
    } catch (err) {
      console.warn(`ensureAuthSchema: skipped "${idx}" (${err.message})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions: opaque random tokens stored server-side.
const SESSION_DAYS = 90;

export async function createSession(pool, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [token, userId]
  );
  return token;
}

export async function destroySession(pool, token) {
  if (!token) return;
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function userForSession(pool, token) {
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.username, u.avatar_seed
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  if (!rows.length) return null;
  const u = rows[0];
  return { id: u.id, email: u.email, username: u.username, avatarSeed: u.avatar_seed };
}

// Creates the user with a generated identity, retrying the username on the
// (rare) collision. Returns the public user shape.
export async function createUser(pool, email, password) {
  const passwordHash = hashPassword(password);
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = generateUsername();
    const avatarSeed = generateAvatarSeed();
    try {
      const newsletterToken = crypto.randomBytes(24).toString('hex');
      const { rows } = await pool.query(
        `INSERT INTO users (email, username, avatar_seed, password_hash, newsletter_token)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, username, avatar_seed`,
        [email, username, avatarSeed, passwordHash, newsletterToken]
      );
      const u = rows[0];
      return { id: u.id, email: u.email, username: u.username, avatarSeed: u.avatar_seed };
    } catch (err) {
      // 23505 = unique_violation. On email it's the caller's problem; on
      // username just roll new dice.
      if (err.code === '23505' && String(err.constraint || '').includes('username')) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique username, try again.');
}

export async function authenticate(pool, email, password) {
  const { rows } = await pool.query(
    'SELECT id, email, username, avatar_seed, password_hash FROM users WHERE lower(email) = lower($1)',
    [email]
  );
  if (!rows.length) return null;
  const u = rows[0];
  if (!verifyPassword(password, u.password_hash)) return null;
  return { id: u.id, email: u.email, username: u.username, avatarSeed: u.avatar_seed };
}

// ---------------------------------------------------------------------------
// Cookie helpers (no framework, so parse and serialize by hand).
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// remember=true pins the cookie for SESSION_DAYS; remember=false makes it
// a browser-session cookie (no Max-Age), so closing the browser logs out.
// The server-side session row expires on its own schedule either way.
export function sessionCookie(token, req, { clear = false, remember = true } = {}) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
  const base = `sf_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  if (clear) return `${base}; Max-Age=0`;
  return remember ? `${base}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}` : base;
}

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
      const { rows } = await pool.query(
        `INSERT INTO users (email, username, avatar_seed, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, username, avatar_seed`,
        [email, username, avatarSeed, passwordHash]
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

export function sessionCookie(token, req, clear = false) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
  const maxAge = clear ? 0 : SESSION_DAYS * 24 * 60 * 60;
  return `sf_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

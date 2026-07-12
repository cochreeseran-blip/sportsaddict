// Live chat: one flat room, newest-last. Messages snapshot the poster's
// username and avatar_seed so the feed never has to join the accounts
// table. Signed-in users only; the poster comes from the session, never
// the request body, so nobody can post as someone else.
const MAX_BODY = 500;

export async function listMessages(pool, sinceId = 0) {
  const { rows } = await pool.query(
    `SELECT id, user_id, username, avatar_seed, body, created_at
     FROM chat_messages
     WHERE id > $1
     ORDER BY id DESC
     LIMIT 100`,
    [sinceId]
  );
  // Query is newest-first for the LIMIT; hand back oldest-first for render.
  return rows.reverse().map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    avatarSeed: r.avatar_seed,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function postMessage(pool, user, body) {
  const clean = String(body || '').trim().slice(0, MAX_BODY);
  if (!clean) throw new Error('Say something first.');
  const { rows } = await pool.query(
    `INSERT INTO chat_messages (user_id, username, avatar_seed, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, username, avatar_seed, body, created_at`,
    [user.id, user.username, user.avatarSeed, clean]
  );
  const r = rows[0];
  return { id: r.id, userId: r.user_id, username: r.username, avatarSeed: r.avatar_seed, body: r.body, createdAt: r.created_at };
}

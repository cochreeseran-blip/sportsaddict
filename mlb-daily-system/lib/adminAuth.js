import { userForSession, parseCookies } from './auth.js';

// Every /admin route and /api/admin/* endpoint calls this, server-side, on
// every single request. userForSession does a real join query against the
// users table each time (no session-cached role claim), so a role change
// via `npm run make-admin` takes effect on the admin's very next request.
// Returns the user on success; sends 403 (never a redirect, an admin
// endpoint hit by a non-admin isn't "please log in", it's "not for you")
// and returns null on failure, matching the requireUser pattern already
// used elsewhere in server.js.
export async function requireAdmin(pool, req, res, sendJson) {
  const user = await userForSession(pool, parseCookies(req).sf_session);
  if (!user) {
    sendJson(res, 403, { error: 'Not authorized.' });
    return null;
  }
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Not authorized.' });
    return null;
  }
  return user;
}

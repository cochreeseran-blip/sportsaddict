import 'dotenv/config';
import { pool } from '../lib/db.js';

// The only way an admin ever gets created: `npm run make-admin -- <email>`.
// No signup flow, no API endpoint, deliberately — promoting an account to
// admin is a decision made on a terminal with database access, not a
// button anywhere in the product.
const email = (process.argv[2] || '').trim();

async function main() {
  if (!email) {
    console.error('Usage: npm run make-admin -- <email>');
    process.exitCode = 1;
    return;
  }
  const { rows } = await pool.query(
    `UPDATE users SET role = 'admin' WHERE lower(email) = lower($1)
     RETURNING id, email, username, role`,
    [email]
  );
  if (!rows.length) {
    console.error(`No account found for ${email}. They need to sign up first.`);
    process.exitCode = 1;
    return;
  }
  const u = rows[0];
  console.log(`${u.email} (${u.username}, id ${u.id}) is now role=${u.role}.`);
}

main()
  .catch((err) => {
    console.error('make-admin failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import 'dotenv/config';
import { pool } from '../lib/db.js';

// Promotes an existing account to admin. This is the only way the first
// admin gets created: there is deliberately no signup path, UI control,
// or API endpoint that can mint an admin, only someone with shell/DB
// access to the deployment can run this.
//
//   npm run make-admin -- you@example.com

async function main() {
  const email = (process.argv[2] || '').trim();
  if (!email) {
    console.error('Usage: npm run make-admin -- <email>');
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query(
    `UPDATE users SET role = 'admin'
     WHERE lower(email) = lower($1)
     RETURNING id, email, username, role`,
    [email]
  );

  if (!rows.length) {
    console.error(`No account found for ${email}. They need to sign up on the site first.`);
    process.exitCode = 1;
    return;
  }

  const u = rows[0];
  console.log(`Done: ${u.email} (user #${u.id}, ${u.username}) is now an admin.`);
  console.log('They can open /admin next time they are signed in. The role is checked server-side on every request.');
}

main()
  .catch((err) => {
    console.error('make-admin failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Without these, a stalled connection or a slow query can hang forever,
  // which on the web dashboard means the "Refresh now" run never finishes
  // and the UI is stuck showing "Refreshing..." indefinitely.
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  idleTimeoutMillis: 30_000,
});

export async function query(text, params) {
  return pool.query(text, params);
}

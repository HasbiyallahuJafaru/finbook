// `pnpm db:migrate`: local databases and staging only (CLAUDE.md). DATABASE_OWNER_URL is the owner connection;
// FINBOOK_API_DB_PASSWORD (optional) sets the finbook_api login password. Neither is ever printed.
import pg from 'pg';
import { migrate } from './index.ts';

const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('DATABASE_OWNER_URL is required');
const pool = new pg.Pool({ connectionString: url });
try {
  await migrate(pool, process.env.FINBOOK_API_DB_PASSWORD);
  console.log('migrations applied');
} finally {
  await pool.end();
}

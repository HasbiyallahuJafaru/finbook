// `pnpm db:migrate`: local databases and staging only (CLAUDE.md). Needs DATABASE_URL.
import pg from 'pg';
import { migrate } from './index.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: url });
try {
  await migrate(pool);
  console.log('migrations applied');
} finally {
  await pool.end();
}

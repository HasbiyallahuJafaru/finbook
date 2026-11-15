import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.ts';

export { schema };

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Apply all pending forward-only migrations. Run as the database owner. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await drizzleMigrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
}

export type Tx = { db: NodePgDatabase<typeof schema>; client: pg.PoolClient };

/**
 * The only way app code should touch tenant data: one transaction, running as finbook_app (so RLS applies,
 * even though the pool connects as the owner) with app.tenant_id set for this transaction only.
 * Deferred ledger checks run at COMMIT; if they fail, the error is thrown here and nothing is kept.
 */
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE finbook_app');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn({ db: drizzle(client, { schema }), client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

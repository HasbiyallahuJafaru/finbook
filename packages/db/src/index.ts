import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.ts';

export { schema };

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Apply all pending forward-only migrations. Run with the OWNER connection, never the API's.
 * If apiPassword is given, it becomes the finbook_api login password (kept out of the migrations).
 */
export async function migrate(ownerPool: pg.Pool, apiPassword?: string): Promise<void> {
  await drizzleMigrate(drizzle(ownerPool), { migrationsFolder: MIGRATIONS_DIR });
  if (apiPassword) {
    const { rows } = await ownerPool.query<{ stmt: string }>("SELECT format('ALTER ROLE finbook_api PASSWORD %L', $1::text) AS stmt", [apiPassword]);
    await ownerPool.query(rows[0]?.stmt ?? '');
  }
}

export type Tx = { db: NodePgDatabase<typeof schema>; client: pg.PoolClient };
export type Actor = { tenantId: string; userId: string };

/**
 * The only way app code touches tenant data. The pool must log in as finbook_api (never the owner):
 * one transaction, SET LOCAL ROLE finbook_app (under RLS), app.tenant_id and app.user_id for this
 * transaction only. Deferred ledger checks run at COMMIT; if they fail, this throws and nothing is kept.
 */
export async function withTenant<T>(pool: pg.Pool, actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE finbook_app');
    await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [actor.tenantId, actor.userId]);
    const db = drizzle(client, { schema });
    // drizzle's db.transaction() would send a real COMMIT and end this transaction early.
    db.transaction = () => { throw new Error('nested transactions are not allowed inside withTenant'); };
    const result = await fn({ db, client });
    // COMMIT on an aborted transaction "succeeds" with the tag ROLLBACK: treat that as the failure it is.
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('transaction was rolled back (an earlier statement failed)');
    return result;
  } catch (err) {
    failure = err;
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release(failure instanceof Error ? failure : undefined);
  }
}

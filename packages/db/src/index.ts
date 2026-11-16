import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.ts';

export { schema };

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Apply all pending forward-only migrations. Run with the OWNER connection, never the API's.
 * Login passwords for finbook_api, finbook_rates and finbook_hook are set here when given, so they never sit in a migration.
 */
export async function migrate(ownerPool: pg.Pool, passwords: { api?: string; rates?: string; hook?: string } = {}): Promise<void> {
  await drizzleMigrate(drizzle(ownerPool), { migrationsFolder: MIGRATIONS_DIR });
  for (const [role, password] of [['finbook_api', passwords.api], ['finbook_rates', passwords.rates], ['finbook_hook', passwords.hook]] as const) {
    if (!password) continue;
    const { rows } = await ownerPool.query<{ stmt: string }>('SELECT format($1::text, $2::text) AS stmt', [`ALTER ROLE ${role} PASSWORD %L`, password]);
    await ownerPool.query(rows[0]?.stmt ?? '');
  }
}

export type Tx = { db: NodePgDatabase<typeof schema>; client: pg.PoolClient };
export type Actor = { tenantId: string; userId: string };

/**
 * The only way app code touches tenant data. The pool must log in as finbook_api (never the owner):
 * one transaction, SET LOCAL ROLE finbook_app (under RLS), app.tenant_id and app.user_id for this
 * transaction only. Deferred ledger checks run at COMMIT; if they fail, this throws and nothing is kept.
 * role 'finbook_sync' is only for the Clerk webhook's own pool (the finbook_hook login); finbook_api can't take it.
 */
export async function withTenant<T>(pool: pg.Pool, actor: Actor, fn: (tx: Tx) => Promise<T>, role: 'finbook_app' | 'finbook_sync' = 'finbook_app'): Promise<T> {
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    await client.query(role === 'finbook_sync' ? 'SET LOCAL ROLE finbook_sync' : 'SET LOCAL ROLE finbook_app');
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

/** role is one of the six in @app/contracts ROLES; the table CHECKs hold the same list. */
export type Access = { tenantId: string; role: string };

/** Find the tenant of a Clerk org through the narrow tenant_by_org policy, then act for it in this transaction. */
async function enterTenantByOrg(client: pg.PoolClient, clerkOrgId: string): Promise<string | undefined> {
  await client.query("SELECT set_config('app.clerk_org_id', $1, true)", [clerkOrgId]);
  const tenantId = (await client.query<{ id: string }>('SELECT id FROM tenants WHERE clerk_org_id = $1', [clerkOrgId])).rows[0]?.id;
  await client.query("SELECT set_config('app.clerk_org_id', '', true)");
  if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  return tenantId;
}

/**
 * The tenant and role a verified Clerk user has, read under RLS. The tenant comes from the X-Tenant-Id header or the
 * token's active Organization. Exactly one of:
 * - a firm_access assignment (firm staff), or
 * - a live client membership, which counts only while the token's active org (tokenOrgId) IS this tenant's org:
 *   Clerk's own membership is a second check, so a missed webhook can only narrow access, never keep a removed user in.
 * Firm staff never get a client role, anywhere. No row, both, or a tenant that isn't active: null, never a guess.
 */
export async function resolveAccess(pool: pg.Pool, userId: string, where: { tenantId: string } | { clerkOrgId: string }, tokenOrgId: string | undefined): Promise<Access | null> {
  return withTenant(pool, { tenantId: '', userId }, async ({ client }) => {
    let tenantId: string | undefined;
    if ('tenantId' in where) {
      tenantId = where.tenantId;
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    } else tenantId = await enterTenantByOrg(client, where.clerkOrgId);
    if (!tenantId) return null;
    const tenant = (await client.query<{ clerk_org_id: string | null }>("SELECT clerk_org_id FROM tenants WHERE id = $1 AND status = 'active'", [tenantId])).rows[0];
    if (!tenant) return null;
    const staff = (await client.query('SELECT 1 FROM firm_staff WHERE clerk_user_id = $1', [userId])).rowCount !== 0;
    // tokenOrgId must come from the verified token, never from client input.
    const clientRoleCounts = !staff && tenant.clerk_org_id !== null && tenant.clerk_org_id === tokenOrgId;
    const { rows } = await client.query<{ role: string }>(
      `SELECT role FROM firm_access WHERE clerk_user_id = $1
       UNION ALL SELECT role FROM memberships WHERE clerk_user_id = $1 AND revoked_at IS NULL AND $2::boolean`, [userId, clientRoleCounts]);
    return rows.length === 1 && rows[0] ? { tenantId, role: rows[0].role } : null;
  });
}

export type MembershipEvent = { clerkOrgId: string; clerkUserId: string; role: string | null; eventMs: bigint };

/**
 * Mirror one Clerk organization-membership event (the webhook, ADR 0013). Needs the webhook's pool (finbook_hook).
 * role null means "no access" (removed, or a Clerk role we don't map). Applied only if newer than the last event for
 * that member, so retries, duplicates and out-of-order deliveries are harmless; on a tie the lesser access wins
 * (removal, then viewer < staff < owner). A removal
 * that arrives first leaves a tombstone a late "created" can't undo. Firm staff are never mirrored.
 */
export async function applyMembershipEvent(hookPool: pg.Pool, e: MembershipEvent): Promise<'applied' | 'stale' | 'no_tenant'> {
  return withTenant(hookPool, { tenantId: '', userId: 'system:clerk-webhook' }, async ({ client }) => {
    const tenantId = await enterTenantByOrg(client, e.clerkOrgId);
    if (!tenantId) return 'no_tenant';
    const staff = (await client.query('SELECT 1 FROM firm_staff WHERE clerk_user_id = $1', [e.clerkUserId])).rowCount !== 0;
    const { rowCount } = await client.query(
      `INSERT INTO memberships (tenant_id, clerk_user_id, role, revoked_at, clerk_event_ms)
       VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN now() END, $4)
       ON CONFLICT (tenant_id, clerk_user_id) DO UPDATE
         SET role = EXCLUDED.role, revoked_at = EXCLUDED.revoked_at, clerk_event_ms = EXCLUDED.clerk_event_ms
         WHERE memberships.clerk_event_ms < EXCLUDED.clerk_event_ms
            OR (memberships.clerk_event_ms = EXCLUDED.clerk_event_ms
                AND coalesce(array_position(ARRAY['client_viewer', 'client_staff', 'client_owner'], EXCLUDED.role), 0)
                  < coalesce(array_position(ARRAY['client_viewer', 'client_staff', 'client_owner'], memberships.role), 0))`,
      [tenantId, e.clerkUserId, staff ? null : e.role, e.eventMs.toString()]);
    return rowCount === 1 ? 'applied' : 'stale';
  }, 'finbook_sync');
}

/**
 * organization.deleted: revoke every membership of that org's tenant (Clerk's tokens already stop naming the org), and
 * stamp every row, revoked ones too, so no delayed event from before the deletion can bring one back.
 * ponytail: a user first seen after the deletion could still get a row; harmless while no token names the dead org,
 * so record the deletion on the tenant before any tenant is ever relinked to a new Clerk org.
 */
export async function revokeOrganization(hookPool: pg.Pool, clerkOrgId: string, eventMs: bigint): Promise<'applied' | 'no_tenant'> {
  return withTenant(hookPool, { tenantId: '', userId: 'system:clerk-webhook' }, async ({ client }) => {
    if (!(await enterTenantByOrg(client, clerkOrgId))) return 'no_tenant';
    await client.query(
      `UPDATE memberships SET role = NULL, revoked_at = coalesce(revoked_at, now()), clerk_event_ms = greatest(clerk_event_ms, $1)`,
      [eventMs.toString()]);
    return 'applied';
  }, 'finbook_sync');
}

// Auth and tenancy through the real API and a real Postgres (Testcontainers; needs Docker). Tokens are signed with a
// throwaway RSA key standing in for Clerk's instance key, verified networkless via CLERK_JWT_KEY, as in production.
// cat is the header Clerk puts on session tokens (@clerk/backend refuses tokens without it).
import 'reflect-metadata';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '@app/db';
import { AppModule } from './app.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { poolProvider } from './db.js';

const API_PASSWORD = 'test-only-password'; // fixture: the throwaway container's finbook_api login
const HOOK_PASSWORD = 'test-only-hook'; // fixture: the throwaway container's finbook_hook login
const PARTY = 'https://app.finbook.test';
const ISSUER = 'https://clerk.finbook.test';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const WEBHOOK_KEY = randomBytes(24); // fixture: a throwaway Svix signing secret
const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY.toString('base64')}`;

let container: StartedPostgreSqlContainer;
let ownerPool: pg.Pool;
let app: INestApplication;
let url = '';
let tenantA = '';
let tenantB = '';

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(claims: Record<string, unknown>, key: KeyObject = keys.privateKey, cat = 'cl_B7d4PD111AAA'): string {
  const ms = Date.now();
  const now = (ms - (ms % 1000)) / 1000; // whole seconds
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_test', cat })}.${b64({
    iss: ISSUER, azp: PARTY, sid: 'sess_test', v: 2, iat: now, nbf: now - 5, exp: now + 60, fva: [1, -1], ...claims,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { headers });
/** POST a Clerk webhook signed the way Svix signs it: base64 HMAC-SHA256 of "id.timestamp.body". */
function webhook(event: object, key: Buffer = WEBHOOK_KEY) {
  const id = `msg_${randomUUID()}`;
  const ms = Date.now();
  const ts = String((ms - (ms % 1000)) / 1000);
  const body = JSON.stringify(event);
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return fetch(`${url}/webhooks/clerk`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` } });
}
const membership = (type: string, userId: string, role: string, timestamp: number, org = 'org_a') => ({
  type, timestamp, object: 'event', instance_id: 'ins_test',
  data: { object: 'organization_membership', id: `orgmem_${userId}`, role, organization: { id: org }, public_user_data: { user_id: userId } },
});

const bearer = (claims: Record<string, unknown>, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token(claims)}`, ...extra });

before(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  ownerPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  await migrate(ownerPool, { api: API_PASSWORD, hook: HOOK_PASSWORD });
  const tenant = async (name: string, org: string) =>
    (await ownerPool.query<{ id: string }>('INSERT INTO tenants (legal_name, clerk_org_id) VALUES ($1, $2) RETURNING id', [name, org])).rows[0]?.id ?? '';
  tenantA = await tenant('Tenant A Ltd', 'org_a');
  tenantB = await tenant('Tenant B Ltd', 'org_b');
  const suspended = await tenant('Tenant S Ltd', 'org_s');
  await ownerPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [suspended]);
  await ownerPool.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_owner_s', 'client_owner')", [suspended]);
  await ownerPool.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_owner_a', 'client_owner'), ($2, 'user_owner_b', 'client_owner')", [tenantA, tenantB]);
  await ownerPool.query("INSERT INTO firm_staff (clerk_user_id) VALUES ('user_staff')");
  await ownerPool.query("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_staff', 'firm_accountant', 'user_admin')", [tenantA]);

  process.env.DATABASE_URL = `postgresql://finbook_api:${API_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;
  process.env.WEBHOOK_DATABASE_URL = `postgresql://finbook_hook:${HOOK_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;
  process.env.CLERK_JWT_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' });
  process.env.CLERK_AUTHORIZED_PARTIES = PARTY;
  process.env.CLERK_ISSUER = ISSUER;
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = WEBHOOK_SECRET;
  app = await NestFactory.create(AppModule, { logger: false, rawBody: true });
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
});

after(async () => {
  await app.close();
  await ownerPool.end();
  await container.stop();
});

describe('GET /me', () => {
  test('a client owner resolves by active org, or by naming their own tenant while that org is active', async () => {
    for (const headers of [bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }), bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }, { 'x-tenant-id': tenantA })]) {
      const res = await get('/me', headers);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { tenantId: tenantA, legalName: 'Tenant A Ltd', userId: 'user_owner_a', role: 'client_owner', permissions: ['me.read'] });
      assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    }
  });

  test("another tenant's id or org gives 404 with no data, same as an unknown id", async () => {
    const answers = [];
    for (const headers of [
      bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }, { 'x-tenant-id': tenantB }),
      bearer({ sub: 'user_owner_a' }, { 'x-tenant-id': tenantA }), // no live org: removed in Clerk, the mirror can't keep them in
      bearer({ sub: 'user_owner_a', o: { id: 'org_b' } }),
      bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }, { 'x-tenant-id': '00000000-0000-7000-8000-000000000000' }),
    ]) {
      const res = await get('/me', headers);
      const text = await res.text();
      assert.equal(res.status, 404);
      assert.doesNotMatch(text, /Tenant B|org_b|user_owner_b/);
      answers.push(text);
    }
    assert.equal(new Set(answers).size, 1);
  });

  test('firm staff reach only assigned tenants, and only with a second factor', async () => {
    assert.equal((await get('/me', bearer({ sub: 'user_staff' }, { 'x-tenant-id': tenantA }))).status, 403); // fva [1, -1]
    const ok = await get('/me', bearer({ sub: 'user_staff', fva: [1, 1] }, { 'x-tenant-id': tenantA }));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { role: string }).role, 'firm_accountant');
    assert.equal((await get('/me', bearer({ sub: 'user_staff', fva: [1, 1] }, { 'x-tenant-id': tenantB }))).status, 404);
  });

  test('bad or missing tokens are 401', async () => {
    const ms = Date.now();
  const now = (ms - (ms % 1000)) / 1000; // whole seconds
    assert.equal((await get('/me')).status, 401);
    assert.equal((await get('/me', { authorization: 'Bearer not-a-jwt' })).status, 401);
    assert.equal((await get('/me', { authorization: `Bearer ${token({ sub: 'user_owner_a', o: { id: 'org_a' } }, otherKeys.privateKey)}` })).status, 401);
    for (const claims of [
      { exp: now - 120, iat: now - 180, nbf: now - 180 }, // expired
      { azp: 'https://evil.test' }, // not an authorized party
      { sts: 'pending' }, // Clerk session tasks unfinished
      { sub: '' },
      { v: 1 }, // not a v2 session token
      { sid: undefined },
      { iss: 'https://other-instance.clerk.test' },
    ]) assert.equal((await get('/me', bearer({ sub: 'user_owner_a', o: { id: 'org_a' }, ...claims }))).status, 401, JSON.stringify(claims));
  });

  test('a JWT-template token is refused even though Clerk signed it', async () => {
    const template = token({ sub: 'user_owner_a', o: { id: 'org_a' } }, keys.privateKey, 'cl_B7d4PD222AAA');
    assert.equal((await get('/me', { authorization: `Bearer ${template}` })).status, 401);
  });

  test("a suspended tenant's members get the same 404", async () => {
    assert.equal((await get('/me', bearer({ sub: 'user_owner_s', o: { id: 'org_s' } }))).status, 404);
  });

  test('the request id is ours, never the caller supplied one', async () => {
    const mine = '019a0000-0000-7000-8000-000000000001';
    const res = await get('/me', bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }, { 'x-request-id': mine }));
    assert.notEqual(res.headers.get('x-request-id'), mine);
  });

  test('no tenant chosen, a malformed or a repeated X-Tenant-Id is 400', async () => {
    const twice = new Headers(bearer({ sub: 'user_owner_a' }));
    twice.append('x-tenant-id', tenantA);
    twice.append('x-tenant-id', tenantA);
    assert.equal((await fetch(`${url}/me`, { headers: twice })).status, 400);
    assert.equal((await get('/me', bearer({ sub: 'user_owner_a' }))).status, 400);
    assert.equal((await get('/me', bearer({ sub: 'user_owner_a' }, { 'x-tenant-id': "' OR 1=1 --" }))).status, 400);
  });

  test('unconfigured auth fails closed (503), and /health stays public', async () => {
    const saved = process.env.CLERK_JWT_KEY;
    delete process.env.CLERK_JWT_KEY;
    try {
      assert.equal((await get('/me', bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }))).status, 503);
    } finally {
      process.env.WEBHOOK_DATABASE_URL = `postgresql://finbook_hook:${HOOK_PASSWORD}@${container.getHost()}:${String(container.getPort())}/${container.getDatabase()}`;
  process.env.CLERK_JWT_KEY = saved;
    }
    assert.equal((await get('/health')).status, 200);
  });
});

test('a route without @Can or @Public is refused, even for a valid caller (default deny)', async () => {
  @Controller('open')
  class Open {
    @Get()
    open() {
      return 'leaked';
    }
  }
  @Module({ controllers: [Open], providers: [poolProvider, { provide: APP_GUARD, useClass: AuthGuard }] })
  class OpenModule {}
  const open = await NestFactory.create(OpenModule, { logger: false });
  await open.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`${await open.getUrl()}/open`, { headers: bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }) })).status, 403);
  } finally {
    await open.close();
  }
});

describe('POST /webhooks/clerk', () => {
  const me = (sub: string, org = 'org_a') => get('/me', bearer({ sub, o: { id: org } }));
  const result = async (res: Response) => ((await res.json()) as { result: string }).result;
  const role = async (res: Response) => ((await res.json()) as { role: string }).role;

  test('a signed membership event grants the mapped role; a repeat changes nothing', async () => {
    const created = membership('organizationMembership.created', 'user_hook', 'org:client_staff', 1000);
    assert.equal(await result(await webhook(created)), 'applied');
    assert.equal(await result(await webhook(created)), 'stale');
    assert.equal(await role(await me('user_hook')), 'client_staff');
  });

  test('a removal revokes access, and an older delivery arriving late does not restore it', async () => {
    await webhook(membership('organizationMembership.created', 'user_gone', 'org:client_owner', 1000));
    const deleted = membership('organizationMembership.deleted', 'user_gone', 'org:client_owner', 3000);
    delete (deleted.data as { role?: string }).role; // a deletion needs only who and where
    assert.equal(await result(await webhook(deleted)), 'applied');
    assert.equal(await result(await webhook(membership('organizationMembership.updated', 'user_gone', 'org:client_owner', 2000))), 'stale');
    assert.equal((await me('user_gone')).status, 404);
  });

  test("an event for one org never grants anything in another tenant", async () => {
    await webhook(membership('organizationMembership.created', 'user_cross', 'org:client_owner', 1000, 'org_b'));
    assert.equal(await role(await me('user_cross', 'org_b')), 'client_owner');
    assert.equal((await me('user_cross', 'org_a')).status, 404);
    assert.equal((await get('/me', bearer({ sub: 'user_cross', o: { id: 'org_b' } }, { 'x-tenant-id': tenantA }))).status, 404);
  });

  test("roles we don't map, and firm staff, get no client membership", async () => {
    await webhook(membership('organizationMembership.created', 'user_clerk_admin', 'org:admin', 1000));
    assert.equal((await me('user_clerk_admin')).status, 404);
    await webhook(membership('organizationMembership.created', 'user_proto', 'constructor', 1000));
    assert.equal((await me('user_proto')).status, 404);
    await webhook(membership('organizationMembership.created', 'user_staff', 'org:client_owner', 1000, 'org_b'));
    assert.equal((await me('user_staff', 'org_b')).status, 404);
    assert.equal(await role(await get('/me', bearer({ sub: 'user_staff', fva: [1, 1] }, { 'x-tenant-id': tenantA }))), 'firm_accountant');
  });

  test('organization.deleted revokes every member of that tenant', async () => {
    await webhook(membership('organizationMembership.created', 'user_s1', 'org:client_owner', 1000, 'org_s'));
    assert.equal(await result(await webhook({ type: 'organization.deleted', timestamp: 5000, object: 'event', data: { object: 'organization', id: 'org_s', deleted: true } })), 'applied');
    const rows = (await ownerPool.query<{ n: string }>("SELECT count(*) AS n FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE t.clerk_org_id = 'org_s' AND m.revoked_at IS NULL")).rows[0]?.n;
    assert.equal(rows, '0');
  });

  test('a membership event we cannot read is a 500 (Clerk retries), never a silent 200', async () => {
    const res = await webhook({ type: 'organizationMembership.deleted', timestamp: 1000, object: 'event', data: { organization: { id: 'org_a' } } });
    assert.equal(res.status, 500);
  });

  test('a bad signature or missing headers is 400; other event types are ignored', async () => {
    assert.equal((await webhook(membership('organizationMembership.created', 'user_forged', 'org:client_owner', 1000), randomBytes(24))).status, 400);
    assert.equal((await fetch(`${url}/webhooks/clerk`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 400);
    assert.equal((await me('user_forged')).status, 404);
    assert.equal(await result(await webhook({ type: 'user.created', timestamp: 1000, object: 'event', data: { id: 'user_1' } })), 'ignored');
  });

  test('no signing secret: 503 with nothing about why, so Clerk keeps retrying', async () => {
    delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    try {
      const res = await webhook(membership('organizationMembership.created', 'user_wait', 'org:client_owner', 1000));
      assert.equal(res.status, 503);
      assert.doesNotMatch(await res.text(), /config|secret/i);
    } finally {
      process.env.CLERK_WEBHOOK_SIGNING_SECRET = WEBHOOK_SECRET;
    }
  });
});

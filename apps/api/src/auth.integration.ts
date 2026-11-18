// Auth and tenancy through the real API and a real Postgres (Testcontainers; needs Docker). Tokens are signed with a
// throwaway RSA key standing in for Clerk's instance key, verified networkless via CLERK_JWT_KEY, as in production.
// cat is the header Clerk puts on session tokens (@clerk/backend refuses tokens without it).
import 'reflect-metadata';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { migrate } from '@app/db';
import { AppModule } from './app.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { permissionsOf } from './auth/permissions.js';
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
let s3: StartedTestContainer; // S3Mock: an S3-compatible stand-in for R2 (it does not check signatures)
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
  s3 = await new GenericContainer('adobe/s3mock:4.7.0').withEnvironment({ COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS: 'staging,evidence' }).withExposedPorts(9090).start();
  Object.assign(process.env, {
    R2_ENDPOINT: `http://${s3.getHost()}:${String(s3.getMappedPort(9090))}`, R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture', // fixture credentials
    R2_STAGING_BUCKET: 'staging', R2_EVIDENCE_BUCKET: 'evidence',
  });
  ownerPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  await migrate(ownerPool, { api: API_PASSWORD, hook: HOOK_PASSWORD });
  const tenant = async (name: string, org: string) =>
    (await ownerPool.query<{ id: string }>("INSERT INTO tenants (legal_name, clerk_org_id, go_live_on) VALUES ($1, $2, '2026-01-01') RETURNING id", [name, org])).rows[0]?.id ?? '';
  tenantA = await tenant('Tenant A Ltd', 'org_a');
  tenantB = await tenant('Tenant B Ltd', 'org_b');
  // Each client's default chart of accounts, as onboarding seeds it (0016).
  const seeding = await ownerPool.connect();
  try {
    await seeding.query('BEGIN');
    await seeding.query("SELECT set_config('app.user_id', 'user_admin', true)");
    await seeding.query('SELECT seed_default_chart(id) FROM tenants');
    await seeding.query('COMMIT');
  } finally {
    seeding.release();
  }
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
  await s3.stop();
});

describe('GET /me', () => {
  test('a client owner resolves by active org, or by naming their own tenant while that org is active', async () => {
    for (const headers of [bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }), bearer({ sub: 'user_owner_a', o: { id: 'org_a' } }, { 'x-tenant-id': tenantA })]) {
      const res = await get('/me', headers);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { tenantId: tenantA, legalName: 'Tenant A Ltd', userId: 'user_owner_a', role: 'client_owner', permissions: permissionsOf('client_owner') });
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

describe('counterparties and vehicles', () => {
  const ownerA = { sub: 'user_owner_a', o: { id: 'org_a' } };
  const ownerB = { sub: 'user_owner_b', o: { id: 'org_b' } };
  const viewerA = { sub: 'user_viewer_a', o: { id: 'org_a' } };
  const post = (path: string, claims: Record<string, unknown>, body: unknown, key: string | null = randomUUID()) =>
    fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { ...bearer(claims), 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) } });
  const car = { vin: '1M8GDM9AXKP042788', make: 'BYD', model: 'Song Plus', year: 2023, purchaseDate: '2026-01-08' };

  before(() => ownerPool.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_viewer_a', 'client_viewer')", [tenantA]));

  test('a recorder adds a car; it reads back, flagged by the database, and its write is audited', async () => {
    const res = await post('/vehicles', ownerA, { ...car, vin: ' 1m8gdm9axkp042788 ' });
    assert.equal(res.status, 201);
    const v = (await res.json()) as { id: string; vin: string; vinStatus: string; vinProblem: string | null; direction: string; status: string; purchaseDate: string };
    assert.deepEqual([v.vin, v.vinStatus, v.vinProblem, v.direction, v.status, v.purchaseDate], ['1M8GDM9AXKP042788', 'ok', null, 'import', 'purchased', '2026-01-08']);
    const again = await get(`/vehicles/${v.id}`, bearer(ownerA));
    assert.equal(((await again.json()) as { id: string }).id, v.id);
    const audit = await ownerPool.query("SELECT actor FROM audit_log WHERE entity = 'vehicles' AND entity_id = $1", [v.id]);
    assert.deepEqual(audit.rows, [{ actor: 'user_owner_a' }]);
  });

  test('a VIN that fails the check is still recorded, flagged vin_needs_correction with the reason; a duplicate is 409', async () => {
    const res = await post('/vehicles', ownerA, { ...car, vin: '1M8GDM9A1KP042788' });
    assert.equal(res.status, 201);
    const v = (await res.json()) as { vinStatus: string; vinProblem: string };
    assert.deepEqual([v.vinStatus, v.vinProblem], ['vin_needs_correction', 'check digit (9th character) should be X']);
    const dup = await post('/vehicles', ownerA, car);
    assert.equal(dup.status, 409);
    assert.match(await dup.text(), /already recorded/);
    assert.equal((await post('/vehicles', ownerB, car)).status, 201); // VINs are unique per tenant, not across tenants
    const flagged = (await (await get('/vehicles?vinStatus=vin_needs_correction', bearer(ownerA))).json()) as unknown[];
    assert.equal(flagged.length, 1);
  });

  test('the same Idempotency-Key twice gives one effect and the same answer; reused for another body, 422; missing, 400', async () => {
    const key = randomUUID();
    const body = { kind: 'supplier', name: 'Guangzhou Auto Export Co' };
    const first = await post('/counterparties', ownerA, body, key);
    const second = await post('/counterparties', ownerA, body, key);
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.deepEqual(await second.json(), await first.json());
    const [a, b] = await Promise.all([post('/counterparties', ownerA, { kind: 'agent', name: 'Racer' }, 'race-key-1'), post('/counterparties', ownerA, { kind: 'agent', name: 'Racer' }, 'race-key-1')]);
    assert.deepEqual(await a.json(), await b.json()); // two copies at once: still one row
    const rows = await ownerPool.query<{ n: number }>("SELECT count(*)::int AS n FROM counterparties WHERE name IN ('Guangzhou Auto Export Co', 'Racer')");
    assert.equal(rows.rows[0]?.n, 2);
    assert.equal((await post('/counterparties', ownerA, { kind: 'customer', name: 'Someone else' }, key)).status, 422);
    assert.equal((await post('/counterparties', ownerA, body, null)).status, 400);
  });

  test('invalid input is a 400 that names the field', async () => {
    const res = await post('/vehicles', ownerA, { ...car, year: 1900, extra: 'x' });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(text, /year/);
    assert.equal((await post('/counterparties', ownerA, { kind: 'bank', name: 'x' })).status, 400);
    assert.equal((await get('/vehicles/not-a-uuid', bearer(ownerA))).status, 400);
  });

  test('a viewer (investor) neither writes nor reads the car list or the counterparty register (403)', async () => {
    assert.equal((await post('/vehicles', viewerA, { ...car, vin: '11111111111111111' })).status, 403);
    assert.equal((await post('/counterparties', viewerA, { kind: 'customer', name: 'x' })).status, 403);
    assert.equal((await get('/vehicles', bearer(viewerA))).status, 403);
    assert.equal((await get('/counterparties', bearer(viewerA))).status, 403);
  });

  test("an Idempotency-Key is per tenant and per user: reusing another's key gets its own answer or a 422", async () => {
    const key = randomUUID();
    const a = (await (await post('/counterparties', ownerA, { kind: 'customer', name: 'Same key' }, key)).json()) as { id: string };
    const b = await post('/counterparties', ownerB, { kind: 'customer', name: 'Same key' }, key);
    assert.equal(b.status, 201);
    assert.notEqual(((await b.json()) as { id: string }).id, a.id); // B's own row, none of A's answer
    await ownerPool.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_staff_a', 'client_staff')", [tenantA]);
    assert.equal((await post('/counterparties', { sub: 'user_staff_a', o: { id: 'org_a' } }, { kind: 'customer', name: 'Same key' }, key)).status, 422);
  });

  test('a write for another tenant is refused before anything is written', async () => {
    const res = await fetch(`${url}/vehicles`, { method: 'POST', body: JSON.stringify({ ...car, vin: 'JH4KA8260MC000000' }),
      headers: { ...bearer({ ...ownerB }, { 'x-tenant-id': tenantA }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
    assert.equal(res.status, 404);
    assert.equal((await ownerPool.query("SELECT 1 FROM vehicles WHERE vin = 'JH4KA8260MC000000'")).rowCount, 0);
  });

  test('two copies of one car racing with one key: both get the first answer, one car', async () => {
    const key = randomUUID();
    const body = { ...car, vin: 'WVWZZZ1JZXW000001' };
    const [x, y] = await Promise.all([post('/vehicles', ownerA, body, key), post('/vehicles', ownerA, body, key)]);
    assert.deepEqual([x.status, y.status], [201, 201]);
    assert.deepEqual(await x.json(), await y.json());
  });

  test('writes are limited per caller: the 61st in a minute is a 429', async () => {
    await ownerPool.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_rate_b', 'client_staff')", [tenantB]);
    const rateB = { sub: 'user_rate_b', o: { id: 'org_b' } };
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await post('/counterparties', rateB, { kind: 'customer', name: `Buyer ${String(i)}` })).status);
    assert.deepEqual([statuses.filter((x) => x === 201).length, statuses.at(-1)], [60, 429]);
    assert.equal((await get('/vehicles', bearer(rateB))).status, 200); // reads have their own, wider limit
    assert.equal((await post('/counterparties', ownerA, { kind: 'customer', name: 'Another caller' })).status, 201);
  });

  test("another tenant's car is a 404 with no data, and lists never cross tenants", async () => {
    const mine = (await (await post('/vehicles', ownerA, { ...car, vin: '11111111111111111' })).json()) as { id: string };
    const res = await get(`/vehicles/${mine.id}`, bearer(ownerB));
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /11111111111111111/);
    assert.equal(res.status, (await get('/vehicles/00000000-0000-7000-8000-000000000000', bearer(ownerB))).status);
    const listB = (await (await get('/vehicles', bearer(ownerB))).json()) as { vin: string }[];
    assert.ok(listB.every((v) => v.vin !== '11111111111111111'));
    const cps = (await (await get('/counterparties', bearer(ownerB))).json()) as { name: string }[];
    assert.ok(cps.every((c) => !['Guangzhou Auto Export Co', 'Racer'].includes(c.name))); // none of A's
  });
});

test('Redis counters: per caller, blocked once over the limit', async () => {
  const { GenericContainer } = await import('testcontainers');
  const { Redis } = await import('ioredis');
  const { RedisThrottlerStorage } = await import('./throttle.js');
  const redis = await new GenericContainer('redis:8-alpine').withExposedPorts(6379).start();
  const client = new Redis(redis.getMappedPort(6379), redis.getHost());
  try {
    const storage = new RedisThrottlerStorage(client);
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await storage.increment('user:u1', 60_000, 2, 30_000, 'default'));
    assert.deepEqual(hits.map((h) => [h.totalHits, h.isBlocked]), [[1, false], [2, false], [3, true]]);
    assert.ok((hits[2]?.timeToBlockExpire ?? 0) > 0 && (hits[0]?.timeToExpire ?? 0) <= 60);
    assert.equal((await storage.increment('user:u2', 60_000, 2, 30_000, 'default')).isBlocked, false); // per caller
  } finally {
    client.disconnect();
    await redis.stop();
  }
});

describe('documents and job orders', () => {
  const ownerA = { sub: 'user_owner_a', o: { id: 'org_a' } };
  const ownerB = { sub: 'user_owner_b', o: { id: 'org_b' } };
  const viewerA = { sub: 'user_viewer_a', o: { id: 'org_a' } };
  const send = (method: string, path: string, claims: Record<string, unknown>, body?: unknown) =>
    fetch(`${url}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
  const PDF = Buffer.from('%PDF-1.7\n% fixture quote, accepted on WhatsApp\n%%EOF\n');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  type Ticket = { document: { id: string; status: string }; upload: { url: string; headers: Record<string, string> } };

  /** Upload as a client would: ask for a ticket, PUT the bytes to R2, confirm. */
  async function evidence(claims: Record<string, unknown>, bytes: Buffer, declared: Partial<{ sha256: string; sizeBytes: number; mime: string; docType: string }> = {}) {
    const ticket = (await (await send('POST', '/documents/uploads', claims, { docType: 'accepted_quote', mime: 'application/pdf', sizeBytes: bytes.length, sha256: sha(bytes), filename: 'quote.pdf', ...declared })).json()) as Ticket;
    const put = await fetch(ticket.upload.url, { method: 'PUT', body: new Uint8Array(bytes), headers: ticket.upload.headers });
    assert.equal(put.ok, true);
    return { id: ticket.document.id, confirm: await send('POST', `/documents/${ticket.document.id}/confirm`, claims) };
  }

  let customerA = '';
  before(async () => {
    customerA = ((await (await send('POST', '/counterparties', ownerA, { kind: 'customer', name: 'Musa Ibrahim' })).json()) as { id: string }).id;
    await ownerPool.query("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-01-08', 'CNY', '108.000000', 'cbn')"); // fixture rate
  });

  test('an upload is checked (size, SHA-256, real type) and stored; a stored file downloads, and every view is audited', async () => {
    const { id, confirm } = await evidence(ownerA, PDF);
    assert.equal(confirm.status, 200);
    const again = await send('POST', `/documents/${id}/confirm`, ownerA); // a new key, already stored: same answer
    assert.equal(again.status, 200);
    assert.equal(((await confirm.json()) as { status: string }).status, 'stored');
    const ticket = (await (await get(`/documents/${id}/download`, bearer(ownerA))).json()) as { url: string };
    const file = await fetch(ticket.url);
    assert.match(file.headers.get('content-disposition') ?? '', /^attachment; filename="[0-9a-f-]+\.pdf"$/);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
    const views = await ownerPool.query("SELECT actor FROM audit_log WHERE entity = 'documents' AND entity_id = $1 AND action = 'view'", [id]);
    assert.deepEqual(views.rows, [{ actor: 'user_owner_a' }]);
  });

  test('a file that is not what was declared is rejected for good, with the reason', async () => {
    const wrongHash = await evidence(ownerA, PDF, { sha256: 'b'.repeat(64) });
    assert.equal(wrongHash.confirm.status, 422);
    assert.match(await wrongHash.confirm.text(), /SHA-256/);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const disguised = await evidence(ownerA, png, { mime: 'application/pdf' }); // a PNG called a PDF
    assert.match(await disguised.confirm.text(), /not a application\/pdf/);
    assert.equal((await send('POST', `/documents/${disguised.id}/confirm`, ownerA)).status, 422); // final: still rejected, same answer
    assert.equal((await get(`/documents/${disguised.id}/download`, bearer(ownerA))).status, 404);
  });

  test('confirming before uploading is a 404; uploads need a recorder; another tenant gets 404', async () => {
    const ticket = (await (await send('POST', '/documents/uploads', ownerA, { docType: 'receipt', mime: 'image/png', sizeBytes: 10, sha256: 'c'.repeat(64), filename: 'r.png' })).json()) as Ticket;
    assert.equal((await send('POST', `/documents/${ticket.document.id}/confirm`, ownerA)).status, 404);
    assert.equal((await send('POST', '/documents/uploads', viewerA, { docType: 'receipt', mime: 'image/png', sizeBytes: 10, sha256: 'c'.repeat(64), filename: 'r.png' })).status, 403);
    assert.equal((await send('POST', '/documents/uploads', ownerA, { docType: 'receipt', mime: 'application/zip', sizeBytes: 10, sha256: 'c'.repeat(64), filename: 'r.zip' })).status, 400);
    const { id } = await evidence(ownerA, PDF);
    assert.equal((await get(`/documents/${id}/download`, bearer(ownerB))).status, 404);
    assert.equal((await send('POST', `/documents/${id}/confirm`, ownerB)).status, 404);
  });

  test('a job order takes a gapless number; a car purchase needs its price and quote rate', async () => {
    const first = await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '150000000' });
    assert.equal(first.status, 201);
    const a = (await first.json()) as { number: number; status: string; landingChargeNgn: string };
    assert.deepEqual([a.status, a.landingChargeNgn], ['draft', '150000000']);
    const purchase = await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', orderedOn: '2026-01-09',
      carPrice: { amountMinor: '9800000', currency: 'CNY' }, quoteRate: { rate: '108', source: 'cbn' }, landingChargeNgn: '250000000' });
    const b = (await purchase.json()) as { number: number; quoteRate: { rate: string } };
    assert.deepEqual([purchase.status, b.number, b.quoteRate.rate], [201, a.number + 1, '108.000000']);
    assert.equal((await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', orderedOn: '2026-01-09', landingChargeNgn: '0' })).status, 400);
    const wrongRate = await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', orderedOn: '2026-01-09',
      carPrice: { amountMinor: '9800000', currency: 'CNY' }, quoteRate: { rate: '110.5', source: 'cbn' }, landingChargeNgn: '0' });
    assert.equal(wrongRate.status, 422);
    assert.match(await wrongRate.text(), /marked cbn/);
    assert.equal((await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '1.5' })).status, 400); // money is whole minor units
  });

  test('the quote is accepted with stored evidence and at least one car; then the cars are fixed', async () => {
    const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '100000000' })).json()) as { id: string };
    const car = (await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000001', make: 'Land Rover', model: 'Range Rover', year: 2020 })).json()) as { id: string };
    const quote = await evidence(ownerA, PDF);
    assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: quote.id })).status, 422); // no car yet
    assert.equal((await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: car.id })).status, 400); // every car carries its own landing charge
    const added = await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: car.id, landingChargeNgn: '100000000' });
    assert.deepEqual([added.status, ((await added.json()) as { vehicles: unknown[] }).vehicles], [201, [{ vehicleId: car.id, carPriceMinor: null, landingChargeNgn: '100000000' }]]);
    const accepted = await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: quote.id });
    assert.deepEqual([accepted.status, ((await accepted.json()) as { status: string }).status], [200, 'quote_accepted']);
    const late = (await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000002', make: 'Land Rover', model: 'Range Rover', year: 2020 })).json()) as { id: string };
    const job2 = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '0' })).json()) as { id: string };
    await send('POST', `/job-orders/${job2.id}/vehicles`, ownerA, { vehicleId: late.id, landingChargeNgn: '0' });
    const reused = await send('POST', `/job-orders/${job2.id}/accept-quote`, ownerA, { documentId: quote.id });
    assert.equal(reused.status, 409); // one acceptance backs one job
    const late2 = (await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000005', make: 'Land Rover', model: 'Range Rover', year: 2020 })).json()) as { id: string };
    const tooLate = await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: late2.id, landingChargeNgn: '0' });
    assert.equal(tooLate.status, 422);
    assert.match(await tooLate.text(), /before its quote is accepted/);
  });

  test("another tenant's job, car, customer or document: the same 404 / 422 as one that doesn't exist; viewers can't see jobs", async () => {
    const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '0' })).json()) as { id: string };
    assert.equal((await get(`/job-orders/${job.id}`, bearer(ownerB))).status, 404);
    assert.equal((await send('POST', `/job-orders/${job.id}/vehicles`, ownerB, { vehicleId: randomUUID(), landingChargeNgn: '0' })).status, 404);
    const bCar = (await (await send('POST', '/vehicles', ownerB, { vin: 'SALGS2SE5LA000003', make: 'x', model: 'y', year: 2020 })).json()) as { id: string };
    assert.equal((await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: bCar.id, landingChargeNgn: '0' })).status, 422);
    const bCustomer = ((await (await send('POST', '/counterparties', ownerB, { kind: 'customer', name: 'B buyer' })).json()) as { id: string }).id;
    const viaB = await send('POST', '/job-orders', ownerA, { customerId: bCustomer, jobType: 'clearing_only', orderedOn: '2026-01-08', landingChargeNgn: '0' });
    assert.equal(viaB.status, 422);
    assert.doesNotMatch(await viaB.text(), /B buyer/);
    const listB = (await (await get('/job-orders', bearer(ownerB))).json()) as unknown[];
    assert.equal(listB.length, 0);
    const quoteA = await evidence(ownerA, PDF);
    assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerB, { documentId: quoteA.id })).status, 404); // B on A's job
    const quoteB = await evidence(ownerB, PDF);
    const carA = (await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000004', make: 'x', model: 'y', year: 2020 })).json()) as { id: string };
    await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: carA.id, landingChargeNgn: '0' });
    assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: quoteB.id })).status, 422); // A with B's document
    assert.equal((await get('/job-orders', bearer(viewerA))).status, 403);
  });

  test('a firm reviewer signs off a flag the database raised; recorders cannot; another tenant gets 404 (0014)', async () => {
    await ownerPool.query("INSERT INTO firm_staff (clerk_user_id) VALUES ('user_reviewer') ON CONFLICT DO NOTHING");
    await ownerPool.query("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_reviewer', 'firm_reviewer', 'user_admin'), ($2, 'user_reviewer', 'firm_reviewer', 'user_admin')", [tenantA, tenantB]);
    const review = (tenant: string, path: string, body: unknown, key = randomUUID()) => fetch(`${url}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { ...bearer({ sub: 'user_reviewer', fva: [1, 1] }, { 'x-tenant-id': tenant }), 'content-type': 'application/json', 'idempotency-key': key } });
    const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', funding: 'emm_funded', fundingReason: 'bought ahead of a buyer',
      orderedOn: '2026-01-09', carPrice: { amountMinor: '9800000', currency: 'CNY' }, quoteRate: { rate: '108', source: 'cbn' }, landingChargeNgn: '0' })).json()) as { id: string };
    const path = `/job-orders/${job.id}/sign-offs`;
    const car = (await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000006', make: 'Land Rover', model: 'Range Rover', year: 2020 })).json()) as { id: string };
    const unpriced = await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: car.id, landingChargeNgn: '0' });
    assert.equal(unpriced.status, 422);
    assert.match(await unpriced.text(), /each car on a car purchase needs its own quoted price/);
    await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: car.id, carPriceMinor: '9800000', landingChargeNgn: '0' });
    assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: (await evidence(ownerA, PDF)).id })).status, 200);
    const early = await review(tenantA, path, { flagId: randomUUID(), reason: 'nothing to sign yet' });
    assert.equal(early.status, 422); // nothing posted for the car yet: no flag on this job
    assert.match(await early.text(), /that flag is not on this job order/);
    // The client buys the car for naira (Dr 1200 / Cr 1000). There is no posting endpoint yet, so the owner posts it here.
    const owner = await ownerPool.connect();
    try {
      await owner.query('BEGIN');
      const account = async (code: string) => (await owner.query<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = $1 AND code = $2', [tenantA, code])).rows[0]?.id;
      const [cash, transit] = [await account('1000'), await account('1200')];
      const period = (await owner.query<{ id: string }>("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-01', '2026-01-31') RETURNING id", [tenantA])).rows[0]?.id;
      const entry = (await owner.query<{ id: string }>(
        `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, created_by)
         VALUES ($1, $2, '2026-01-10', 'car bought for naira', 'car_cost', uuidv7(), 'api-flag-1', 'user_owner_a') RETURNING id`, [tenantA, period])).rows[0]?.id;
      await owner.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, vehicle_id) VALUES ($1, $2, $3, 500000000, 0, 'NGN', 500000000, $4), ($1, $2, $5, 0, 500000000, 'NGN', 500000000, NULL)",
        [tenantA, entry, transit, car.id, cash]);
      await owner.query('COMMIT');
    } finally {
      owner.release();
    }
    // The database raised the flag as the entry committed; the job order lists it, not yet signed off.
    const raised = ((await (await get(`/job-orders/${job.id}`, bearer(ownerA))).json()) as { flags: { id: string; kind: string; vehicleId: string; signOff: unknown }[] }).flags;
    assert.deepEqual(raised.map(({ kind, vehicleId, signOff }) => ({ kind, vehicleId, signOff })), [{ kind: 'emm_funded', vehicleId: car.id, signOff: null }]);
    const approval = { flagId: raised[0]?.id, reason: 'buyer lined up; this model sells within a month' };
    assert.equal((await send('POST', path, ownerA, approval)).status, 403); // a recorder never signs off
    assert.equal((await review(tenantA, path, { ...approval, reason: '  ' })).status, 400);
    assert.equal((await review(tenantB, path, approval)).status, 404); // B's reviewer on A's job: same as no job
    const key = randomUUID();
    const first = await review(tenantA, path, approval, key);
    const approved = (await first.json()) as { flags: { kind: string; signOff: { reason: string; signedBy: string } | null }[] };
    assert.equal(first.status, 201);
    assert.deepEqual(approved.flags.map(({ kind, signOff }) => ({ kind, reason: signOff?.reason, signedBy: signOff?.signedBy })), [{ kind: 'emm_funded', reason: approval.reason, signedBy: 'user_reviewer' }]);
    const retry = await review(tenantA, path, approval, key);
    assert.deepEqual([retry.status, await retry.json()], [201, approved]); // same key: the stored answer, no second effect
    assert.equal((await review(tenantA, path, approval)).status, 409); // a new key: that flag is already signed off
    const audit = await ownerPool.query("SELECT l.actor FROM audit_log l JOIN job_order_sign_offs s ON s.id = l.entity_id WHERE l.entity = 'job_order_sign_offs' AND s.flag_id = $1", [approval.flagId]);
    assert.deepEqual(audit.rows, [{ actor: 'user_reviewer' }]);
    assert.equal((await get(`/job-orders/${job.id}`, bearer(ownerB))).status, 404);
  });

  // ── POST /postings (ADR 0017): customer money. One clearing-only job for car K, quote accepted, landing NGN 1,000,000.00.
  describe('POST /postings: customer money', () => {
    let car = '';
    const post = (claims: Record<string, unknown>, body: unknown, key: string = randomUUID()) => fetch(`${url}/postings`, {
      method: 'POST', body: JSON.stringify(body), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': key } });
    const receipt = (amountNgn: string, extra: Record<string, unknown> = {}) => ({ type: 'customer_receipt', vehicleId: car, amountNgn, entryDate: '2026-02-03', ...extra });
    before(async () => {
      const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'clearing_only', orderedOn: '2026-02-01', landingChargeNgn: '100000000' })).json()) as { id: string };
      car = ((await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000010', make: 'Toyota', model: 'Camry', year: 2019 })).json()) as { id: string }).id;
      await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: car, landingChargeNgn: '100000000' });
      assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: (await evidence(ownerA, PDF)).id })).status, 200);
    });

    test('a customer receipt posts the rule\'s lines for the job\'s own customer, opens the month, and is audited; a retry posts nothing more', async () => {
      const key = randomUUID();
      const first = await post(ownerA, receipt('50000000'), key);
      assert.equal(first.status, 201);
      const posted = (await first.json()) as { entryId: string; type: string; memo: string; lines: unknown[]; flags: unknown[] };
      assert.deepEqual([posted.type, posted.memo, posted.flags], ['customer_receipt', 'Customer receipt', []]);
      assert.deepEqual(posted.lines, [
        { account: '1000', debitNgn: '50000000', creditNgn: '0', currency: 'NGN', amountMinor: '50000000', vehicleId: null, counterpartyId: null },
        { account: '2150', debitNgn: '0', creditNgn: '50000000', currency: 'NGN', amountMinor: '50000000', vehicleId: car, counterpartyId: customerA },
      ]);
      const retry = await post(ownerA, receipt('50000000'), key);
      assert.deepEqual([retry.status, await retry.json()], [201, posted]);
      const rows = await ownerPool.query<{ source_type: string; created_by: string; starts_on: string; ends_on: string }>(
        `SELECT e.source_type, e.created_by, to_char(p.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(p.ends_on, 'YYYY-MM-DD') AS ends_on
           FROM journal_entries e JOIN periods p ON p.id = e.period_id WHERE e.tenant_id = $1 AND e.memo = 'Customer receipt'`, [tenantA]);
      assert.deepEqual(rows.rows, [{ source_type: 'customer_receipt', created_by: 'user_owner_a', starts_on: '2026-02-01', ends_on: '2026-02-28' }]);
      const audit = await ownerPool.query("SELECT actor FROM audit_log WHERE entity = 'journal_entries' AND entity_id = $1", [posted.entryId]);
      assert.deepEqual(audit.rows, [{ actor: 'user_owner_a' }]);
      // The entry's source is the posting's facts, kept for good.
      const source = await ownerPool.query<{ type: string; facts: { amountNgn: string; vehicleId: string }; created_by: string }>(
        'SELECT p.type, p.facts, p.created_by FROM postings p JOIN journal_entries e ON e.source_id = p.id WHERE e.id = $1', [posted.entryId]);
      assert.deepEqual(source.rows.map((r) => [r.type, r.facts.amountNgn, r.facts.vehicleId, r.created_by]), [['customer_receipt', '50000000', car, 'user_owner_a']]);
    });

    test('the request carries facts, never lines, types or customers; refunds and balances owed are capped by the ledger', async () => {
      for (const bad of [receipt('1.5'), receipt('-1'), { ...receipt('100'), lines: [] }, { ...receipt('100'), sourceType: 'manual_journal' }, { ...receipt('100'), counterpartyId: customerA },
        { ...receipt('100'), type: 'manual_journal' }, { ...receipt('100'), entryDate: '03/02/2026' }]) {
        assert.equal((await post(ownerA, bad)).status, 400);
      }
      assert.equal((await post(ownerA, receipt('0'))).status, 422); // the rule: a receipt is positive
      const refund = (amountNgn: string) => ({ ...receipt(amountNgn), type: 'customer_refund' });
      const tooMuch = await post(ownerA, refund('50000001'));
      assert.deepEqual([tooMuch.status, ((await tooMuch.json()) as { message: string }).message], [422, 'refund exceeds the customer funds held for this job']);
      const back = await post(ownerA, refund('1000'));
      assert.equal(back.status, 201);
      const owed = await post(ownerA, { ...receipt('1000'), type: 'receivable_receipt' });
      assert.deepEqual([owed.status, ((await owed.json()) as { message: string }).message], [422, 'receipt exceeds what this customer owes for this car']); // nothing billed yet
    });

    test("evidence attached later clears an entry from evidence pending; a shared slip is listed for review; another tenant's entry is no entry", async () => {
      const bare = (await (await post(ownerA, receipt('2000'))).json()) as { entryId: string };
      const pendingNow = async () => (await ownerPool.query('SELECT entry_id FROM entries_missing_evidence WHERE entry_id = $1', [bare.entryId])).rowCount;
      assert.equal(await pendingNow(), 1);
      const attach = (claims: Record<string, unknown>, entryId: string, documentId: string) => fetch(`${url}/postings/${entryId}/evidence`, {
        method: 'POST', body: JSON.stringify({ documentId }), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
      const slip = (await evidence(ownerA, Buffer.from('%PDF-1.7\n% fixture bank slip for the bare receipt\n%%EOF\n'), { docType: 'receipt' })).id;
      assert.equal((await attach(ownerB, bare.entryId, slip)).status, 404); // B can't reach A's entry
      const attached = await attach(ownerA, bare.entryId, slip);
      assert.equal(attached.status, 201);
      assert.deepEqual(((await attached.json()) as { attachedBy: string }).attachedBy, 'user_owner_a');
      assert.equal(await pendingNow(), 0);
      const again = await attach(ownerA, bare.entryId, (await evidence(ownerA, Buffer.from('%PDF-1.7\n% a second slip\n%%EOF\n'), { docType: 'receipt' })).id);
      assert.deepEqual([again.status, ((await again.json()) as { message: string }).message], [422, 'that entry already has its evidence, or takes none']);
      // The same slip backing a second entry posts (one transfer can pay for two things), and is listed for a firm reviewer.
      const reused = (await (await post(ownerA, receipt('3000', { evidenceDocumentId: slip }))).json()) as { entryId: string };
      const listed = await ownerPool.query<{ entry_ids: string[] }>('SELECT entry_ids FROM evidence_shared WHERE tenant_id = $1', [tenantA]);
      assert.deepEqual(listed.rows.map((r) => [...r.entry_ids].sort()), [[bare.entryId, reused.entryId].sort()]);
    });

    test('evidence is a stored document of yours; a locked month refuses; viewers can\'t post; another tenant\'s car is no car', async () => {
      // A pending upload, a document that doesn't exist and another tenant's stored document: one answer, nothing revealed.
      const pending = ((await (await send('POST', '/documents/uploads', ownerA, { docType: 'receipt', mime: 'application/pdf', sizeBytes: PDF.length, sha256: sha(PDF), filename: 'r.pdf' })).json()) as Ticket).document.id;
      const theirs = (await evidence(ownerB, PDF, { docType: 'receipt' })).id;
      for (const documentId of [pending, randomUUID(), theirs]) {
        const refused = await post(ownerA, receipt('100', { evidenceDocumentId: documentId }));
        assert.deepEqual([refused.status, await refused.json()], [422, { message: 'evidence must be a stored document: confirm the upload first', error: 'Unprocessable Entity', statusCode: 422 }]);
      }
      const stored = (await evidence(ownerA, PDF, { docType: 'receipt' })).id;
      assert.equal((await post(ownerA, receipt('100', { evidenceDocumentId: stored }))).status, 201);
      await ownerPool.query("INSERT INTO periods (tenant_id, starts_on, ends_on, status, locked_by, locked_at) VALUES ($1, '2026-03-01', '2026-03-31', 'locked', 'user_admin', now())", [tenantA]);
      const locked = await post(ownerA, receipt('100', { entryDate: '2026-03-05' }));
      assert.deepEqual([locked.status, ((await locked.json()) as { message: string }).message], [422, 'period 2026-03-01 to 2026-03-31 is locked; post the correction in an open period']);
      assert.equal((await post(viewerA, receipt('100'))).status, 403);
      // Firm staff: an accountant of this business posts; a reviewer doesn't record; staff with no access to it reach nothing.
      const staff = (sub: string) => fetch(`${url}/postings`, { method: 'POST', body: JSON.stringify(receipt('100')),
        headers: { ...bearer({ sub, fva: [1, 1] }, { 'x-tenant-id': tenantA }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
      assert.equal((await staff('user_staff')).status, 201);
      assert.equal((await staff('user_reviewer')).status, 403);
      const outsider = await fetch(`${url}/postings`, { method: 'POST', body: JSON.stringify(receipt('100')),
        headers: { ...bearer({ sub: 'user_staff', fva: [1, 1] }, { 'x-tenant-id': tenantB }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
      assert.equal(outsider.status, 404);
      // Before go-live, or in the future: refused, and no month opens.
      const early = await post(ownerA, receipt('100', { entryDate: '2025-12-31' }));
      assert.deepEqual([early.status, ((await early.json()) as { message: string }).message], [422, 'period 2025-12-01 to 2025-12-31 is before this business went live (2026-01-01): earlier history comes in with the opening balances']);
      assert.equal((await post(ownerA, receipt('100', { entryDate: '2099-01-02' }))).status, 422);
      const months = await ownerPool.query("SELECT count(*)::int AS n FROM periods WHERE tenant_id = $1 AND (starts_on < '2026-01-01' OR starts_on > '2030-01-01')", [tenantA]);
      assert.deepEqual(months.rows, [{ n: 0 }]);
      const fromB = await post(ownerB, receipt('100'));
      const text = await fromB.text();
      assert.equal(fromB.status, 422);
      assert.match(text, /that car is not on one of your job orders/);
      assert.equal((await post(ownerB, receipt('100', { vehicleId: randomUUID() }))).status, 422); // the same answer as a car that doesn't exist
      const entries = await ownerPool.query('SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1', [tenantB]);
      assert.deepEqual(entries.rows, [{ n: 0 }]);
    });
  });

  // ── POST /postings: FX (ADR 0017, 0018). Worked by hand, to the kobo, with fixture rates:
  //   buy CNY 100,000.00 at FIXTURE_RATE_BUY (100) = NGN 10,000,000.00 -> pool CNY 100,000.00 / NGN 10,000,000.00
  //   car X: CNY 40,000.00 paid from the pool at its average 100 = NGN 4,000,000.00 -> pool CNY 60,000.00 / NGN 6,000,000.00
  //   car Y: invoiced CNY 20,000.00 at FIXTURE_RATE_INVOICE (105) = NGN 2,100,000.00 owed; settled from the pool at 100 =
  //   NGN 2,000,000.00, so the payable's NGN 2,100,000.00 clears with a realized FX gain of NGN 100,000.00 (7000, on car Y).
  describe('POST /postings: FX', () => {
    const cars: Record<string, string> = {};
    let supplier = '';
    const post = (claims: Record<string, unknown>, body: unknown) => fetch(`${url}/postings`, {
      method: 'POST', body: JSON.stringify(body), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
    const date = '2026-01-10'; // within 7 days of the stored CBN fixture rate (2026-01-08, 108)
    const spot = { rate: '108', source: 'cbn' };
    /** A distinct stored slip for each foreign posting: its document is required (0017). */
    const slip = async () => (await evidence(ownerA, Buffer.from(`%PDF-1.7
% fixture slip ${randomUUID()}
%%EOF
`), { docType: 'receipt' })).id;
    const lines = async (res: Response) => {
      assert.equal(res.status, 201, await res.clone().text());
      return ((await res.json()) as { lines: { account: string; debitNgn: string; creditNgn: string; amountMinor: string }[] }).lines.map((l) => [l.account, l.debitNgn, l.creditNgn, l.amountMinor]);
    };
    before(async () => {
      supplier = ((await (await send('POST', '/counterparties', ownerA, { kind: 'supplier', name: 'Guangzhou Motors' })).json()) as { id: string }).id;
      for (const [v, vin] of [['X', 'SALGS2SE5LA000011'], ['Y', 'SALGS2SE5LA000012']] as const) {
        const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', orderedOn: '2026-01-05',
          carPrice: { amountMinor: '4500000', currency: 'CNY' }, quoteRate: { rate: '110', source: 'manual', note: 'FIXTURE_RATE_QUOTE' }, landingChargeNgn: '0' })).json()) as { id: string };
        cars[v] = ((await (await send('POST', '/vehicles', ownerA, { vin, make: 'BYD', model: 'Song Plus', year: 2024 })).json()) as { id: string }).id;
        await send('POST', `/job-orders/${job.id}/vehicles`, ownerA, { vehicleId: cars[v], carPriceMinor: '4500000', landingChargeNgn: '0' });
        assert.equal((await send('POST', `/job-orders/${job.id}/accept-quote`, ownerA, { documentId: (await evidence(ownerA, Buffer.from(`%PDF-1.7\n% quote ${v}\n%%EOF\n`))).id })).status, 200);
        assert.equal((await post(ownerA, { type: 'customer_receipt', vehicleId: cars[v], amountNgn: '600000000', entryDate: date })).status, 201);
      }
    });

    test('worked example: buy CNY, pay one car from the pool, invoice another and settle it with realized FX, to the kobo', async () => {
      assert.deepEqual(await lines(await post(ownerA, { type: 'currency_purchase', currency: 'CNY', amountMinor: '10000000', rate: { rate: '100', source: 'bdc_receipt' }, entryDate: date, evidenceDocumentId: await slip() })),
        [['1010', '1000000000', '0', '10000000'], ['1000', '0', '1000000000', '1000000000']]);
      assert.deepEqual(await lines(await post(ownerA, { type: 'pool_payment', vehicleId: cars.X, currency: 'CNY', amountMinor: '4000000', spot, entryDate: date, evidenceDocumentId: await slip() })),
        [['1150', '400000000', '0', '400000000'], ['1010', '0', '400000000', '4000000']]);
      assert.deepEqual(await lines(await post(ownerA, { type: 'supplier_invoice', vehicleId: cars.Y, supplierId: supplier, currency: 'CNY', amountMinor: '2000000', invoiceRate: '105', spot, entryDate: date, evidenceDocumentId: await slip() })),
        [['1150', '210000000', '0', '210000000'], ['2000', '0', '210000000', '2000000']]);
      const settle = async (amountMinor: string) => ({ type: 'supplier_settlement', vehicleId: cars.Y, supplierId: supplier, currency: 'CNY', amountMinor, spot, entryDate: date, evidenceDocumentId: await slip() });
      const over = await post(ownerA, await settle('2000001'));
      assert.deepEqual([over.status, ((await over.json()) as { message: string }).message], [422, 'payment exceeds what is owed to this supplier for this car']);
      assert.equal((await post(ownerA, await settle('0'))).status, 422); // the rule: an amount is positive
      assert.deepEqual(await lines(await post(ownerA, await settle('2000000'))),
        [['2000', '210000000', '0', '2000000'], ['1010', '0', '200000000', '2000000'], ['7000', '0', '10000000', '10000000']]);
      const pool = await ownerPool.query("SELECT sum(CASE WHEN l.debit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END)::text AS cny, sum(l.debit_ngn - l.credit_ngn)::text AS ngn FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.tenant_id = $1 AND a.code = '1010'", [tenantA]);
      assert.deepEqual(pool.rows, [{ cny: '4000000', ngn: '400000000' }]); // CNY 40,000.00 left at NGN 4,000,000.00
    });

    test('the pool, the payable, the spot rate and the supplier are checked against the books, not taken on trust', async () => {
      const pay = async (extra: Record<string, unknown>) => post(ownerA, { type: 'pool_payment', vehicleId: cars.X, currency: 'CNY', amountMinor: '1000', spot, entryDate: date, evidenceDocumentId: await slip(), ...extra });
      // Tenant B's own CNY never funds A's payments: A's pool is A's ledger only.
      const bSlip = (await evidence(ownerB, Buffer.from('%PDF-1.7\n% B slip\n%%EOF\n'), { docType: 'receipt' })).id;
      assert.equal((await post(ownerB, { type: 'currency_purchase', currency: 'CNY', amountMinor: '50000000', rate: { rate: '100', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: bSlip })).status, 201);
      const message = async (res: Response) => [res.status, ((await res.json()) as { message: string }).message];
      assert.deepEqual(await message(await pay({ amountMinor: '4000001' })), [422, 'payment exceeds the CNY held in the pool']);
      assert.deepEqual(await message(await pay({ currency: 'USD' })), [422, 'payment exceeds the USD held in the pool']);
      assert.deepEqual(await message(await pay({ spot: { rate: '108', source: 'manual' } })), [422, 'a manual spot rate needs a note']);
      assert.equal((await pay({ spot: { rate: '109', source: 'cbn' } })).status, 422); // not the stored CBN rate for the day
      assert.equal((await pay({ spot: { rate: '109', source: 'manual', note: 'bank quoted 109 at 10:00' } })).status, 201);
      const bSupplier = ((await (await send('POST', '/counterparties', ownerB, { kind: 'supplier', name: 'B supplier' })).json()) as { id: string }).id;
      for (const supplierId of [bSupplier, customerA, randomUUID()]) {
        const res = await post(ownerA, { type: 'supplier_invoice', vehicleId: cars.Y, supplierId, currency: 'CNY', amountMinor: '1000', invoiceRate: '105', spot, entryDate: date, evidenceDocumentId: await slip() });
        assert.deepEqual(await message(res), [422, 'the supplier must be one of your suppliers or agents']);
      }
      // A foreign posting without its document is refused at the door (and by the database behind it).
      assert.equal((await post(ownerA, { type: 'currency_purchase', currency: 'CNY', amountMinor: '1000', rate: { rate: '100', source: 'bank_receipt' }, entryDate: date })).status, 400);
      // B's own cars and entries: A's car is no car to B, for every FX type; A's document is no document to B.
      for (const body of [{ type: 'pool_payment', vehicleId: cars.X, currency: 'CNY', amountMinor: '1000', spot, entryDate: date, evidenceDocumentId: bSlip },
        { type: 'supplier_invoice', vehicleId: cars.Y, supplierId: bSupplier, currency: 'CNY', amountMinor: '1000', invoiceRate: '105', spot, entryDate: date, evidenceDocumentId: bSlip },
        { type: 'supplier_settlement', vehicleId: cars.Y, supplierId: bSupplier, currency: 'CNY', amountMinor: '1000', spot, entryDate: date, evidenceDocumentId: bSlip }]) {
        assert.deepEqual(await message(await post(ownerB, body)), [422, 'that car is not on one of your job orders']);
      }
      const bEntry = ((await ownerPool.query<{ id: string }>("SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_type = 'currency_purchase'", [tenantB])).rows[0]?.id) ?? '';
      const aDoc = await slip();
      const attachAs = (claims: Record<string, unknown>, entryId: string, documentId: string) => fetch(`${url}/postings/${entryId}/evidence`, {
        method: 'POST', body: JSON.stringify({ documentId }), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
      assert.deepEqual(await message(await attachAs(ownerB, bEntry, aDoc)), [422, 'evidence must be a stored document: confirm the upload first']);
      assert.equal((await attachAs(viewerA, randomUUID(), aDoc)).status, 403);
      assert.equal((await fetch(`${url}/postings/${randomUUID()}/evidence`, { method: 'POST', body: JSON.stringify({ documentId: aDoc }),
        headers: { ...bearer({ sub: 'user_reviewer', fva: [1, 1] }, { 'x-tenant-id': tenantA }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } })).status, 403);
      assert.equal((await post(ownerA, { type: 'currency_purchase', currency: 'CNY', amountMinor: '1000', rate: { rate: '0', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: await slip() })).status, 400);
      assert.equal((await post(ownerA, { type: 'currency_purchase', currency: 'NGN', amountMinor: '1000', rate: { rate: '1', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: await slip() })).status, 400);
      // Rounding: CNY 3.00 at 3.333333 costs 999.9999 kobo, posted as NGN 10.00; then CNY 0.01 from a pool whose average no
      // longer divides evenly. The database re-computes the pool cost to the kobo, half-up, and accepts only the same figure.
      assert.deepEqual(await lines(await post(ownerA, { type: 'currency_purchase', currency: 'CNY', amountMinor: '300', rate: { rate: '3.333333', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: await slip() })),
        [['1010', '1000', '0', '300'], ['1000', '0', '1000', '1000']]);
      // pool now CNY 39,993.00 / NGN 3,999,010.00: CNY 0.01 costs 99.99275 kobo, half-up NGN 1.00
      assert.deepEqual(await lines(await pay({ amountMinor: '1' })), [['1150', '100', '0', '100'], ['1010', '0', '100', '1']]);
    });
  });

  // ── POST /postings: supplier credit, completion, reversal (ADR 0017, 0018). Worked by hand, to the kobo, fixture rates, in USD
  //   so the CNY pool above doesn't touch it. Car P: quoted USD 3,300.00 at FIXTURE_RATE_QUOTE 1,450; landing charge NGN 500,000.00.
  //   receipt NGN 6,000,000.00 -> 2150. Buy USD 3,000.00 at FIXTURE_RATE_BUY 1,500 = NGN 4,500,000.00; pay the supplier all of it -> 1150.
  //   supplier refunds NGN 20,000.00 cash -> 1150 NGN 4,480,000.00 (flagged cost_credited).
  //   completion: selling 3,300.00 x 1,450 = NGN 4,785,000.00; car at quote 3,000.00 x 1,450 = NGN 4,350,000.00
  //     car markup 4100 = 4,785,000.00 - 4,350,000.00 = NGN 435,000.00 (credit)
  //     FX 7000 = 4,350,000.00 - 4,500,000.00 = NGN 150,000.00 loss (debit)
  //     clearing margin 4200 = 500,000.00 - (4,480,000.00 - 4,500,000.00) = NGN 520,000.00 (credit)
  //     bill 4,785,000.00 + 500,000.00 = NGN 5,285,000.00, all from funds held (2150 debit); NGN 715,000.00 stays held
  //     Dr 5,285,000.00 + 150,000.00 = Cr 4,480,000.00 + 435,000.00 + 520,000.00 = NGN 5,435,000.00
  describe('POST /postings: supplier credit, completion, reversal', () => {
    let car = '';
    let jobId = '';
    const date = '2026-02-10';
    const post = (claims: Record<string, unknown>, path: string, body: unknown, key: string = randomUUID()) => fetch(`${url}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { ...bearer(claims), 'content-type': 'application/json', 'idempotency-key': key } });
    const accountant = { sub: 'user_staff', fva: [1, 1] };
    const asAccountant = (path: string, body: unknown, tenant = tenantA) => fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { ...bearer(accountant, { 'x-tenant-id': tenant }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
    const slip = async () => (await evidence(ownerA, Buffer.from(`%PDF-1.7\n% fixture slip ${randomUUID()}\n%%EOF\n`), { docType: 'receipt' })).id;
    type Out = { entryId: string; type: string; memo: string; lines: { account: string; debitNgn: string; creditNgn: string }[]; flags: { kind: string }[] };
    const ok = async (res: Response) => {
      assert.equal(res.status, 201, await res.clone().text());
      return (await res.json()) as Out;
    };
    const status = async () => (await ownerPool.query<{ status: string }>('SELECT status FROM job_orders WHERE id = $1', [jobId])).rows[0]?.status;
    const complete = { type: 'job_completion', vehicleId: '', entryDate: date };
    before(async () => {
      const job = (await (await send('POST', '/job-orders', ownerA, { customerId: customerA, jobType: 'car_purchase', orderedOn: '2026-02-01',
        carPrice: { amountMinor: '330000', currency: 'USD' }, quoteRate: { rate: '1450', source: 'manual', note: 'FIXTURE_RATE_QUOTE' }, landingChargeNgn: '50000000' })).json()) as { id: string };
      jobId = job.id;
      car = ((await (await send('POST', '/vehicles', ownerA, { vin: 'SALGS2SE5LA000013', make: 'Toyota', model: 'Highlander', year: 2023 })).json()) as { id: string }).id;
      complete.vehicleId = car;
      await send('POST', `/job-orders/${jobId}/vehicles`, ownerA, { vehicleId: car, carPriceMinor: '330000', landingChargeNgn: '50000000' });
      assert.equal((await send('POST', `/job-orders/${jobId}/accept-quote`, ownerA, { documentId: (await evidence(ownerA, Buffer.from('%PDF-1.7\n% quote P\n%%EOF\n'))).id })).status, 200);
      await ok(await post(ownerA, '/postings', { type: 'customer_receipt', vehicleId: car, amountNgn: '600000000', entryDate: date }));
      await ok(await post(ownerA, '/postings', { type: 'currency_purchase', currency: 'USD', amountMinor: '300000', rate: { rate: '1500', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: await slip() }));
      await ok(await post(ownerA, '/postings', { type: 'pool_payment', vehicleId: car, currency: 'USD', amountMinor: '300000', spot: { rate: '1500', source: 'manual', note: 'FIXTURE spot' }, entryDate: date, evidenceDocumentId: await slip() }));
    });

    test('worked example: a supplier credit, then the completion the rule and the database both work out, to the kobo', async () => {
      const credit = (amountNgn: string) => ({ type: 'supplier_credit', vehicleId: car, amountNgn, entryDate: date });
      const tooMuch = await post(ownerA, '/postings', credit('450000001'));
      assert.deepEqual([tooMuch.status, ((await tooMuch.json()) as { message: string }).message], [422, 'credit exceeds the job costs recorded for this car']);
      assert.equal((await post(ownerA, '/postings', { ...credit('100'), supplierId: customerA })).status, 422); // a customer is no supplier
      const refunded = await ok(await post(ownerA, '/postings', credit('2000000')));
      assert.deepEqual(refunded.lines.map((l) => [l.account, l.debitNgn, l.creditNgn]), [['1000', '2000000', '0'], ['1150', '0', '2000000']]);
      assert.deepEqual(refunded.flags.map((f) => f.kind), ['cost_credited']);
      // The cut is never typed in: a completion carrying figures is refused at the door.
      assert.equal((await post(ownerA, '/postings', { ...complete, amountNgn: '1' })).status, 400);
      const done = await ok(await post(ownerA, '/postings', complete));
      assert.deepEqual([done.type, done.memo, done.flags], ['job_completion', 'Job completed', []]);
      assert.deepEqual(done.lines.map((l) => [l.account, l.debitNgn, l.creditNgn]), [
        ['2150', '528500000', '0'], ['1150', '0', '448000000'], ['4100', '0', '43500000'], ['4200', '0', '52000000'], ['7000', '15000000', '0']]);
      assert.equal(await status(), 'completed');
      assert.equal((await post(ownerA, '/postings', complete)).status, 422); // once per car
    });

    test('a reversal is the exact mirror, by firm accountants only; it undoes the completion, once; another tenant\'s entry is no entry', async () => {
      const done = (await ownerPool.query<{ id: string }>("SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_type = 'job_completion'", [tenantA])).rows[0]?.id ?? '';
      const path = `/postings/${done}/reversal`;
      assert.equal((await post(ownerA, path, { entryDate: date })).status, 403); // a correction is our call, not the client's
      assert.equal((await post(viewerA, path, { entryDate: date })).status, 403);
      assert.equal((await post({ sub: 'user_staff_a', o: { id: 'org_a' } }, path, { entryDate: date })).status, 403); // client staff record, never correct
      assert.equal((await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify({ entryDate: date }),
        headers: { ...bearer({ sub: 'user_reviewer', fva: [1, 1] }, { 'x-tenant-id': tenantA }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } })).status, 403);
      assert.equal((await asAccountant(path, { entryDate: date, lines: [] })).status, 400);
      // An accountant of tenant B only: A's entry is no entry.
      await ownerPool.query("INSERT INTO firm_staff (clerk_user_id) VALUES ('user_accountant_b')");
      await ownerPool.query("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_accountant_b', 'firm_accountant', 'user_admin')", [tenantB]);
      const fromB = await fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify({ entryDate: date }),
        headers: { ...bearer({ sub: 'user_accountant_b', fva: [1, 1] }, { 'x-tenant-id': tenantB }), 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
      assert.equal(fromB.status, 404);
      assert.deepEqual((await ownerPool.query("SELECT count(*)::int AS n FROM postings WHERE created_by = 'user_accountant_b'")).rows, [{ n: 0 }]);
      const message = async (res: Response) => [res.status, ((await res.json()) as { message: string }).message];
      const early = await message(await asAccountant(path, { entryDate: '2026-02-09' }));
      assert.equal(early[0], 422);
      assert.match(String(early[1]), /a reversal is dated on or after the entry it reverses \(10\/02\/2026\)/);
      // A document for a correction whose lines all have theirs backs nothing: refused, not kept unused.
      assert.deepEqual(await message(await asAccountant(path, { entryDate: date, evidenceDocumentId: await slip() })),
        [422, 'every foreign line of that entry already has its evidence: send no document']);
      const reversed = await ok(await asAccountant(path, { entryDate: date }));
      assert.deepEqual([reversed.type, reversed.memo], ['job_completion', 'Reversal: Job completed']);
      assert.deepEqual(reversed.lines.map((l) => [l.account, l.debitNgn, l.creditNgn]), [
        ['2150', '0', '528500000'], ['1150', '448000000', '0'], ['4100', '43500000', '0'], ['4200', '52000000', '0'], ['7000', '0', '15000000']]);
      assert.equal(await status(), 'quote_accepted');
      const again = await asAccountant(path, { entryDate: date });
      assert.deepEqual([again.status, ((await again.json()) as { message: string }).message], [409, 'that entry is already reversed']);
      assert.equal((await asAccountant(`/postings/${reversed.entryId}/reversal`, { entryDate: date })).status, 422); // a reversal isn't reversed
      // The correction's source keeps what it corrects; the job completes again, the same way.
      const source = await ownerPool.query<{ type: string; reverses: string; created_by: string }>(
        "SELECT p.type, p.facts ->> 'reverses' AS reverses, p.created_by FROM postings p JOIN journal_entries e ON e.source_id = p.id WHERE e.id = $1", [reversed.entryId]);
      assert.deepEqual(source.rows, [{ type: 'job_completion', reverses: done, created_by: 'user_staff' }]);
      const audit = await ownerPool.query("SELECT actor FROM audit_log WHERE entity = 'journal_entries' AND entity_id = $1", [reversed.entryId]);
      assert.deepEqual(audit.rows, [{ actor: 'user_staff' }]);
      assert.deepEqual((await ok(await post(ownerA, '/postings', complete))).lines.map((l) => l.creditNgn), ['0', '448000000', '43500000', '52000000', '0']);
      // Undoing the supplier's refund after the completion puts NGN 20,000.00 back on a completed car: it posts, flagged for a reviewer.
      const credit = (await ownerPool.query<{ id: string }>("SELECT id FROM journal_entries WHERE tenant_id = $1 AND source_type = 'supplier_credit'", [tenantA])).rows[0]?.id ?? '';
      assert.deepEqual((await ok(await asAccountant(`/postings/${credit}/reversal`, { entryDate: date }))).flags.map((f) => f.kind), ['cost_after_completion']);
      // A foreign entry keeps its own slip when reversed: no new document needed.
      const pay = (await ownerPool.query<{ id: string }>("SELECT e.id FROM journal_entries e WHERE e.tenant_id = $1 AND e.source_type = 'currency_purchase' AND e.memo = 'Foreign currency bought' ORDER BY e.id DESC LIMIT 1", [tenantA])).rows[0]?.id ?? '';
      const docs = async (entry: string) => (await ownerPool.query<{ d: string }>('SELECT evidence_document_id AS d FROM journal_lines WHERE entry_id = $1 ORDER BY id', [entry])).rows.map((r) => r.d);
      const buyBack = await asAccountant(`/postings/${pay}/reversal`, { entryDate: date });
      assert.equal(buyBack.status, 422, 'the USD has left the pool: reversing the purchase would overdraw it'); // the database guards the pool
      const receipt = (await ok(await post(ownerA, '/postings', { type: 'currency_purchase', currency: 'USD', amountMinor: '100', rate: { rate: '1500', source: 'bank_receipt' }, entryDate: date, evidenceDocumentId: await slip() }))).entryId;
      const undone = await ok(await asAccountant(`/postings/${receipt}/reversal`, { entryDate: date, memo: 'wrong rate on the slip' }));
      assert.deepEqual([undone.memo, await docs(undone.entryId)], ['wrong rate on the slip', await docs(receipt)]);
    });
  });
});

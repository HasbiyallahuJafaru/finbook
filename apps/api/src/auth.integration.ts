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
      assert.deepEqual(await res.json(), { tenantId: tenantA, legalName: 'Tenant A Ltd', userId: 'user_owner_a', role: 'client_owner', permissions: ['me.read', 'counterparties.read', 'counterparties.write', 'vehicles.read', 'vehicles.write'] });
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

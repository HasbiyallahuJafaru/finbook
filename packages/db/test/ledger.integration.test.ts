// Phase 1 gate (spec → Build phases): 10k random entries keep the trial balance at zero, and a
// cross-tenant read returns zero rows. Plus one test per ledger and tenancy guarantee, including every
// finding from the ledger-auditor and security-reviewer passes (ADR 0006). Needs Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { convert, RATE_SCALE } from '@app/money';
import { migrate, withTenant, type Actor, type Tx } from '../src/index.ts';

type Line = {
  account: string; debit?: bigint; credit?: bigint;
  currency?: string; amountMinor?: bigint; rate?: string; rateSource?: string; rateNote?: string;
};
type Entry = { periodId: string; date: string; lines: Line[]; key?: string; memo?: string; reverses?: string };

const API_PASSWORD = 'test-only-password'; // fixture: the throwaway container's finbook_api login
const USER = 'user_test';
let container: StartedPostgreSqlContainer;
let ownerPool: pg.Pool; // the owner (superuser): migrations and admin only, like DATABASE_OWNER_URL
let apiPool: pg.Pool; // finbook_api: what the API uses
const accounts: Record<string, Record<string, string>> = {}; // tenant -> code -> id
let tenantA = '';
let tenantB = '';
let periodA = ''; // 2026-01, open
let lockedA = ''; // 2025-12, locked
let periodB = '';
let keySeq = 0;

// Fixture rates only (CLAUDE.md: never a real-looking rate inline). 6 decimal places, as stored.
const FIXTURE_RATE_CNY = '111.111111';
const FIXTURE_RATE_USD = '999.999999';
const FIXTURE_RATE_HALF = '0.500000';
const rateString = (scaled: bigint) => `${String(scaled / RATE_SCALE)}.${String(scaled % RATE_SCALE).padStart(6, '0')}`;

const as = (tenantId: string, userId = USER): Actor => ({ tenantId, userId });
const tx = <T>(tenantId: string, fn: (t: Tx) => Promise<T>) => withTenant(apiPool, as(tenantId), fn);
const owner = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => ownerPool.query<T>(sql, params);
const one = async (c: pg.ClientBase, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';

/** Insert one entry and its lines inside an existing transaction. Returns the entry id. */
async function insertEntry(c: pg.ClientBase, tenant: string, e: Entry): Promise<string> {
  const entryId = await one(c,
    `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id)
     VALUES ($1, $2, $3, $4, 'manual_journal', uuidv7(), $5, $6) RETURNING id`,
    [tenant, e.periodId, e.date, e.memo ?? 'test entry', e.key ?? `k-${String(++keySeq)}`, e.reverses ?? null]);
  const ids = accounts[tenant] ?? {};
  for (const l of e.lines) {
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenant, entryId, ids[l.account] ?? l.account, debit, credit, l.currency ?? 'NGN', l.amountMinor ?? debit + credit,
        l.rate ?? null, l.rateSource ?? null, l.rateNote ?? null]);
  }
  return entryId;
}

const post = (tenant: string, e: Entry) => tx(tenant, (t) => insertEntry(t.client, tenant, e));
const simple = (periodId: string, amount: bigint, date = '2026-01-15'): Entry => ({
  periodId, date, lines: [{ account: '1000', debit: amount }, { account: '3000', credit: amount }],
});
const count = (tenant: string, table: string) =>
  tx(tenant, async (t) => Number((await t.client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n));
const trialBalance = (tenant: string) => tx(tenant, async (t) => {
  const r = (await t.client.query<{ dr: string | null; cr: string | null }>('SELECT sum(debit_ngn) AS dr, sum(credit_ngn) AS cr FROM journal_lines')).rows[0];
  return { dr: BigInt(r?.dr ?? 0), cr: BigInt(r?.cr ?? 0) };
});
const chainBreaks = (tenant: string) => tx(tenant, async (t) =>
  (await t.client.query<{ seq: string | null; entry_id: string; problem: string }>('SELECT * FROM ledger_chain_breaks($1)', [tenant])).rows);

/** A fresh tenant with the test chart (1010 is a CNY account) and an open January 2026 period. */
async function freshTenant(name: string): Promise<{ id: string; period: string }> {
  const id = (await owner<{ id: string }>('INSERT INTO tenants (legal_name) VALUES ($1) RETURNING id', [name])).rows[0]?.id ?? '';
  const ids: Record<string, string> = {};
  accounts[id] = ids;
  const period = await tx(id, async (t) => {
    for (const [code, type, currency] of [['1000', 'asset', null], ['1010', 'asset', 'CNY'], ['2000', 'liability', null], ['3000', 'equity', null],
      ['4000', 'income', null], ['5000', 'expense', null], ['6000', 'expense', null], ['7000', 'income', null]] as const) {
      ids[code] = await one(t.client, 'INSERT INTO accounts (tenant_id, code, name, type, currency) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [id, code, `Account ${code}`, type, currency]);
    }
    return one(t.client, "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-01', '2026-01-31') RETURNING id", [id]);
  });
  return { id, period };
}

/** Run SQL as the owner with triggers and FKs disabled: an attacker with superuser rights. */
async function tamper(...statements: [string, unknown[]][]): Promise<void> {
  const c = await ownerPool.connect();
  try {
    await c.query("SET session_replication_role = 'replica'");
    for (const [sql, params] of statements) await c.query(sql, params);
  } finally {
    await c.query("SET session_replication_role = 'origin'");
    c.release();
  }
}

before(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  ownerPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  await migrate(ownerPool, API_PASSWORD);
  apiPool = new pg.Pool({
    host: container.getHost(), port: container.getPort(), database: container.getDatabase(),
    user: 'finbook_api', password: API_PASSWORD, max: 4,
  });
  ({ id: tenantA, period: periodA } = await freshTenant('Tenant A'));
  ({ id: tenantB, period: periodB } = await freshTenant('Tenant B'));
  lockedA = await tx(tenantA, (t) => one(t.client, "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2025-12-01', '2025-12-31') RETURNING id", [tenantA]));
  await tx(tenantA, (t) => t.client.query("UPDATE periods SET status = 'locked', locked_by = 'test', locked_at = now() WHERE id = $1", [lockedA]));
});

after(async () => {
  await apiPool.end();
  await ownerPool.end();
  await container.stop();
});

describe('posting', () => {
  test('a balanced entry posts and gets the next hash in the chain', async () => {
    const id = await post(tenantA, simple(periodA, 1_000_00n));
    const h = await tx(tenantA, async (t) =>
      (await t.client.query<{ hash: string; payload_version: number }>('SELECT hash, payload_version FROM journal_entry_hashes WHERE entry_id = $1', [id])).rows[0]);
    assert.match(h?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.equal(h?.payload_version, 2);
    assert.deepEqual(await chainBreaks(tenantA), []);
  });

  test('an unbalanced entry is refused at commit and nothing is kept', async () => {
    const before = await count(tenantA, 'journal_entries');
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 100n }, { account: '3000', credit: 99n }] }),
      /does not balance: debits 100 kobo, credits 99 kobo/);
    assert.equal(await count(tenantA, 'journal_entries'), before);
  });

  test('an entry needs at least two lines and a memo', async () => {
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [] }), /has 0 line\(s\)/);
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 1n }] }), /has 1 line\(s\)/);
    await assert.rejects(post(tenantA, { ...simple(periodA, 1n), memo: '   ' }), /journal_entries_memo/);
  });

  test('a line is a debit or a credit, never both or neither', async () => {
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 5n, credit: 5n }, { account: '3000', credit: 5n }] }),
      /journal_lines_one_side/);
  });

  test('a retried request with the same idempotency key cannot post twice', async () => {
    await post(tenantA, { ...simple(periodA, 500n), key: 'retry-1' });
    await assert.rejects(post(tenantA, { ...simple(periodA, 500n), key: 'retry-1' }), /journal_entries_idempotency/);
  });

  test('lines cannot be added to an entry once it is posted', async () => {
    const id = await post(tenantA, simple(periodA, 700n));
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      'INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, amount_minor) VALUES ($1, $2, $3, 1, 1)',
      [tenantA, id, accounts[tenantA]?.['1000']])), /already posted; lines cannot be added/);
  });

  test('the commit-time check catches a line added after hashing, even with the insert-time check out of the way', async () => {
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_entry_open'); // simulate the race window
      const id = await insertEntry(c, tenantA, simple(periodA, 800n));
      await c.query('SET CONSTRAINTS journal_entries_post IMMEDIATE'); // hash it now
      await c.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, amount_minor) VALUES ($1, $2, $3, 1, 1)", [tenantA, id, accounts[tenantA]?.['1000']]);
      await c.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, credit_ngn, amount_minor) VALUES ($1, $2, $3, 1, 1)", [tenantA, id, accounts[tenantA]?.['3000']]);
      await assert.rejects(c.query('COMMIT'), /added to journal entry .* after it was posted/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  test('the database stamps who and when; the app cannot supply them, or ids', async () => {
    const id = await post(tenantA, simple(periodA, 900n));
    const row = await tx(tenantA, async (t) =>
      (await t.client.query<{ created_by: string; recent: boolean }>("SELECT created_by, created_at > now() - interval '1 minute' AS recent FROM journal_entries WHERE id = $1", [id])).rows[0]);
    assert.deepEqual({ ...row }, { created_by: USER, recent: true });
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      "INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, created_by) VALUES ($1, $2, '2026-01-15', 'x', 'm', uuidv7(), 'forged', 'someone else')",
      [tenantA, periodA])), /permission denied/);
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      "INSERT INTO journal_entries (id, tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key) VALUES (uuidv7(), $1, $2, '2026-01-15', 'x', 'm', uuidv7(), 'own-id')",
      [tenantA, periodA])), /permission denied/);
    await assert.rejects(withTenant(apiPool, as(tenantA, ' '), (t) => insertEntry(t.client, tenantA, simple(periodA, 1n))), /app.user_id is not set/);
  });
});

describe('reversals', () => {
  test('a reversal must mirror a posted entry exactly, once', async () => {
    const original = await post(tenantA, simple(periodA, 50_000_000_00n));
    await assert.rejects(post(tenantA, { ...simple(periodA, 10_00n), reverses: original }), /does not mirror/);
    const mirror: Entry = { periodId: periodA, date: '2026-01-16', reverses: original,
      lines: [{ account: '1000', credit: 50_000_000_00n }, { account: '3000', debit: 50_000_000_00n }] };
    await post(tenantA, mirror);
    await assert.rejects(post(tenantA, mirror), /journal_entries_reversed_once/);
  });
});

describe('periods', () => {
  test('a locked period refuses new entries', async () => {
    await assert.rejects(post(tenantA, simple(lockedA, 100n, '2025-12-10')), /is locked/);
  });

  test('an entry dated outside its period is refused', async () => {
    await assert.rejects(post(tenantA, simple(periodA, 100n, '2026-02-01')), /outside its period/);
  });

  test('periods cannot overlap; a locked period cannot be reopened, changed or deleted', async () => {
    await assert.rejects(tx(tenantA, (t) =>
      t.client.query("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-20', '2026-02-20')", [tenantA])), /periods_no_overlap/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE periods SET status = 'open' WHERE id = $1", [lockedA])), /locked period .* cannot change/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE periods SET ends_on = '2026-01-30' WHERE id = $1", [periodA])), /permission denied/);
    await assert.rejects(owner("UPDATE periods SET ends_on = '2026-01-30' WHERE id = $1", [periodA]), /tenant and dates cannot change/);
    await assert.rejects(owner('DELETE FROM periods WHERE id = $1', [lockedA]), /append-only/);
  });
});

describe('accounts', () => {
  test('the app can rename an account but never change its code, type or currency', async () => {
    const id = accounts[tenantA]?.['2000'] ?? '';
    await tx(tenantA, (t) => t.client.query("UPDATE accounts SET name = 'Trade payables' WHERE id = $1", [id]));
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE accounts SET type = 'income' WHERE id = $1", [id])), /permission denied/);
  });

  test('even the owner cannot reclassify an account that has posted lines', async () => {
    await assert.rejects(owner("UPDATE accounts SET type = 'income', code = '4999' WHERE id = $1", [accounts[tenantA]?.['3000']]), /has posted lines/);
  });

  test('every account and period change leaves an audit row stamped with the actor', async () => {
    const rows = await tx(tenantA, async (t) => (await t.client.query<{ action: string; entity: string; actor: string; before: { name: string } | null }>(
      'SELECT action, entity, actor, before FROM audit_log WHERE entity_id = $1 ORDER BY at, id', [accounts[tenantA]?.['2000']])).rows);
    assert.deepEqual(rows.map((r) => [r.action, r.entity, r.actor]), [['insert', 'accounts', USER], ['update', 'accounts', USER]]);
    assert.equal(rows[1]?.before?.name, 'Account 2000');
    assert.ok((await tx(tenantA, async (t) => (await t.client.query("SELECT 1 FROM audit_log WHERE entity = 'periods' AND action = 'update'")).rowCount ?? 0)) > 0);
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      "INSERT INTO audit_log (tenant_id, actor, action, entity) VALUES ($1, 'forged', 'x', 'x')", [tenantA])), /permission denied/);
  });
});

describe('immutability', () => {
  test('the app role has no UPDATE or DELETE on posted rows', async () => {
    for (const sql of ['UPDATE journal_lines SET debit_ngn = debit_ngn', 'DELETE FROM journal_entries', 'UPDATE audit_log SET entity = entity', 'DELETE FROM journal_entry_hashes']) {
      await assert.rejects(tx(tenantA, (t) => t.client.query(sql)), /permission denied/, sql);
    }
  });

  test('even the owner cannot update, delete or truncate posted rows or the audit log', async () => {
    for (const table of ['journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log']) {
      await assert.rejects(owner(`DELETE FROM ${table}`), /append-only/, table);
      await assert.rejects(owner(`TRUNCATE ${table} CASCADE`), /append-only/, table);
    }
    await assert.rejects(owner('UPDATE journal_lines SET debit_ngn = debit_ngn'), /append-only/);
    await assert.rejects(owner('UPDATE audit_log SET entity = entity'), /append-only/);
  });
});

describe('hash chain detects tampering that bypasses every trigger', () => {
  const threeEntries = async () => {
    const { id, period } = await freshTenant(`Tamper ${String(++keySeq)}`);
    const e = [await post(id, simple(period, 100n)), await post(id, simple(period, 50_000_000_00n)), await post(id, simple(period, 300n))];
    assert.deepEqual(await chainBreaks(id), []);
    return { id, e };
  };

  test('a changed line', async () => {
    const { id, e } = await threeEntries();
    await tamper(['UPDATE journal_lines SET debit_ngn = 999, amount_minor = 999 WHERE entry_id = $1 AND debit_ngn > 0', [e[1]]]);
    assert.deepEqual((await chainBreaks(id)).map((b) => [b.entry_id, b.problem]), [[e[1], 'content changed']]);
  });

  test('a deleted entry whose hash row is kept', async () => {
    const { id, e } = await threeEntries();
    await tamper(['DELETE FROM journal_lines WHERE entry_id = $1', [e[1]]], ['DELETE FROM journal_entries WHERE id = $1', [e[1]]]);
    assert.deepEqual((await chainBreaks(id)).map((b) => [b.entry_id, b.problem]), [[e[1], 'entry missing']]);
  });

  test('a deleted hash row and a rewritten prev_hash', async () => {
    const { id, e } = await threeEntries();
    await tamper(['DELETE FROM journal_entry_hashes WHERE entry_id = $1', [e[1]]]);
    await tamper(["UPDATE journal_entry_hashes SET prev_hash = repeat('0', 64) WHERE entry_id = $1", [e[2]]]);
    assert.deepEqual((await chainBreaks(id)).map((b) => b.problem).sort(), ['entry without hash', 'missing predecessor']);
  });
});

describe('foreign currency lines', () => {
  const fx = (amountMinor: bigint, rate: string, ngn: bigint, extra: Partial<Line> = {}): Entry => ({
    periodId: periodA, date: '2026-01-20',
    lines: [{ account: '1010', debit: ngn, currency: 'CNY', amountMinor, rate, rateSource: 'bank_receipt', ...extra }, { account: '1000', credit: ngn }],
  });
  const usd = (extra: Partial<Line>) => fx(100n, FIXTURE_RATE_USD, 1_00_000n, { currency: 'USD', account: '1000', ...extra });

  test('worked example: an exact tie rounds half-up (CNY 0.05 x 0.500000 = NGN 0.025, posted as 3 kobo, not 2)', async () => {
    await post(tenantA, fx(5n, FIXTURE_RATE_HALF, 3n));
    await assert.rejects(post(tenantA, fx(5n, FIXTURE_RATE_HALF, 2n)), /journal_lines_fx/);
    assert.equal(convert(5n, 500_000n), 3n, 'packages/money agrees with the database');
  });

  test('worked example: CNY 1,234.56 x 111.111111 = NGN 137,173.33 (13,717,333.32 kobo rounds to 13,717,333)', async () => {
    await post(tenantA, fx(1_234_56n, FIXTURE_RATE_CNY, 13_717_333n));
    await assert.rejects(post(tenantA, fx(1_234_56n, FIXTURE_RATE_CNY, 13_717_334n)), /journal_lines_fx/);
  });

  test('a foreign line needs a rate and a rate source; a manual rate needs a real note', async () => {
    // USD 1.00 x 999.999999 = NGN 999.999999 -> 100,000 kobo (NGN 1,000.00)
    await assert.rejects(post(tenantA, usd({ rateSource: undefined })), /journal_lines_fx/);
    await assert.rejects(post(tenantA, usd({ rate: undefined })), /journal_lines_fx/);
    await assert.rejects(post(tenantA, usd({ rateSource: 'manual', rateNote: '  ' })), /journal_lines_fx/);
    await post(tenantA, usd({ rateSource: 'manual', rateNote: 'cash deal, no receipt' }));
  });

  test('currencies must be known, and a line must match its account currency', async () => {
    await assert.rejects(post(tenantA, usd({ currency: 'ZZZ' })), /journal_lines_currency/);
    await assert.rejects(post(tenantA, usd({ account: '1010' })), /a USD line cannot post to a CNY account/);
  });
});

describe('tenant isolation', () => {
  test('a cross-tenant read returns zero rows from every table', async () => {
    await post(tenantB, simple(periodB, 42n));
    for (const table of ['journal_entries', 'journal_lines', 'accounts', 'periods', 'journal_entry_hashes', 'audit_log']) {
      assert.equal(await tx(tenantA, async (t) => (await t.client.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantB])).rowCount), 0, table);
      assert.ok((await count(tenantB, table)) > 0, table);
    }
    assert.equal(await tx(tenantA, async (t) => (await t.client.query('SELECT 1 FROM tenants WHERE id = $1', [tenantB])).rowCount), 0);
  });

  test('no tenant (empty) means no rows at all', async () => {
    for (const table of ['tenants', 'accounts', 'periods', 'journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log']) {
      assert.equal(await withTenant(apiPool, as(''), async (t) => (await t.client.query(`SELECT 1 FROM ${table}`)).rowCount), 0, table);
    }
  });

  test('writes for or into another tenant are refused or touch nothing', async () => {
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      "INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '9999', 'x', 'asset')", [tenantB])), /row-level security/);
    assert.equal(await tx(tenantA, async (t) => (await t.client.query("UPDATE accounts SET name = 'pwned' WHERE tenant_id = $1", [tenantB])).rowCount), 0);
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15',
      lines: [{ account: accounts[tenantB]?.['1000'] ?? '', debit: 1n }, { account: '3000', credit: 1n }] }), /journal_lines_account/);
  });

  test("another tenant's ids give the same answer as random ids (no existence oracle)", async () => {
    const msg = (period: string) => post(tenantA, simple(period, 1n)).then(() => 'posted', (e: unknown) => String(e).replace(period, '<id>'));
    assert.equal(await msg(periodB), await msg('00000000-0000-7000-8000-000000000000'));
    await assert.rejects(tx(tenantA, (t) => t.client.query('SELECT * FROM ledger_chain_breaks($1)', [tenantB])), /not the current tenant/);
  });

  test('the API login has no rights of its own, and no escape reaches a superuser', async () => {
    await assert.rejects(apiPool.query('SELECT 1 FROM journal_lines'), /permission denied/);
    for (const escape of ['RESET ROLE', "SELECT set_config('role', 'none', true)", 'SET LOCAL ROLE postgres', "SET LOCAL session_replication_role = 'replica'"]) {
      const seen = await tx(tenantA, async (t) => {
        await t.client.query('SAVEPOINT s');
        try {
          await t.client.query(escape);
          return (await t.client.query('SELECT 1 FROM journal_lines WHERE tenant_id = $1', [tenantB])).rowCount;
        } catch {
          await t.client.query('ROLLBACK TO SAVEPOINT s');
          return 0;
        }
      });
      assert.equal(seen, 0, escape);
    }
    await assert.rejects(tx(tenantA, (t) => t.db.transaction(() => Promise.resolve())), /nested transactions are not allowed/);
  });

  test('a swallowed error cannot make a rolled-back transaction look committed', async () => {
    const before = await count(tenantA, 'journal_entries');
    await assert.rejects(tx(tenantA, async (t) => {
      await insertEntry(t.client, tenantA, simple(periodA, 5_000_000_00n));
      await t.client.query('SELECT 1/0').catch(() => undefined); // a handler that swallows an error
    }), /rolled back/);
    assert.equal(await count(tenantA, 'journal_entries'), before);
  });
});

describe('phase 1 gate', () => {
  test('10k random entries: trial balance nets to zero, chain intact, invalid entries all refused', { timeout: 900_000 }, async () => {
    let seed = 20260115n;
    const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed >> 11n) % max);
    const ngnCodes = ['1000', '2000', '3000', '4000', '5000', '6000', '7000'];
    const pick = () => ngnCodes[Number(rnd(BigInt(ngnCodes.length)))] ?? '1000';

    // Random balanced entry: 1-3 lines on one side (NGN, or CNY into the CNY account 1010), the same total
    // split over 1-3 NGN lines on the other side. Half the time the sides are swapped.
    const randomEntry = (): Entry => {
      const side: Line[] = [];
      for (let i = 0, n = Number(rnd(3n)) + 1; i < n; i++) {
        if (rnd(4n) === 0n) {
          const amountMinor = rnd(10n ** 9n) + 10_000n;
          const rateScaled = rnd(2_000n * RATE_SCALE) + RATE_SCALE / 100n; // fixture range (0.01-2000) for property testing, not real rates
          side.push({ account: '1010', debit: convert(amountMinor, rateScaled), currency: 'CNY', amountMinor, rate: rateString(rateScaled), rateSource: 'bank_receipt' });
        } else {
          side.push({ account: pick(), debit: rnd(10n ** 11n) + 100n });
        }
      }
      const total = side.reduce((s, l) => s + (l.debit ?? 0n), 0n);
      const parts = Number(rnd(3n)) + 1;
      const other: Line[] = [];
      let left = total;
      for (let i = 0; i < parts - 1; i++) {
        const share = rnd(left - BigInt(parts - i - 1)) + 1n; // leaves at least 1 kobo for each remaining line
        other.push({ account: pick(), credit: share });
        left -= share;
      }
      other.push({ account: pick(), credit: left });
      const flip = (l: Line): Line => ({ ...l, debit: l.credit ?? 0n, credit: l.debit ?? 0n });
      const lines = rnd(2n) === 0n ? [...side, ...other] : [...side.map(flip), ...other.map(flip)];
      return { periodId: periodA, date: `2026-01-${String(Number(rnd(31n)) + 1).padStart(2, '0')}`, lines };
    };

    const entriesBefore = await count(tenantA, 'journal_entries');
    const tbBefore = await trialBalance(tenantA);
    const N = 10_000;
    const BATCH = 250;
    for (let done = 0; done < N; done += BATCH) {
      await tx(tenantA, async (t) => {
        for (let i = 0; i < BATCH; i++) await insertEntry(t.client, tenantA, randomEntry());
      });
    }
    // Invalid entries, each in its own transaction: off by one kobo. All must be refused for not balancing.
    for (let i = 0; i < 100; i++) {
      const e = randomEntry();
      const last = e.lines[e.lines.length - 1];
      if (last?.debit) last.debit += 1n; else if (last?.credit) last.credit += 1n;
      if (last && !last.rate) last.amountMinor = (last.debit ?? 0n) + (last.credit ?? 0n);
      await assert.rejects(post(tenantA, e), /does not balance/);
    }

    assert.equal(await count(tenantA, 'journal_entries'), entriesBefore + N);
    assert.equal(await count(tenantA, 'journal_entry_hashes'), entriesBefore + N);
    const tb = await trialBalance(tenantA);
    assert.equal(tb.dr - tb.cr, 0n, 'trial balance nets to zero');
    assert.ok(tb.dr > tbBefore.dr);
    assert.deepEqual(await chainBreaks(tenantA), []);
    assert.equal(await tx(tenantB, async (t) => (await t.client.query('SELECT 1 FROM journal_entries WHERE tenant_id = $1', [tenantA])).rowCount), 0,
      'cross-tenant read returns zero rows');
  });
});

// Phase 1 gate (spec → Build phases): 10k random entries keep the trial balance at zero, and a
// cross-tenant read returns zero rows. Plus one test per ledger and tenancy guarantee, including every
// finding from the ledger-auditor and security-reviewer passes (ADR 0006). Needs Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { convert, parseRate, RATE_SCALE } from '@app/money';
import { buyCurrency, completeAgentJob, customerReceipt, payFromPool, payPayableFromPool, sharedCost, supplierInvoice, type Line as LedgerLine } from '@app/ledger';
import { migrate, withTenant, type Actor, type Tx } from '../src/index.ts';

type Line = {
  account: string; debit?: bigint; credit?: bigint;
  currency?: string; amountMinor?: bigint; rate?: string; rateSource?: string; rateNote?: string;
};
type Entry = { periodId: string; date: string; lines: Line[]; key?: string; memo?: string; reverses?: string };

const API_PASSWORD = 'test-only-password'; // fixture: the throwaway container's finbook_api login
const RATES_PASSWORD = 'test-only-rates'; // fixture: the throwaway container's finbook_rates login
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
const FIXTURE_RATE_SPOT = '108.000000'; // spot (CBN reference) rate stored for 2026-01-08 in the test database
const FIXTURE_RATE_INVOICE = parseRate('105.000000');
const SPOT_CBN = { rate: parseRate(FIXTURE_RATE_SPOT), source: 'cbn' as const };
const SUPPLIER = '019a0000-0000-7000-8000-0000000000f1';
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
      ['4000', 'income', null], ['5000', 'expense', null], ['6000', 'expense', null], ['7000', 'income', null],
      ['1100', 'asset', null], ['1150', 'asset', null], ['2150', 'liability', null], ['4100', 'income', null], ['4200', 'income', null]] as const) {
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
  await migrate(ownerPool, { api: API_PASSWORD, rates: RATES_PASSWORD });
  apiPool = new pg.Pool({
    host: container.getHost(), port: container.getPort(), database: container.getDatabase(),
    user: 'finbook_api', password: API_PASSWORD, max: 4,
  });
  await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-01-08', 'CNY', $1, 'cbn')", [FIXTURE_RATE_SPOT]);
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
    assert.equal(h?.payload_version, 3);
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

describe('phase 2: posting rules through the database', () => {
  const car: Record<string, string> = { A: '019a0000-0000-7000-8000-00000000000a', B: '019a0000-0000-7000-8000-00000000000b', C: '019a0000-0000-7000-8000-00000000000c' };
  const customer = (v: string) => `019a0000-0000-7000-8000-0000000000c${v.toLowerCase()}`;
  const job = (v: string) => ({ vehicleId: v, counterpartyId: v });

  /** Persist one posting-rule result as one journal entry (what the API will do). */
  const postLines = (tenant: string, period: string, lines: LedgerLine[], opts: { date?: string; reverses?: string } = {}) => tx(tenant, async (t) => {
    const ids = accounts[tenant] ?? {};
    const entryId = await one(t.client,
      'INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id) VALUES ($1, $2, $3, \'posting rule\', \'test\', uuidv7(), $4, $5) RETURNING id',
      [tenant, period, opts.date ?? '2026-01-10', `pr-${String(++keySeq)}`, opts.reverses ?? null]);
    for (const l of lines) {
      await t.client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, rate_note, vehicle_id, counterparty_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [tenant, entryId, ids[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, l.rateNote ?? null,
          l.vehicleId ? car[l.vehicleId] : null, l.counterpartyId ? (l.counterpartyId.length === 36 ? l.counterpartyId : customer(l.counterpartyId)) : null]);
    }
    return entryId;
  });
  /** The pool is derived from the ledger, never stored (ADR 0008): the CNY lines on account 1010. */
  const poolOf = (tenant: string) => tx(tenant, async (t) => {
    const r = (await t.client.query<{ bal: string; cost: string }>(
      "SELECT coalesce(sum(CASE WHEN debit_ngn > 0 THEN amount_minor ELSE -amount_minor END), 0)::text AS bal, coalesce(sum(debit_ngn - credit_ngn), 0)::text AS cost FROM journal_lines WHERE account_id = $1 AND currency = 'CNY'",
      [accounts[tenant]?.['1010']])).rows[0];
    return { balanceMinor: BigInt(r?.bal ?? 0), costNgn: BigInt(r?.cost ?? 0) };
  });
  const funded = async (name: string) => {
    const t = await freshTenant(name);
    await postLines(t.id, t.period, buyCurrency({ currency: 'CNY', amountMinor: 10_000_000n, rate: parseRate('100.000000'), rateSource: 'bdc_receipt' })); // FIXTURE_RATE_BUY_1
    await postLines(t.id, t.period, buyCurrency({ currency: 'CNY', amountMinor: 5_000_000n, rate: parseRate('120.000000'), rateSource: 'bdc_receipt' })); // FIXTURE_RATE_BUY_2
    return t;
  };

  test('the worked example posts cleanly and the balances match the hand-worked figures', async () => {
    const { id, period } = await funded('Worked example');
    for (const [v, amountNgn] of [['A', 600_000_000n], ['B', 500_000_000n], ['C', 650_000_000n]] as const) await postLines(id, period, customerReceipt({ ...job(v), amountNgn }));
    for (const [v, amountMinor] of [['A', 4_000_000n], ['B', 3_500_000n], ['C', 4_500_000n]] as const) {
      await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor, vehicleId: v, spot: SPOT_CBN }).lines);
    }
    await postLines(id, period, sharedCost({ amountNgn: 249_999_999n, vehicleIds: ['A', 'B', 'C'] }));
    await postLines(id, period, sharedCost({ amountNgn: 100_000_000n, vehicleIds: ['A', 'B', 'C'] }));
    await postLines(id, period, sharedCost({ amountNgn: 15_000_000n, vehicleIds: ['A'] }));
    // Completion reads car A's history back from the database, nothing is typed in.
    const history = await tx(id, async (t) => (await t.client.query<{ code: string; debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; vehicle_id: string | null }>(
      'SELECT a.code, l.debit_ngn, l.credit_ngn, l.currency, l.amount_minor, l.vehicle_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id = $1', [car.A])).rows
      .map((r): LedgerLine => ({ account: r.code, debit: BigInt(r.debit_ngn), credit: BigInt(r.credit_ngn), currency: r.currency.trim(), amountMinor: BigInt(r.amount_minor), vehicleId: 'A' })));
    await postLines(id, period, completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_500_000n, rate: parseRate('110.000000'), landingChargeNgn: 150_000_000n }, history }).lines); // FIXTURE_RATE_QUOTE

    const rows = await tx(id, async (t) => (await t.client.query<{ code: string; net: string }>(
      'SELECT a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id GROUP BY a.code ORDER BY a.code')).rows);
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.code, BigInt(r.net)])), {
      '1000': -214_999_999n, '1010': 320_000_000n, '1100': 45_000_000n, '1150': 1_086_666_665n,
      '2150': -1_150_000_000n, '4100': -55_000_000n, '4200': -18_333_333n, '7000': -13_333_333n,
    });
    assert.deepEqual(await poolOf(id), { balanceMinor: 3_000_000n, costNgn: 320_000_000n }, 'CNY 30,000.00 left at NGN 3,200,000.00');
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('a pool_average line must be a credit at the exact pool cost, within the pool balance', async () => {
    const { id, period } = await funded('Pool guard');
    const pool = await poolOf(id); // CNY 150,000.00 / NGN 16,000,000.00
    const good = payFromPool({ pool, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    const forged = (credit: bigint, amountMinor: bigint, rate: string): LedgerLine[] => [
      { account: '6000', debit: credit, credit: 0n, currency: 'NGN', amountMinor: credit },
      { account: '1010', debit: 0n, credit, currency: 'CNY', amountMinor, rate, rateSource: 'pool_average', spotRate: FIXTURE_RATE_SPOT, spotSource: 'cbn' },
    ];
    // Drain the pool NGN with one fen: rate 1600000000.000000 passes the self-check, but not the pool check.
    await assert.rejects(postLines(id, period, forged(1_600_000_000n, 1n, '1600000000.000000')), /weighted-average cost: expected 107 kobo/);
    // Cheap currency into the pool: pool_average is only ever a credit.
    await assert.rejects(postLines(id, period, [
      { account: '1010', debit: 50n, credit: 0n, currency: 'CNY', amountMinor: 100_000_000n, rate: '0.000001', rateSource: 'pool_average', spotRate: FIXTURE_RATE_SPOT, spotSource: 'cbn' },
      { account: '1000', debit: 0n, credit: 50n, currency: 'NGN', amountMinor: 50n },
    ]), /must be a credit/);
    await assert.rejects(postLines(id, period, forged(1n, 15_000_001n, '0.000000')), /pool overspent/);
    await postLines(id, period, good);
    assert.deepEqual(await poolOf(id), { balanceMinor: 11_000_000n, costNgn: 1_173_333_333n });
  });

  test('a pool payment can be reversed exactly (pool restored), but only as a true mirror', async () => {
    const { id, period } = await funded('Pool reversal');
    const paid = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    await postLines(id, period, paid);
    const original = await tx(id, async (t) => (await t.client.query<{ id: string }>('SELECT entry_id AS id FROM journal_lines WHERE vehicle_id = $1 LIMIT 1', [car.A])).rows[0]?.id ?? '');
    const mirror = (vehicleId: string): LedgerLine[] => paid.map((l) => ({ ...l, debit: l.credit, credit: l.debit, vehicleId }));
    const reverse = (lines: LedgerLine[]) => tx(id, async (t) => {
      const entryId = await one(t.client, "INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id) VALUES ($1, $2, '2026-01-11', 'reversal', 'test', uuidv7(), $3, $4) RETURNING id",
        [id, period, `rev-${String(++keySeq)}`, original]);
      for (const l of lines) {
        await t.client.query('INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
          [id, entryId, accounts[id]?.[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, l.vehicleId ? car[l.vehicleId] : null]);
      }
    });
    await assert.rejects(reverse(mirror('B')), /does not mirror/);
    await reverse(mirror('A'));
    assert.deepEqual(await poolOf(id), { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, 'pool back to CNY 150,000.00 / NGN 16,000,000.00');
  });

  test('a pool payment without the day spot rate is refused', async () => {
    const { id, period } = await funded('Spot required');
    const lines = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    await assert.rejects(postLines(id, period, lines.map((l) => ({ ...l, spotRate: undefined, spotSource: undefined }))), /needs the day's spot rate/);
    await postLines(id, period, lines);
  });

  /** What's owed to one supplier in CNY, from the ledger (like the pool): foreign amount and booked NGN on account 2000. */
  const payableOf = (tenant: string) => tx(tenant, async (t) => {
    const r = (await t.client.query<{ bal: string; cost: string }>(
      "SELECT coalesce(sum(CASE WHEN credit_ngn > 0 THEN amount_minor ELSE -amount_minor END), 0)::text AS bal, coalesce(sum(credit_ngn - debit_ngn), 0)::text AS cost FROM journal_lines WHERE account_id = $1 AND currency = 'CNY' AND counterparty_id = $2 AND vehicle_id = $3",
      [accounts[tenant]?.['2000'], SUPPLIER, car.A])).rows[0];
    return { balanceMinor: BigInt(r?.bal ?? 0), costNgn: BigInt(r?.cost ?? 0) };
  });
  const bill = { vehicleId: 'A', supplierId: SUPPLIER };

  test('realized FX: a supplier invoice at 105 settled from a pool averaging 106.666667 books a NGN 33,333.33 loss', async () => {
    const { id, period } = await funded('Realized FX'); // pool CNY 150,000.00 / NGN 16,000,000.00 (average 106.666667)
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    assert.deepEqual(await payableOf(id), { balanceMinor: 2_000_000n, costNgn: 210_000_000n });
    // CNY 20,000.00 costs 16,000,000.00 x 20/150 = NGN 2,133,333.33 from the pool; the payable was booked at 2,100,000.00 -> loss 33,333.33.
    const paid = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN });
    await postLines(id, period, paid.lines);
    const net = await tx(id, async (t) => Object.fromEntries((await t.client.query<{ code: string; net: string }>(
      'SELECT a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id GROUP BY a.code')).rows.map((r) => [r.code, BigInt(r.net)])));
    assert.equal(net['2000'], 0n, 'payable settled');
    assert.equal(net['7000'], 3_333_333n, 'realized FX loss NGN 33,333.33');
    assert.equal(net['1150'], 210_000_000n, 'the car carries the invoice-rate cost');
    assert.deepEqual(await poolOf(id), { balanceMinor: 13_000_000n, costNgn: 1_386_666_667n });
    assert.deepEqual(await payableOf(id), { balanceMinor: 0n, costNgn: 0n });
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('a payable settlement must clear exactly its booked cost and never more than is owed; part payments end at zero', async () => {
    const { id, period } = await funded('Payable guard');
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 300_003n, rate: parseRate('100.500000'), spot: SPOT_CBN })); // fixture: booked 30,150,302 kobo
    const forged = (debit: bigint, amountMinor: bigint): LedgerLine[] => [
      { account: '2000', debit, credit: 0n, currency: 'CNY', amountMinor, rate: '100.000000', rateSource: 'payable_average', vehicleId: 'A', counterpartyId: SUPPLIER },
      { account: '7000', debit: 0n, credit: debit, currency: 'NGN', amountMinor: debit },
    ];
    await assert.rejects(postLines(id, period, forged(10_000_100n, 100_001n)), /must clear its booked cost: expected 10050101 kobo/); // a chosen lower rate
    await assert.rejects(postLines(id, period, forged(30_150_402n, 300_004n)), /exceeds the 300003 owed to this supplier for this car/);
    for (let i = 0; i < 3; i++) {
      await postLines(id, period, payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 100_001n, spot: SPOT_CBN }).lines);
    }
    assert.deepEqual(await payableOf(id), { balanceMinor: 0n, costNgn: 0n }, 'no kobo stranded');
  });

  test('the pool and payable checks cannot be skipped by choosing another rate source', async () => {
    const { id, period } = await funded('No bypass');
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    // Settle the payable at a chosen rate by calling it manual: refused.
    await assert.rejects(postLines(id, period, [
      { account: '2000', debit: 200_000_000n, credit: 0n, currency: 'CNY', amountMinor: 2_000_000n, rate: '100.000000', rateSource: 'manual', rateNote: 'settled', vehicleId: 'A', counterpartyId: SUPPLIER },
      { account: '1000', debit: 0n, credit: 200_000_000n, currency: 'NGN', amountMinor: 200_000_000n },
    ]), /paid down only at its booked cost/);
    // Take currency out of the pool at a chosen rate: refused.
    await assert.rejects(postLines(id, period, [
      { account: '6000', debit: 100_000n, credit: 0n, currency: 'NGN', amountMinor: 100_000n },
      { account: '1010', debit: 0n, credit: 100_000n, currency: 'CNY', amountMinor: 1_000_000n, rate: '0.100000', rateSource: 'manual', rateNote: 'x' },
    ]), /leaves the pool \(1010\) only at its average cost/);
    // Pay the invoiced car straight from the pool as well: refused (it would be costed twice).
    await assert.rejects(postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 2_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines), /open supplier invoice/);
  });

  test('an invoice cannot be reversed while payments stand against it; reversing the payments first works', async () => {
    const { id, period } = await funded('Invoice reversal');
    const inv = supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    const invId = await postLines(id, period, inv);
    const pay = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 1_000_000n, spot: SPOT_CBN }).lines;
    const payId = await postLines(id, period, pay);
    const mirror = (lines: LedgerLine[]) => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    await assert.rejects(postLines(id, period, mirror(inv), { reverses: invId }), /reverse those payments first/);
    await postLines(id, period, mirror(pay), { reverses: payId });
    await postLines(id, period, mirror(inv), { reverses: invId });
    assert.deepEqual(await payableOf(id), { balanceMinor: 0n, costNgn: 0n });
    assert.deepEqual(await poolOf(id), { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, 'pool restored');
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('a pool payment posted before spot rates existed can still be reversed', async () => {
    const { id, period } = await funded('Old reversal');
    const old = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines
      .map((l) => ({ ...l, spotRate: undefined, spotSource: undefined })); // shaped like a line from migration 0004
    await owner('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_spot_source');
    const oldId = await postLines(id, period, old).finally(() => owner('ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_spot_source'));
    await postLines(id, period, old.map((l) => ({ ...l, debit: l.credit, credit: l.debit })), { reverses: oldId });
    assert.deepEqual(await poolOf(id), { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n });
  });

  test('a CBN rate more than 7 days old is not accepted as that day\'s CBN rate', async () => {
    const { id, period } = await funded('Stale CBN');
    const lines = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    await assert.rejects(postLines(id, period, lines, { date: '2026-01-20' }), /no CBN rate for CNY in the 7 days up to 2026-01-20/);
    await postLines(id, period, lines, { date: '2026-01-15' });
  });

  test('a spot rate marked cbn must be the stored CBN rate; manual needs a note; NGN lines carry none', async () => {
    const { id, period } = await funded('Spot source');
    const pay = (spot: { rate: bigint; source: 'cbn' | 'manual' }, rateNote?: string) => postLines(id, period,
      payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot, rateNote: 'x' }).lines
        .map((l) => (l.rateSource ? { ...l, rateNote } : l)));
    await assert.rejects(pay({ rate: parseRate('109.000000'), source: 'cbn' }), /marked cbn but the CBN rate for CNY on 2026-01-08 is 108.000000/);
    await assert.rejects(pay({ rate: parseRate('109.000000'), source: 'manual' }), /journal_lines_spot/);
    await pay({ rate: parseRate('109.000000'), source: 'manual' }, 'BDC receipt rate; CBN not yet published');
    await assert.rejects(postLines(id, period, [
      { account: '1000', debit: 100n, credit: 0n, currency: 'NGN', amountMinor: 100n, spotRate: FIXTURE_RATE_SPOT, spotSource: 'cbn' },
      { account: '3000', debit: 0n, credit: 100n, currency: 'NGN', amountMinor: 100n },
    ]), /journal_lines_spot/);
    // No USD rate has been published at all: a USD invoice marked cbn is refused.
    await assert.rejects(postLines(id, period, supplierInvoice({ ...bill, currency: 'USD', amountMinor: 100n, rate: parseRate('1500.000000'), spot: SPOT_CBN })), /no CBN rate for USD in the 7 days/);
  });

  test('reference rates: one per day per source; only the rates login can add them; nobody can change them', async () => {
    const ratesPool = new pg.Pool({ host: container.getHost(), port: container.getPort(), database: container.getDatabase(), user: 'finbook_rates', password: RATES_PASSWORD, max: 1 });
    try {
      const add = (source: string, rate: string) => ratesPool.query("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2027-03-10', 'CNY', $1, $2)", [rate, source]);
      await add('cbn', '108.000000'); // FIXTURE_RATE_SPOT
      await add('market', '109.000000'); // fixture: market feed differs from CBN
      await assert.rejects(add('cbn', '110.000000'), /fx_reference_rates_day/);
      await ratesPool.query("INSERT INTO fx_reference_rates (rate_date, currency, rate, source, revision) VALUES ('2027-03-10', 'CNY', '108.500000', 'cbn', 2)"); // a correction
      assert.equal((await ratesPool.query<{ rate: string }>("SELECT rate FROM fx_reference_rates WHERE rate_date = '2027-03-10' AND source = 'cbn' ORDER BY revision DESC LIMIT 1")).rows[0]?.rate, '108.500000');
      await assert.rejects(add('blog', '110.000000'), /fx_reference_rates_source/);
      await assert.rejects(ratesPool.query('SELECT 1 FROM journal_lines'), /permission denied/);
      await assert.rejects(ratesPool.query('SELECT 1 FROM tenants'), /permission denied/);
    } finally {
      await ratesPool.end();
    }
    assert.equal(await tx(tenantA, async (t) => (await t.client.query("SELECT 1 FROM fx_reference_rates WHERE rate_date = '2027-03-10'")).rowCount), 3);
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2027-03-11', 'CNY', '1.000000', 'cbn')")), /permission denied/);
    await assert.rejects(owner("UPDATE fx_reference_rates SET rate = '1.000000'"), /append-only/);
  });

  test('two payments at the same moment cannot both spend the same pool', async () => {
    const { id, period } = await funded('Pool race');
    const stale = await poolOf(id); // both payments are prepared from the same view: CNY 150,000.00
    let holding = (): void => undefined;
    let release = (): void => undefined;
    const firstHasLine = new Promise<void>((r) => { holding = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const first = tx(id, async (t) => {
      const lines = payFromPool({ pool: stale, currency: 'CNY', amountMinor: 10_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
      const entryId = await one(t.client, "INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key) VALUES ($1, $2, '2026-01-10', 'race 1', 'test', uuidv7(), 'race-1') RETURNING id", [id, period]);
      for (const l of lines) {
        await t.client.query('INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
          [id, entryId, accounts[id]?.[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, car.A]);
      }
      holding();
      await gate; // keep the transaction open while the second payment tries
    });
    await firstHasLine;
    const second = postLines(id, period, payFromPool({ pool: stale, currency: 'CNY', amountMinor: 10_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines);
    await new Promise((r) => setTimeout(r, 300)); // the second payment is now waiting on the tenant lock
    release();
    await first;
    await assert.rejects(second, /pool overspent/);
    assert.deepEqual(await poolOf(id), { balanceMinor: 5_000_000n, costNgn: 533_333_333n });
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
      // Currency only leaves the pool (1010) at its average cost, so a flipped foreign line goes to an account without a pool.
      const flip = (l: Line): Line => ({ ...l, account: l.account === '1010' ? '4000' : l.account, debit: l.credit ?? 0n, credit: l.debit ?? 0n });
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

// Phase 1 gate (spec → Build phases): 10k random entries keep the trial balance at zero, and a
// cross-tenant read returns zero rows. Plus one test per ledger and tenancy guarantee, including every
// finding from the ledger-auditor and security-reviewer passes (ADR 0006). Needs Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { convert, formatRate, parseRate, RATE_SCALE } from '@app/money';
import {
  buyCurrency, completeAgentJob, customerReceipt, payFromPool, payPayableFromPool, revalue, sharedCost, supplierInvoice, type Line as LedgerLine, type RevaluationItem,
} from '@app/ledger';
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

/** A fresh tenant with the test chart and an open January 2026 period. 1010 (the pool) has no account currency, as in production; 1020 is a CNY account. */
async function freshTenant(name: string): Promise<{ id: string; period: string }> {
  const id = (await owner<{ id: string }>('INSERT INTO tenants (legal_name) VALUES ($1) RETURNING id', [name])).rows[0]?.id ?? '';
  const ids: Record<string, string> = {};
  accounts[id] = ids;
  const period = await tx(id, async (t) => {
    for (const [code, type, currency] of [['1000', 'asset', null], ['1010', 'asset', null], ['1020', 'asset', 'CNY'], ['2000', 'liability', null], ['3000', 'equity', null],
      ['4000', 'income', null], ['5000', 'expense', null], ['6000', 'expense', null], ['7000', 'income', null],
      ['1100', 'asset', null], ['1150', 'asset', null], ['2150', 'liability', null], ['4100', 'income', null], ['4200', 'income', null],
      ['1019', 'asset', null], ['2009', 'liability', null], ['7100', 'income', null]] as const) {
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
  const usd = (extra: Partial<Line>) => fx(100n, FIXTURE_RATE_USD, 1_00_000n, { currency: 'USD', ...extra }); // USD into the pool (1010)

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
    await assert.rejects(post(tenantA, usd({ account: '1020' })), /a USD line cannot post to a CNY account/);
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

  type PostOpts = { date?: string; reverses?: string | null; sourceType?: string };
  /** Insert one posting-rule result as one journal entry, inside an open transaction (what the API will do). */
  const insertPosting = async (c: pg.ClientBase, tenant: string, period: string, lines: LedgerLine[], opts: PostOpts = {}) => {
    const ids = accounts[tenant] ?? {};
    const entryId = await one(c,
      'INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id) VALUES ($1, $2, $3, \'posting rule\', $4, uuidv7(), $5, $6) RETURNING id',
      [tenant, period, opts.date ?? '2026-01-10', opts.sourceType ?? 'test', `pr-${String(++keySeq)}`, opts.reverses ?? null]);
    for (const l of lines) {
      await c.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, rate_note, vehicle_id, counterparty_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [tenant, entryId, ids[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, l.rateNote ?? null,
          l.vehicleId ? car[l.vehicleId] : null, l.counterpartyId ? (l.counterpartyId.length === 36 ? l.counterpartyId : customer(l.counterpartyId)) : null]);
    }
    return entryId;
  };
  /** Persist one posting-rule result as one journal entry, in its own transaction. */
  const postLines = (tenant: string, period: string, lines: LedgerLine[], opts: PostOpts & { beforeCommit?: (c: pg.ClientBase) => Promise<unknown> } = {}) => tx(tenant, async (t) => {
    const entryId = await insertPosting(t.client, tenant, period, lines, opts);
    await opts.beforeCommit?.(t.client);
    return entryId;
  });
  /** Post `first` and keep its transaction open while `second` tries, then commit `first`. Resolves to `second`'s outcome. */
  const race = async (tenant: string, period: string, first: LedgerLine[], second: LedgerLine[]) => {
    let inserted = (): void => undefined;
    let release = (): void => undefined;
    const firstIn = new Promise<void>((r) => { inserted = r; });
    const hold = new Promise<void>((r) => { release = r; });
    const a = postLines(tenant, period, first, { beforeCommit: async () => { inserted(); await hold; } });
    await firstIn;
    const b = postLines(tenant, period, second);
    b.catch(() => undefined); // judged by the caller, after the first commits
    await new Promise((r) => setTimeout(r, 300)); // the second is now waiting on the tenant lock
    release();
    await a;
    return b;
  };
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
    // The stored CBN rate is for 2026-01-08: 7 days later still counts, 8 days later doesn't.
    await assert.rejects(postLines(id, period, lines, { date: '2026-01-16' }), /no CBN rate for CNY in the 7 days up to 2026-01-16/);
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
    await assert.rejects(postLines(id, period, supplierInvoice({ vehicleId: 'B', supplierId: SUPPLIER, currency: 'USD', amountMinor: 100n, rate: parseRate('1500.000000'), spot: SPOT_CBN })), /no CBN rate for USD in the 7 days/);
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
      await assert.rejects(ratesPool.query("INSERT INTO fx_reference_rates (rate_date, currency, rate, source, fetched_at) VALUES ('2027-03-12', 'CNY', '108.000000', 'cbn', '2027-03-01')"), /permission denied/); // can't backdate
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
    const pay = (v: string) => payFromPool({ pool: stale, currency: 'CNY', amountMinor: 10_000_000n, vehicleId: v, spot: SPOT_CBN }).lines;
    await assert.rejects(race(id, period, pay('A'), pay('B')), /pool overspent/);
    assert.deepEqual(await poolOf(id), { balanceMinor: 5_000_000n, costNgn: 533_333_333n });
  });

  // Month-end revaluation (spec FX rule 6, ADR 0011), worked by hand. Pool CNY 150,000.00 carried at NGN 16,000,000.00;
  // supplier S owed CNY 20,000.00 for car A, booked at 105 = NGN 2,100,000.00. Closing CBN rate on 2026-01-30:
  // FIXTURE_RATE_CLOSE (112).
  //   pool     150,000.00 x 112 = NGN 16,800,000.00 -> gain 800,000.00: Dr 1019 / Cr 7100
  //   payables  20,000.00 x 112 = NGN  2,240,000.00 -> loss 140,000.00: Dr 7100 / Cr 2009
  //   net 7100: gain NGN 660,000.00 on 2026-01-31, reversed on 2026-02-01.
  const FIXTURE_RATE_CLOSE = '112.000000';
  const CLOSE = { date: '2026-01-30', revision: 1 };
  const closingRates = async () => {
    await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-01-30', 'CNY', $1, 'cbn') ON CONFLICT DO NOTHING", [FIXTURE_RATE_CLOSE]);
  };
  const february = (tenant: string) => tx(tenant, (t) => one(t.client, "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-02-01', '2026-02-28') RETURNING id", [tenant]));
  const item = (kind: RevaluationItem['item'], balanceMinor: bigint, carryingNgn: bigint, rate = FIXTURE_RATE_CLOSE): RevaluationItem =>
    ({ item: kind, currency: 'CNY', balanceMinor, carryingNgn, closingRate: parseRate(rate) });
  /** Revalue as the API will: the entry, its evidence rows and its day-1 reversal, in one transaction. */
  const postRevaluation = (tenant: string, jan: string, feb: string, items: RevaluationItem[],
    opts: { rate?: { date: string; revision: number }; date?: string; reversalDate?: string | null; lines?: LedgerLine[] } = {}) => tx(tenant, async (t) => {
    const r = revalue(items);
    const lines = opts.lines ?? r.lines;
    const entryId = await insertPosting(t.client, tenant, jan, lines, { date: opts.date ?? '2026-01-31', sourceType: 'fx_revaluation' });
    const rate = opts.rate ?? CLOSE;
    for (const row of r.rows) {
      await t.client.query(
        'INSERT INTO fx_revaluations (tenant_id, entry_id, item, currency, balance_minor, carrying_ngn, rate_date, rate_revision, rate, closing_ngn) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [tenant, entryId, row.item, row.currency, row.balanceMinor, row.carryingNgn, rate.date, rate.revision, formatRate(row.closingRate), row.closingNgn]);
    }
    if (opts.reversalDate !== null) {
      await insertPosting(t.client, tenant, feb, lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
        { date: opts.reversalDate ?? '2026-02-01', sourceType: 'fx_revaluation', reverses: entryId });
    }
    return entryId;
  });
  const netAsOf = (tenant: string, date: string) => tx(tenant, async (t) => Object.fromEntries((await t.client.query<{ code: string; net: string }>(
    'SELECT a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id WHERE e.entry_date <= $1 AND a.code IN (\'1019\', \'2009\', \'7100\') GROUP BY a.code',
    [date])).rows.map((r) => [r.code, BigInt(r.net)])));
  const invoiced = async (name: string) => {
    const t = await funded(name);
    await postLines(t.id, t.period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    await closingRates();
    return { ...t, feb: await february(t.id) };
  };

  test('worked example: month-end revaluation through the database, reversed on day 1, to the kobo', async () => {
    const { id, period, feb } = await invoiced('Revaluation');
    const items = [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)];
    await postRevaluation(id, period, feb, items);
    assert.deepEqual(await netAsOf(id, '2026-01-31'), { '1019': 80_000_000n, '2009': -14_000_000n, '7100': -66_000_000n }, 'gain NGN 660,000.00 at January close');
    assert.deepEqual(await netAsOf(id, '2026-02-01'), { '1019': 0n, '2009': 0n, '7100': 0n }, 'reversed on 1 February');
    assert.deepEqual(await poolOf(id), { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, 'the pool keeps its cost');
    assert.equal(await tx(id, async (t) => (await t.client.query('SELECT 1 FROM fx_revaluations')).rowCount), 2);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
    // Evidence can't be added to a posted revaluation, or changed.
    const entryId = await tx(id, async (t) => (await t.client.query<{ entry_id: string }>('SELECT entry_id FROM fx_revaluations LIMIT 1')).rows[0]?.entry_id ?? '');
    await assert.rejects(tx(id, (t) => t.client.query(
      "INSERT INTO fx_revaluations (tenant_id, entry_id, item, currency, balance_minor, carrying_ngn, rate_date, rate_revision, rate, closing_ngn) VALUES ($1, $2, 'pool', 'USD', 0, 0, '2026-01-30', 1, '1.000000', 0)", [id, entryId])), /already posted/);
    await assert.rejects(owner('UPDATE fx_revaluations SET carrying_ngn = 0'), /append-only/);
    // Another tenant sees none of it, and can't write any of it.
    assert.equal(await tx(tenantB, async (t) => (await t.client.query('SELECT 1 FROM fx_revaluations')).rowCount), 0);
    const evidence = (tenant: string, entry: string) =>
      "INSERT INTO fx_revaluations (tenant_id, entry_id, item, currency, balance_minor, carrying_ngn, rate_date, rate_revision, rate, closing_ngn) VALUES ('" + tenant + "', '" + entry + "', 'pool', 'USD', 0, 0, '2026-01-30', 1, '1.000000', 0)";
    await assert.rejects(tx(tenantB, (t) => t.client.query(evidence(id, entryId))), /belongs to a revaluation entry/); // as A's tenant: RLS hides A's entry, so no oracle
    await assert.rejects(tx(tenantB, (t) => t.client.query(evidence(tenantB, entryId))), /belongs to a revaluation entry/); // A's entry, B's tenant
    // Evidence only goes on an open revaluation entry: not on an ordinary entry, nor on the reversal.
    const reversalId = await tx(id, async (t) => (await t.client.query<{ id: string }>('SELECT id FROM journal_entries WHERE reverses_entry_id = $1', [entryId])).rows[0]?.id ?? '');
    await assert.rejects(tx(id, async (t) => {
      const plain = await insertPosting(t.client, id, period, [{ account: '1000', debit: 1n, credit: 0n, currency: 'NGN', amountMinor: 1n }, { account: '3000', debit: 0n, credit: 1n, currency: 'NGN', amountMinor: 1n }]);
      await t.client.query(evidence(id, plain));
    }), /belongs to a revaluation entry/);
    await assert.rejects(tx(id, (t) => t.client.query(evidence(id, reversalId))), /belongs to a revaluation entry/);
  });

  test('a revaluation must match the ledger, use the latest CBN rate, be dated month-end and reverse on day 1', async () => {
    const { id, period, feb } = await invoiced('Revaluation guards');
    const good = [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)];
    const [pool, payables] = good;
    if (!pool || !payables) throw new Error('two items');
    await assert.rejects(postRevaluation(id, period, feb, [{ ...pool, carryingNgn: 1_500_000_000n }, payables]), /CNY pool on 2026-01-31: the ledger has balance 15000000 carried at 1600000000/);
    await assert.rejects(postRevaluation(id, period, feb, [pool]), /CNY payables on 2026-01-31: the ledger has balance 2000000 carried at 210000000 kobo, the evidence says none/);
    await assert.rejects(postRevaluation(id, period, feb, good.map((i) => ({ ...i, closingRate: parseRate('111.000000') }))), /closing rate must be the latest CBN rate on or before 2026-01-31/); // fixture: a chosen rate
    await assert.rejects(postRevaluation(id, period, feb, good.map((i) => ({ ...i, closingRate: parseRate(FIXTURE_RATE_SPOT) })), { rate: { date: '2026-01-08', revision: 1 } }),
      /latest is 2026-01-30, revision 1/); // an older CBN rate
    await assert.rejects(postRevaluation(id, period, feb, good, { reversalDate: null }), /posts with its reversal dated 2026-02-01/);
    await assert.rejects(postRevaluation(id, period, feb, good, { reversalDate: '2026-02-02' }), /posts with its reversal dated 2026-02-01/);
    await assert.rejects(postRevaluation(id, period, feb, good, { date: '2026-01-30' }), /dated its period's last day \(2026-01-31\)/);
    const r = revalue(good);
    await assert.rejects(postRevaluation(id, period, feb, good, { lines: r.lines.map((l) => (l.account === '2009' ? { ...l, account: '6000' } : l)) }), /posts only to 1019, 2009 and 7100/);
    // 1019 and 2009 hold revaluation only.
    await assert.rejects(postLines(id, period, [{ account: '1019', debit: 100n, credit: 0n, currency: 'NGN', amountMinor: 100n }, { account: '7100', debit: 0n, credit: 100n, currency: 'NGN', amountMinor: 100n }]),
      /1019 and 2009 hold month-end revaluation only/);
    await postRevaluation(id, period, feb, good);
  });

  const periodFor = (tenant: string, starts: string, ends: string) =>
    tx(tenant, (t) => one(t.client, 'INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING id', [tenant, starts, ends]));

  test('revaluation guards that only bite in their own case (ledger audit of 0007)', async () => {
    const { id, period, feb } = await invoiced('Revaluation edges');
    const good = [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)];
    // Evidence right, but an extra NGN 1,000,000.00 "gain" on 1019: the movement check refuses it.
    const fake: LedgerLine[] = [{ account: '1019', debit: 100_000_000n, credit: 0n, currency: 'NGN', amountMinor: 100_000_000n }, { account: '7100', debit: 0n, credit: 100_000_000n, currency: 'NGN', amountMinor: 100_000_000n }];
    await assert.rejects(postRevaluation(id, period, feb, good, { lines: [...revalue(good).lines, ...fake] }), /1019 must move by the pool's restated difference/);
    // Evidence for something the ledger doesn't hold (no USD payables here, so a CNY row for a second supplier-less item is refused).
    const { id: bare, period: barePeriod } = await funded('Revaluation bare');
    const bareFeb = await february(bare);
    await assert.rejects(postRevaluation(bare, barePeriod, bareFeb, [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 0n, 0n)]),
      /CNY payables on 2026-01-31: the ledger has balance none carried at none kobo, the evidence says 0 at 0/);
    // The direct calls are closed: the app can't run a check itself (it would take another tenant's lock).
    await assert.rejects(tx(id, (t) => t.client.query('SELECT assert_fx_revaluation(e) FROM journal_entries e LIMIT 1')), /permission denied for function assert_fx_revaluation/);
    await assert.rejects(tx(id, (t) => t.client.query('SELECT assert_foreign_entry(e) FROM journal_entries e LIMIT 1')), /permission denied for function assert_foreign_entry/);
    // Foreign money on another balance-sheet account would never be revalued: refused. A foreign expense line is fine.
    await assert.rejects(post(id, { periodId: period, date: '2026-01-20', lines: [{ account: '1000', debit: 1_00_000n, currency: 'USD', amountMinor: 100n, rate: FIXTURE_RATE_USD, rateSource: 'bank_receipt' }, { account: '3000', credit: 1_00_000n }] }),
      /a USD line cannot post to 1000: foreign money on the balance sheet lives on the pool \(1010\) or foreign payables \(2000\)/);
    await post(id, { periodId: period, date: '2026-01-20', lines: [{ account: '6000', debit: 1_00_000n, currency: 'USD', amountMinor: 100n, rate: FIXTURE_RATE_USD, rateSource: 'bank_receipt' }, { account: '1000', credit: 1_00_000n }] });
  });

  test('February\'s revaluation ignores January\'s once reversed; the CBN rate may be 7 days old, not 8', async () => {
    const { id, period, feb } = await invoiced('Revaluation months');
    await postRevaluation(id, period, feb, [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)]);
    const mar = await periodFor(id, '2026-03-01', '2026-03-31');
    const apr = await periodFor(id, '2026-04-01', '2026-04-30');
    // February 28: January's NGN 800,000.00 was reversed on 1 February, so the pool is carried at cost again (16,000,000.00).
    await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-02-27', 'CNY', '113.000000', 'cbn') ON CONFLICT DO NOTHING"); // fixture
    const febItems = (poolCarrying: bigint) => [item('pool', 15_000_000n, poolCarrying, '113.000000'), item('payables', 2_000_000n, 210_000_000n, '113.000000')];
    const febRun = { rate: { date: '2026-02-27', revision: 1 }, date: '2026-02-28', reversalDate: '2026-03-01' };
    await assert.rejects(postRevaluation(id, feb, mar, febItems(1_680_000_000n), febRun), /carried at 1600000000 kobo, the evidence says 15000000 at 1680000000/);
    await postRevaluation(id, feb, mar, febItems(1_600_000_000n), febRun);
    // March 31: the only CBN rate is 8 days old (23 March): refused. One 7 days old (24 March) is accepted.
    await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-03-23', 'CNY', '114.000000', 'cbn') ON CONFLICT DO NOTHING"); // fixture
    const marItems = (rate: string) => [item('pool', 15_000_000n, 1_600_000_000n, rate), item('payables', 2_000_000n, 210_000_000n, rate)];
    await assert.rejects(postRevaluation(id, mar, apr, marItems('114.000000'), { rate: { date: '2026-03-23', revision: 1 }, date: '2026-03-31', reversalDate: '2026-04-01' }),
      /latest is none, revision none/);
    await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source) VALUES ('2026-03-24', 'CNY', '115.000000', 'cbn') ON CONFLICT DO NOTHING"); // fixture
    await postRevaluation(id, mar, apr, marItems('115.000000'), { rate: { date: '2026-03-24', revision: 1 }, date: '2026-03-31', reversalDate: '2026-04-01' });
    assert.deepEqual(await netAsOf(id, '2026-04-01'), { '1019': 0n, '2009': 0n, '7100': 0n }, 'every month reversed');
  });

  test('a pool emptied between two runs clears what the first run left on 1019', async () => {
    const { id, period, feb } = await invoiced('Revaluation emptied');
    await postRevaluation(id, period, feb, [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)]);
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 15_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines, { date: '2026-01-15' });
    assert.deepEqual(await poolOf(id), { balanceMinor: 0n, costNgn: 0n });
    // Pool: nothing held, carried at the NGN 800,000.00 still standing -> the rerun takes it off 1019.
    await postRevaluation(id, period, feb, [item('pool', 0n, 80_000_000n), item('payables', 2_000_000n, 224_000_000n)]);
    assert.deepEqual(await netAsOf(id, '2026-01-31'), { '1019': 0n, '2009': -14_000_000n, '7100': 14_000_000n });
  });

  test('the commit-time checks cannot be run early and then dodged by adding lines (security review)', async () => {
    const { id, period } = await invoiced('Early check');
    // The whole-entry checks run inside the hash-writing trigger, the only deferred trigger on entries. A separate one could be
    // fired early (SET CONSTRAINTS, no privilege needed) while the entry is clean and then dodged by adding lines.
    const deferred = await owner<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid = 'journal_entries'::regclass AND tgdeferrable ORDER BY tgname");
    assert.deepEqual(deferred.rows.map((r) => r.tgname), ['journal_entries_post']);
    // Firing everything early hashes the clean entry, so the 1019 balance planted afterwards is refused.
    await assert.rejects(tx(id, async (t) => {
      const ngnLine = (account: string, debit: bigint, credit: bigint): LedgerLine => ({ account, debit, credit, currency: 'NGN', amountMinor: debit + credit });
      const entryId = await insertPosting(t.client, id, period, [ngnLine('1000', 100n, 0n), ngnLine('3000', 0n, 100n)]);
      await t.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (const l of [ngnLine('1019', 100n, 0n), ngnLine('7100', 0n, 100n)]) {
        await t.client.query('INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [id, entryId, accounts[id]?.[l.account], l.debit, l.credit, l.currency, l.amountMinor]);
      }
    }), /already posted; lines cannot be added/);
  });

  test('a second revaluation for the same day only adds what changed since the first', async () => {
    const { id, period, feb } = await invoiced('Revaluation rerun');
    await postRevaluation(id, period, feb, [item('pool', 15_000_000n, 1_600_000_000n), item('payables', 2_000_000n, 210_000_000n)]);
    // A pool payment backdated into January after the first run: CNY 10,000.00 at 16,000,000.00 x 10/150 = NGN 1,066,666.67,
    // leaving CNY 140,000.00 at NGN 14,933,333.33. With the NGN 800,000.00 standing on 1019 it is carried at 15,733,333.33;
    // 140,000.00 x 112 = 15,680,000.00, so the rerun posts -53,333.33 (Cr 1019 / Dr 7100). Payables carried at 2,240,000.00: no change.
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines, { date: '2026-01-15' });
    assert.deepEqual(await poolOf(id), { balanceMinor: 14_000_000n, costNgn: 1_493_333_333n });
    const rerun = [item('pool', 14_000_000n, 1_573_333_333n), item('payables', 2_000_000n, 224_000_000n)];
    assert.deepEqual(revalue(rerun).lines.map((l) => [l.account, l.debit, l.credit]), [['1019', 0n, 5_333_333n], ['7100', 5_333_333n, 0n]]);
    await assert.rejects(postRevaluation(id, period, feb, [item('pool', 14_000_000n, 1_493_333_333n), item('payables', 2_000_000n, 224_000_000n)]),
      /carried at 1573333333/); // ignoring what the first run left on 1019 is refused
    await postRevaluation(id, period, feb, rerun);
    assert.deepEqual(await netAsOf(id, '2026-01-31'), { '1019': 74_666_667n, '2009': -14_000_000n, '7100': -60_666_667n }, '1019 = 15,680,000.00 - 14,933,333.33');
    assert.deepEqual(await netAsOf(id, '2026-02-01'), { '1019': 0n, '2009': 0n, '7100': 0n });
  });

  test('an invoice and a direct pool payment for the same car at the same moment cannot both post (either order)', async () => {
    const { id, period } = await funded('Invoice race');
    const pool = await poolOf(id);
    const invoice = (v: string) => supplierInvoice({ vehicleId: v, supplierId: SUPPLIER, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    const direct = (v: string) => payFromPool({ pool, currency: 'CNY', amountMinor: 2_000_000n, vehicleId: v, spot: SPOT_CBN }).lines;
    await assert.rejects(race(id, period, invoice('A'), direct('A')), /open supplier invoice/);
    await assert.rejects(race(id, period, direct('B'), invoice('B')), /already paid straight from the pool/);
  });

  test('NGN lines cannot stand in for foreign money on the pool or a foreign payable', async () => {
    const { id, period } = await funded('NGN side door');
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    const ngn = (account: string, debit: bigint, credit: bigint, tags: Partial<LedgerLine> = {}): LedgerLine => ({ account, debit, credit, currency: 'NGN', amountMinor: debit + credit, ...tags });
    // Raise car A's cost with no currency leaving any pool.
    await assert.rejects(postLines(id, period, [ngn('1150', 100_000_000n, 0n, { vehicleId: 'A' }), ngn('1010', 0n, 100_000_000n)]), /holds foreign currency only/);
    // "Pay" the CNY invoice in NGN, leaving its CNY balance open to be paid again: named, unnamed, or in the invoice's own entry.
    const payNgn = ngn('2000', 210_000_000n, 0n, { vehicleId: 'A', counterpartyId: SUPPLIER });
    await assert.rejects(postLines(id, period, [payNgn, ngn('1000', 0n, 210_000_000n)]), /more NGN than is owed/);
    await assert.rejects(postLines(id, period, [ngn('2000', 210_000_000n, 0n), ngn('1000', 0n, 210_000_000n)]), /must name the supplier/);
    await assert.rejects(postLines(id, period, [ngn('6000', 1_000n, 0n), ngn('2000', 0n, 1_000n)]), /must name the supplier/); // an unnamed bill could never be paid
    const invoiceB = supplierInvoice({ vehicleId: 'B', supplierId: SUPPLIER, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    await assert.rejects(postLines(id, period, [{ ...payNgn, vehicleId: 'B' }, ...invoiceB, ngn('1000', 0n, 210_000_000n)]), /more NGN than is owed/);
    await postLines(id, period, payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines);
    // An NGN bill and its payment post; paying a kobo more than the bill does not.
    await postLines(id, period, [ngn('6000', 5_000_000n, 0n), ngn('2000', 0n, 5_000_000n, { counterpartyId: SUPPLIER })]);
    await assert.rejects(postLines(id, period, [ngn('2000', 5_000_001n, 0n, { counterpartyId: SUPPLIER }), ngn('1000', 0n, 5_000_001n)]), /more NGN than is owed/);
    await postLines(id, period, [ngn('2000', 5_000_000n, 0n, { counterpartyId: SUPPLIER }), ngn('1000', 0n, 5_000_000n)]);
  });

  test('a car\'s supplier cost goes to that car\'s job costs, and a settlement cannot pay a car from the pool as well', async () => {
    const { id, period } = await funded('Entry shape');
    const pay = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    const cost = /must go to that car's job costs \(1150\)/;
    await assert.rejects(postLines(id, period, pay.map((l) => (l.account === '1010' ? { ...l, vehicleId: 'B' } : l))), cost); // pool names B, 1150 names A
    const inv = supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    await assert.rejects(postLines(id, period, inv.map((l) => (l.account === '1150' ? { ...l, account: '6000', vehicleId: undefined } : l))), cost); // invoice expensed, car never costed
    await postLines(id, period, inv);
    const settle = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines;
    const shape = /a supplier settlement holds only the payable \(2000\), the pool \(1010, no car\) and realized FX \(7000\)/;
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '1010' ? { ...l, vehicleId: 'A' } : l))), /settle a supplier invoice in the same entry/); // pool line names the car
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '7000' ? { ...l, account: '1150', vehicleId: 'B' } : l))), shape); // FX gap into car B's cost
    // Clear the payable with no currency leaving the pool, as "income": refused.
    const [payableLine] = settle;
    if (!payableLine) throw new Error('settlement has a payable line');
    await assert.rejects(postLines(id, period, [payableLine, { account: '7000', debit: 0n, credit: payableLine.debit, currency: 'NGN', amountMinor: payableLine.debit }]), /an invoice is settled only from the pool/);
    await postLines(id, period, settle);
  });

  test('a chart without 7000 refuses a settlement whose FX gap goes elsewhere (a missing account does not open the shape check)', async () => {
    const { id, period } = await funded('No 7000');
    await owner("UPDATE accounts SET code = '7999' WHERE tenant_id = $1 AND code = '7000'", [id]); // the app can't recode accounts; the owner sets up the odd chart
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    const settle = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines;
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '7000' ? { ...l, account: '1150', vehicleId: 'B' } : l))), /a supplier settlement holds only/);
  });

  test('a car paid straight from the pool cannot be invoiced too, and a reversal cannot be reversed', async () => {
    const { id, period } = await funded('Pay then invoice');
    const paid = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 2_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    const payId = await postLines(id, period, paid);
    const invoice = supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    await assert.rejects(postLines(id, period, invoice), /already paid straight from the pool/);
    const mirror = (lines: LedgerLine[]) => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
    const revId = await postLines(id, period, mirror(paid), { reverses: payId });
    await postLines(id, period, invoice);
    // Reversing the reversal would re-post the direct payment beside the invoice.
    await assert.rejects(postLines(id, period, paid, { reverses: revId }), /is itself a reversal/);
  });

  test('a pool payment must name the car or settle an invoice in the same entry', async () => {
    const { id, period } = await funded('Car-less pool payment');
    const lines = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    const carless = lines.map((l) => (l.account === '1010' ? { ...l, vehicleId: undefined } : l));
    await assert.rejects(postLines(id, period, carless), /must name the car, or settle a supplier invoice/);
    // Clearing the tenant setting before COMMIT must not blind the commit-time check (security review).
    await assert.rejects(postLines(id, period, carless, { beforeCommit: (c) => c.query("SELECT set_config('app.tenant_id', '', true)") }), /must name the car, or settle a supplier invoice/);
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    // Pays CNY 20,000.00 from the pool but settles only CNY 10,000.00 of the invoice: refused.
    const settled = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 1_000_000n, spot: SPOT_CBN });
    const settle = settled.lines;
    const extra = payFromPool({ pool: settled.pool, currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines
      .map((l) => (l.account === '1010' ? { ...l, vehicleId: undefined, counterpartyId: SUPPLIER } : { ...l, account: '6000', vehicleId: undefined }));
    await assert.rejects(postLines(id, period, [...settle, ...extra]), /must name the car, or settle a supplier invoice/);
    await postLines(id, period, settle);
  });

  test('a foreign payable is created only by a supplier invoice naming the supplier and the car', async () => {
    const { id, period } = await funded('Invoice only');
    const inv = supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 1_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    const payable = (l: LedgerLine) => l.account === '2000';
    await assert.rejects(postLines(id, period, inv.map((l) => (payable(l) ? { ...l, rateSource: 'bank_receipt', spotRate: undefined, spotSource: undefined } : l))), /created only by a supplier invoice/);
    await assert.rejects(postLines(id, period, inv.map((l) => (payable(l) ? { ...l, rateSource: 'manual', rateNote: 'x' } : l))), /created only by a supplier invoice/);
    await assert.rejects(postLines(id, period, inv.map((l) => (payable(l) ? { ...l, vehicleId: undefined } : l))), /must name the supplier and the car/);
    await postLines(id, period, inv);
  });

  test('payables are per car: a supplier\'s balance on another car cannot cover this car\'s payment', async () => {
    const { id, period } = await funded('Two cars, one supplier');
    for (const v of ['A', 'B']) await postLines(id, period, supplierInvoice({ vehicleId: v, supplierId: SUPPLIER, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    const supplierTotal = { balanceMinor: 4_000_000n, costNgn: 420_000_000n }; // both cars together
    await assert.rejects(postLines(id, period, payPayableFromPool({ ...bill, pool: await poolOf(id), payable: supplierTotal, currency: 'CNY', amountMinor: 3_000_000n, spot: SPOT_CBN }).lines),
      /exceeds the 2000000 owed to this supplier for this car/);
  });

  test('a CBN spot rate must match the latest revision for that day', async () => {
    const { id, period } = await funded('CBN revision');
    await owner("INSERT INTO fx_reference_rates (rate_date, currency, rate, source, revision) VALUES ('2026-01-25', 'CNY', '107.000000', 'cbn', 1), ('2026-01-25', 'CNY', '107.500000', 'cbn', 2)"); // fixture rates: a corrected publication
    const pay = (rate: string) => postLines(id, period, payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: { rate: parseRate(rate), source: 'cbn' } }).lines, { date: '2026-01-25' });
    await assert.rejects(pay('107.000000'), /the CBN rate for CNY on 2026-01-25 is 107.500000/);
    await pay('107.500000');
  });
});

describe('phase 1 gate', () => {
  test('10k random entries: trial balance nets to zero, chain intact, invalid entries all refused', { timeout: 900_000 }, async () => {
    let seed = 20260115n;
    const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed >> 11n) % max);
    // 2150, not 2000: an unnamed NGN debit on payables is refused (it must name the supplier and stay within what's owed).
    const ngnCodes = ['1000', '2150', '3000', '4000', '5000', '6000', '7000'];
    const pick = () => ngnCodes[Number(rnd(BigInt(ngnCodes.length)))] ?? '1000';

    // Random balanced entry: 1-3 lines on one side (NGN, or CNY into the pool 1010), the same total
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

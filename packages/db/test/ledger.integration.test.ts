// Phase 1 gate (spec → Build phases): 10k random entries keep the trial balance at zero, and a
// cross-tenant read returns zero rows. Plus one test per ledger and tenancy guarantee, including every
// finding from the ledger-auditor and security-reviewer passes (ADR 0006). Needs Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { vinProblem } from '@app/contracts';
import { convert, formatRate, parseRate, RATE_SCALE } from '@app/money';
import {
  arriveInYard, buyCurrency, completeAgentJob, completeClearingJob, convertToStock, customerReceipt, customerRefund, payFromPool, payPayableFromPool, receivableReceipt, refundStockDeposit, revalue, sellStockCar, sharedCost, stockDeposit,
  supplierCredit, supplierInvoice,
  type Line as LedgerLine, type RevaluationItem,
} from '@app/ledger';
import { applyMembershipEvent, migrate, resolveAccess, revokeOrganization, withTenant, type Actor, type Tx } from '../src/index.ts';

type Line = {
  account: string; debit?: bigint; credit?: bigint;
  currency?: string; amountMinor?: bigint; rate?: string; rateSource?: string; rateNote?: string;
};
type Entry = { periodId: string; date: string; lines: Line[]; key?: string; memo?: string; reverses?: string; sourceType?: string; fixtureEvidence?: boolean };

/**
 * A stored fixture document for a test entry whose foreign lines carry none: foreign lines need their evidence (0017). A
 * reversal carries its original's, as a real one would.
 */
async function fixtureEvidence(c: pg.ClientBase, tenant: string, reverses: string | null | undefined): Promise<string> {
  if (reverses) {
    const theirs = await one(c, "SELECT evidence_document_id AS id FROM journal_lines WHERE entry_id = $1 AND currency <> 'NGN' AND evidence_document_id IS NOT NULL LIMIT 1", [reverses]);
    if (theirs) return theirs;
  }
  const d = await one(c, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'fixture.pdf') RETURNING id",
    [tenant, randomBytes(32).toString('hex')]);
  await c.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [d]);
  return d;
}

/**
 * The entry type a test entry posts as (migration 0015): what the API sets from the rule it ran. Tests name it when they
 * forge an entry; otherwise it is read off the lines, the way the rules in packages/ledger build them. A reversal takes the
 * type of the entry it reverses.
 */
type Shaped = { account: string; debit?: bigint; credit?: bigint; rateSource?: string };
function entryTypeOf(lines: readonly Shaped[]): string {
  const dr = (a: string) => lines.some((l) => l.account === a && (l.debit ?? 0n) > 0n);
  const cr = (a: string) => lines.some((l) => l.account === a && (l.credit ?? 0n) > 0n);
  const on = (a: string) => dr(a) || cr(a);
  const rated = (a: string, r: string) => lines.some((l) => l.account === a && l.rateSource === r);
  if (on('1019') || on('2009') || on('7100')) return 'fx_revaluation';
  if (dr('1200') && cr('1150')) return 'stock_conversion';
  if (on('4100') || on('4200') || (cr('1150') && (dr('2150') || dr('1100')))) return 'job_completion';
  if (dr('1210') && cr('1200')) return 'yard_arrival';
  if (on('4000') || on('5000')) return 'stock_sale';
  if (cr('2100')) return 'stock_deposit';
  if (dr('2100')) return 'stock_deposit_refund';
  if (cr('2150')) return 'customer_receipt';
  if (dr('2150')) return 'customer_refund';
  if (cr('1100')) return 'receivable_receipt';
  if (rated('2000', 'payable_average')) return 'supplier_settlement';
  if (rated('2000', 'agent_invoice')) return 'supplier_invoice';
  if (dr('1010')) return 'currency_purchase';
  if (rated('1010', 'pool_average')) return 'pool_payment';
  if (cr('1150')) return 'supplier_credit';
  if (dr('1150') || dr('1200')) return 'car_cost';
  return 'manual_journal';
}

/** Refused for not fitting its entry type (0015): the shapes now catch most forged entries before the older guards do. */
const SHAPE = /has no place for that line|entry holds \d+ to|entry is for one car|names one counterparty|a manual journal names no car|is not an entry type/;
/** An older guard's refusal, or the shape check's, whichever catches the forged entry first. */
const orShape = (re: RegExp) => new RegExp(`${re.source}|${SHAPE.source}`);

const API_PASSWORD = 'test-only-password'; // fixture: the throwaway container's finbook_api login
const RATES_PASSWORD = 'test-only-rates'; // fixture: the throwaway container's finbook_rates login
const HOOK_PASSWORD = 'test-only-hook'; // fixture: the throwaway container's finbook_hook login
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
const SUPPLIER = '019a0000-0000-7000-8000-0000000000f1'; // stands for the tenant's own test supplier (suppliers below)
const suppliers: Record<string, string> = {}; // tenant -> its test supplier (a real counterparty of kind supplier, 0015)
const counterpartyIn = (tenant: string, id: string) => (id === SUPPLIER ? (suppliers[tenant] ?? '') : id);
const rateString = (scaled: bigint) => `${String(scaled / RATE_SCALE)}.${String(scaled % RATE_SCALE).padStart(6, '0')}`;

const randomHex = () => randomBytes(32).toString('hex'); // a fake sha256: tests only
const as = (tenantId: string, userId = USER): Actor => ({ tenantId, userId });
const tx = <T>(tenantId: string, fn: (t: Tx) => Promise<T>) => withTenant(apiPool, as(tenantId), fn);
const owner = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => ownerPool.query<T>(sql, params);
const one = async (c: pg.ClientBase, sql: string, params: unknown[] = []) => (await c.query<{ id: string }>(sql, params)).rows[0]?.id ?? '';

/** Insert one entry and its lines inside an existing transaction. Returns the entry id. */
async function insertEntry(c: pg.ClientBase, tenant: string, e: Entry): Promise<string> {
  const entryId = await one(c,
    `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id)
     VALUES ($1, $2, $3, $4, coalesce($7, (SELECT source_type FROM journal_entries WHERE id = $6)), uuidv7(), $5, $6) RETURNING id`,
    [tenant, e.periodId, e.date, e.memo ?? 'test entry', e.key ?? `k-${String(++keySeq)}`, e.reverses ?? null, e.sourceType ?? (e.reverses ? null : entryTypeOf(e.lines))]);
  const ids = accounts[tenant] ?? {};
  const evidence = e.fixtureEvidence !== false && e.lines.some((l) => (l.currency ?? 'NGN') !== 'NGN') ? await fixtureEvidence(c, tenant, e.reverses) : null;
  for (const l of e.lines) {
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note, evidence_document_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [tenant, entryId, ids[l.account] ?? l.account, debit, credit, l.currency ?? 'NGN', l.amountMinor ?? debit + credit,
        l.rate ?? null, l.rateSource ?? null, l.rateNote ?? null, (l.currency ?? 'NGN') !== 'NGN' ? evidence : null]);
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
  const id = (await owner<{ id: string }>("INSERT INTO tenants (legal_name, go_live_on) VALUES ($1, '2025-12-01') RETURNING id", [name])).rows[0]?.id ?? '';
  const ids: Record<string, string> = {};
  accounts[id] = ids;
  const period = await tx(id, async (t) => {
    for (const [code, type, currency] of [['1000', 'asset', null], ['1010', 'asset', null], ['1020', 'asset', 'CNY'], ['2000', 'liability', null], ['3000', 'equity', null],
      ['4000', 'income', null], ['5000', 'expense', null], ['6000', 'expense', null], ['7000', 'income', null], ['4900', 'income', null], ['6100', 'expense', null],
      ['1100', 'asset', null], ['1150', 'asset', null], ['2150', 'liability', null], ['4100', 'income', null], ['4200', 'income', null],
      ['1019', 'asset', null], ['2009', 'liability', null], ['7100', 'income', null],
      ['1200', 'asset', null], ['1210', 'asset', null], ['2100', 'liability', null]] as const) {
      ids[code] = await one(t.client, 'INSERT INTO accounts (tenant_id, code, name, type, currency) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [id, code, `Account ${code}`, type, currency]);
    }
    suppliers[id] = await one(t.client, "INSERT INTO counterparties (tenant_id, kind, name) VALUES ($1, 'supplier', 'Test supplier') RETURNING id", [id]);
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
  await migrate(ownerPool, { api: API_PASSWORD, rates: RATES_PASSWORD, hook: HOOK_PASSWORD });
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
    for (const table of ['tenants', 'accounts', 'periods', 'journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log', 'memberships', 'firm_access']) {
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
  // Nothing posts for a car that isn't on a job order with an accepted quote (0014), so each test tenant gets real cars A, B
  // and C, each on its own accepted job. By default each is a customer-funded car purchase whose customer has already paid
  // FIXTURE_FUNDS_HELD, the normal business; a test can set its own.
  type JobSetup = { jobType: 'car_purchase' | 'clearing_only'; funding: 'customer_funded' | 'emm_funded'; price?: bigint; landing?: bigint; rate?: string };
  const CUSTOMER_JOB: JobSetup = { jobType: 'car_purchase', funding: 'customer_funded' };
  const EMM: JobSetup = { jobType: 'car_purchase', funding: 'emm_funded' };
  const FIXTURE_FUNDS_HELD = 1_000_000_000n; // NGN 10,000,000.00 paid by each customer before EMM pays the supplier
  const REVIEWER = 'user_reviewer';
  const cars: Record<string, Record<string, string>> = {}; // tenant -> A/B/C -> vehicle id
  const jobIds: Record<string, Record<string, string>> = {}; // tenant -> A/B/C -> job order id
  const carOf = (tenant: string, v: string) => {
    const id = cars[tenant]?.[v];
    if (!id) throw new Error(`no test car ${v} in this tenant`);
    return id;
  };
  /** A firm sign-off of every open flag of one kind on one car (0014). */
  const approve = async (tenant: string, v: string, kind: string, userId = REVIEWER) => {
    const open = (await tx(tenant, (t) => t.client.query<{ flag_id: string }>('SELECT flag_id FROM job_order_exceptions WHERE vehicle_id = $1 AND kind = $2', [cars[tenant]?.[v], kind]))).rows;
    if (open.length === 0) throw new Error(`no open ${kind} flag for car ${v}`);
    for (const f of open) {
      await withTenant(apiPool, as(tenant, userId), (t) => t.client.query("INSERT INTO job_order_sign_offs (tenant_id, flag_id, reason) VALUES ($1, $2, 'fixture sign-off')", [tenant, f.flag_id]));
    }
  };
  const jobsFor = async (tenant: string, setup: Partial<Record<string, JobSetup>> = {}) => {
    await owner('INSERT INTO firm_staff (clerk_user_id) VALUES ($1) ON CONFLICT DO NOTHING', [REVIEWER]);
    await owner("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, $2, 'firm_reviewer', 'test')", [tenant, REVIEWER]);
    const carIds: Record<string, string> = {};
    const jobs: Record<string, string> = {};
    const people: Record<string, string> = {};
    cars[tenant] = carIds;
    customers[tenant] = people;
    jobIds[tenant] = jobs;
    for (const v of ['A', 'B', 'C']) {
      const s = setup[v] ?? CUSTOMER_JOB;
      const purchase = s.jobType === 'car_purchase';
      jobs[v] = await tx(tenant, async (t) => {
        const customerId = await one(t.client, "INSERT INTO counterparties (tenant_id, kind, name) VALUES ($1, 'customer', $2) RETURNING id", [tenant, `Customer ${v}`]);
        people[v] = customerId;
        carIds[v] = await one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, $2, 'Test', 'Car', 2024) RETURNING id", [tenant, `TESTCAR${v}000000000`]);
        const quote = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'accepted_quote', 'application/pdf', 100, $2, 'q.pdf') RETURNING id", [tenant, 'a'.repeat(64)]);
        await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [quote]);
        const jobId = await one(t.client,
          `INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
           VALUES ($1, $2, $3, $4, $5, '2026-01-05', $6, $7, $8, $9, $10, $11) RETURNING id`,
          [tenant, customerId, s.jobType, s.funding, s.funding === 'emm_funded' ? 'fixture: bought ahead of a buyer' : null,
            purchase ? (s.price ?? 4_500_000n) : null, purchase ? 'CNY' : null, purchase ? (s.rate ?? '110.000000') : null, purchase ? 'manual' : null, purchase ? 'FIXTURE_RATE_QUOTE' : null, s.landing ?? 0n]);
        await t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor, landing_charge_ngn) VALUES ($1, $2, $3, $4, $5)',
          [tenant, jobId, carIds[v], purchase ? (s.price ?? 4_500_000n) : null, s.landing ?? 0n]);
        await t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [jobId, quote]);
        return jobId;
      });
    }
  };
  const customers: Record<string, Record<string, string>> = {}; // tenant -> A/B/C -> the job's customer
  const customer = (tenant: string, v: string) => {
    const id = customers[tenant]?.[v];
    if (!id) throw new Error(`no test customer ${v} in this tenant`);
    return id;
  };
  const job = (v: string) => ({ vehicleId: v, counterpartyId: v });

  type PostOpts = { date?: string; reverses?: string | null; sourceType?: string; fixtureEvidence?: boolean };
  /** Insert one posting-rule result as one journal entry, inside an open transaction (what the API will do). */
  const insertPosting = async (c: pg.ClientBase, tenant: string, period: string, lines: LedgerLine[], opts: PostOpts = {}) => {
    const ids = accounts[tenant] ?? {};
    const entryId = await one(c,
      'INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id) VALUES ($1, $2, $3, \'posting rule\', coalesce($4, (SELECT source_type FROM journal_entries WHERE id = $6)), uuidv7(), $5, $6) RETURNING id',
      [tenant, period, opts.date ?? '2026-01-10', opts.sourceType ?? (opts.reverses ? null : entryTypeOf(lines)), `pr-${String(++keySeq)}`, opts.reverses ?? null]);
    const evidence = opts.fixtureEvidence !== false && lines.some((l) => l.currency !== 'NGN' && !l.evidenceDocumentId) ? await fixtureEvidence(c, tenant, opts.reverses) : null;
    for (const l of lines) {
      await c.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, rate_note, vehicle_id, counterparty_id,
           evidence_document_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [tenant, entryId, ids[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, l.rateNote ?? null,
          l.vehicleId ? carOf(tenant, l.vehicleId) : null, l.counterpartyId ? (l.counterpartyId.length === 36 ? counterpartyIn(tenant, l.counterpartyId) : customer(tenant, l.counterpartyId)) : null,
          l.evidenceDocumentId ?? (l.currency !== 'NGN' ? evidence : null)]);
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
  /** A tenant with jobs A, B and C, CNY 150,000.00 in the pool, and (unless held is false) each customer's funds held. */
  const funded = async (name: string, opts: { jobs?: Partial<Record<string, JobSetup>>; held?: boolean } = {}) => {
    const t = await freshTenant(name);
    await jobsFor(t.id, opts.jobs);
    if (opts.held !== false) {
      for (const v of ['A', 'B', 'C']) {
        if ((opts.jobs?.[v] ?? CUSTOMER_JOB).funding === 'customer_funded') await postLines(t.id, t.period, customerReceipt({ ...job(v), amountNgn: FIXTURE_FUNDS_HELD }));
      }
    }
    await postLines(t.id, t.period, buyCurrency({ currency: 'CNY', amountMinor: 10_000_000n, rate: parseRate('100.000000'), rateSource: 'bdc_receipt' })); // FIXTURE_RATE_BUY_1
    await postLines(t.id, t.period, buyCurrency({ currency: 'CNY', amountMinor: 5_000_000n, rate: parseRate('120.000000'), rateSource: 'bdc_receipt' })); // FIXTURE_RATE_BUY_2
    return t;
  };

  test('the worked example posts cleanly and the balances match the hand-worked figures', async () => {
    const { id, period } = await funded('Worked example', { held: false, jobs: { A: { ...CUSTOMER_JOB, landing: 150_000_000n } } });
    for (const [v, amountNgn] of [['A', 600_000_000n], ['B', 500_000_000n], ['C', 650_000_000n]] as const) await postLines(id, period, customerReceipt({ ...job(v), amountNgn }));
    for (const [v, amountMinor] of [['A', 4_000_000n], ['B', 3_500_000n], ['C', 4_500_000n]] as const) {
      await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor, vehicleId: v, spot: SPOT_CBN }).lines);
    }
    await postLines(id, period, sharedCost({ amountNgn: 249_999_999n, vehicleIds: ['A', 'B', 'C'] }));
    await postLines(id, period, sharedCost({ amountNgn: 100_000_000n, vehicleIds: ['A', 'B', 'C'] }));
    await postLines(id, period, sharedCost({ amountNgn: 15_000_000n, vehicleIds: ['A'] }));
    // Completion reads car A's history back from the database, nothing is typed in.
    const history = await tx(id, async (t) => (await t.client.query<{ code: string; debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; vehicle_id: string | null }>(
      'SELECT a.code, l.debit_ngn, l.credit_ngn, l.currency, l.amount_minor, l.vehicle_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id = $1', [carOf(id, 'A')])).rows
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
    const original = await tx(id, async (t) => (await t.client.query<{ id: string }>('SELECT entry_id AS id FROM journal_lines WHERE vehicle_id = $1 LIMIT 1', [carOf(id, 'A')])).rows[0]?.id ?? '');
    const mirror = (vehicleId: string): LedgerLine[] => paid.map((l) => ({ ...l, debit: l.credit, credit: l.debit, vehicleId }));
    const reverse = (lines: LedgerLine[]) => tx(id, async (t) => {
      const entryId = await one(t.client, "INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id) VALUES ($1, $2, '2026-01-11', 'reversal', 'pool_payment', uuidv7(), $3, $4) RETURNING id",
        [id, period, `rev-${String(++keySeq)}`, original]);
      const evidence = await fixtureEvidence(t.client, id, original); // the original's slip
      for (const l of lines) {
        await t.client.query('INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, spot_rate, spot_source, vehicle_id, evidence_document_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
          [id, entryId, accounts[id]?.[l.account], l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.spotRate ?? null, l.spotSource ?? null, l.vehicleId ? carOf(id, l.vehicleId) : null,
            l.currency !== 'NGN' ? evidence : null]);
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
      [accounts[tenant]?.['2000'], counterpartyIn(tenant, SUPPLIER), carOf(tenant, 'A')])).rows[0];
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

  test('a posting waits at most 5 seconds for a lock, then fails cleanly; nothing holds a transaction idle for long (security review of 0015)', async () => {
    const { id, period } = await funded('Lock timeout');
    const settings = await tx(id, async (t) => (await t.client.query<{ lock: string; idle: string }>(
      "SELECT current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle")).rows[0]);
    assert.deepEqual(settings, { lock: '5s', idle: '30s' });
    // Someone holds car A's job row (an accept-quote, a stuck request): a posting for A gives up after 5 s instead of
    // freezing this tenant's postings behind it.
    let held = (): void => undefined;
    let release = (): void => undefined;
    const holding = new Promise<void>((r) => { held = r; });
    const until = new Promise<void>((r) => { release = r; });
    const holder = tx(id, async (t) => {
      await t.client.query('SELECT 1 FROM job_orders WHERE id = $1 FOR UPDATE', [jobIds[id]?.A]);
      held();
      await until;
    });
    await holding;
    const started = Date.now();
    await assert.rejects(postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 1_000n })), /lock timeout/);
    const waited = Date.now() - started;
    assert.ok(waited >= 4_500 && waited < 15_000, `waited ${String(waited)} ms`);
    release();
    await holder;
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 1_000n })); // and posts once the row is free
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
    await assert.rejects(postRevaluation(id, period, feb, good, { lines: r.lines.map((l) => (l.account === '2009' ? { ...l, account: '6000' } : l)) }), orShape(/posts only to 1019, 2009 and 7100/));
    // 1019 and 2009 hold revaluation only.
    await assert.rejects(postLines(id, period, [{ account: '1019', debit: 100n, credit: 0n, currency: 'NGN', amountMinor: 100n }, { account: '7100', debit: 0n, credit: 100n, currency: 'NGN', amountMinor: 100n }], { sourceType: 'manual_journal' }),
      orShape(/1019 and 2009 hold month-end revaluation only/));
    await postRevaluation(id, period, feb, good);
  });

  /** One car's ledger history, read back from the database (what the API will hand the posting rules). */
  const historyOf = (tenant: string, v: string) => tx(tenant, async (t) => (await t.client.query<{ code: string; debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; counterparty_id: string | null }>(
    'SELECT a.code, l.debit_ngn, l.credit_ngn, l.currency, l.amount_minor, l.counterparty_id FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id = $1', [carOf(tenant, v)])).rows
    .map((r): LedgerLine => ({ account: r.code, debit: BigInt(r.debit_ngn), credit: BigInt(r.credit_ngn), currency: r.currency.trim(), amountMinor: BigInt(r.amount_minor), vehicleId: v,
      ...(r.counterparty_id && { counterpartyId: Object.entries(customers[tenant] ?? {}).find(([, cid]) => cid === r.counterparty_id)?.[0] ?? r.counterparty_id }) })));
  const ngnOn = (account: string, signed: bigint, vehicleId?: string, counterpartyId?: string): LedgerLine => ({
    account, debit: signed > 0n ? signed : 0n, credit: signed < 0n ? -signed : 0n, currency: 'NGN', amountMinor: signed < 0n ? -signed : signed,
    ...(vehicleId && { vehicleId }), ...(counterpartyId && { counterpartyId }),
  });
  const swap = (lines: LedgerLine[]) => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

  test('a car is a customer-funded job or EMM stock, never both (ledger audit of 0008)', async () => {
    const { id, period } = await funded('Job or stock', { held: false, jobs: { B: { ...CUSTOMER_JOB, price: 1_100_000n } } });
    // Job A: the customer pays, EMM pays the supplier; its completion is worked out now, before anything else happens.
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const completion = completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_500_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'A') }).lines; // FIXTURE_RATE_QUOTE
    // Posting it as stock straight away is refused; converting first is the way.
    await assert.rejects(postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['A'], funding: 'emm_funded' })), /customer-funded job: convert it to stock before/);
    const conversion = convertToStock({ ...job('A'), history: await historyOf(id, 'A') });
    await assert.rejects(postLines(id, period, conversion.filter((l) => l.account !== '2150' && l.account !== '1000')), /repays the customer's whole funds held/); // no refund: a forfeit
    await assert.rejects(postLines(id, period, conversion.map((l) => (l.account === '1200' || l.account === '1150' ? { ...l, debit: l.debit / 2n, credit: l.credit / 2n, amountMinor: l.amountMinor / 2n } : l))),
      /moves the job's whole cost/); // half the cost
    await postLines(id, period, conversion);
    // Now stock: the agent completion worked out earlier is refused, and so is any agent cost.
    await assert.rejects(postLines(id, period, completion), /job costs \(1150\).*never cross zero/); // its 1150 moved to stock
    await assert.rejects(postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['A'] })), orShape(/EMM stock \(EMM-funded or converted\): it takes no customer-funded postings/));
    // One payment split across both sides for car B: refused.
    const split = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines
      .flatMap((l) => (l.account === '1150' ? [{ ...l, debit: l.debit / 2n, amountMinor: l.amountMinor / 2n }, { ...l, account: '1200', debit: l.debit - l.debit / 2n, amountMinor: l.amountMinor - l.amountMinor / 2n }] : [l]));
    await assert.rejects(postLines(id, period, split), orShape(/never both in one entry/));
    // A completed job can't be converted afterwards, even with a late cost to move.
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 100_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines);
    await postLines(id, period, completeAgentJob({ ...job('B'), quote: { currency: 'CNY', sellingMinor: 1_100_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'B') }).lines);
    await postLines(id, period, sharedCost({ amountNgn: 1n, vehicleIds: ['B'] }));
    await assert.rejects(postLines(id, period, [ngnOn('1200', 1n, 'B'), ngnOn('1150', -1n, 'B')]), /only an open customer-funded job/);
  });

  test('a reversed mistake leaves the car as it was; no car pays for another; a clearing job never becomes stock (ledger audit of 0008, round 3)', async () => {
    const { id, period } = await funded('Reversed mistakes', { held: false, jobs: { B: { jobType: 'clearing_only', funding: 'customer_funded' }, C: EMM } });
    // Job A, converted in error, then the convert reversed: A is an open job again and completes normally.
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const conversion = convertToStock({ ...job('A'), history: await historyOf(id, 'A') });
    const conversionId = await postLines(id, period, conversion);
    await postLines(id, period, swap(conversion), { reverses: conversionId });
    // While open, A's funds can't be paid out beyond what is held, and A's costs can't pay for another car's inventory.
    await assert.rejects(postLines(id, period, [ngnOn('2150', 600_000_001n, 'A', 'A'), ngnOn('1000', -600_000_001n)]), /funds held \(2150\) never cross zero/);
    await assert.rejects(postLines(id, period, [ngnOn('1150', 100n), ngnOn('1000', -100n)]), orShape(/every job-cost, funds-held and inventory line \(1150, 2150, 1200, 1210\) names its car/));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'C', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
    await assert.rejects(postLines(id, period, [ngnOn('1200', 100_000_000n, 'C'), ngnOn('1150', -100_000_000n, 'A')]), orShape(/the same car's job costs when converting/));
    await postLines(id, period, completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_500_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'A') }).lines);
    // Car C is stock: agent income for it is refused even with nothing to cross zero.
    await assert.rejects(postLines(id, period, [ngnOn('1100', 100n, 'C', 'C'), ngnOn('4100', -100n, 'C')]), orShape(/EMM stock \(EMM-funded or converted\): it takes no customer-funded postings/));
    // Car B: a first cost posted as EMM-funded by mistake. The job says customer-funded, so it never posts (0014; before job
    // orders this slip posted and needed a reversal). B stays an ordinary customer job.
    await assert.rejects(postLines(id, period, sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['B'], funding: 'emm_funded' })), /job order \d+ is customer-funded: its car is not stock unless converted/);
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 300_000_000n }));
    await postLines(id, period, sharedCost({ amountNgn: 150_000_000n, vehicleIds: ['B'] })); // clearing-only: no supplier payment for B
    // A clearing-only job is the customer's own car: no conversion to stock. (The ledger rule refuses it too.)
    await assert.rejects(postLines(id, period, [ngnOn('1200', 150_000_000n, 'B'), ngnOn('1150', -150_000_000n, 'B'), ngnOn('2150', 300_000_000n, 'B', 'B'), ngnOn('1000', -300_000_000n)]),
      /only a car EMM paid the supplier for can be converted/);
  });

  test('a job completed at a zero cut stays completed; a conversion is undone only after the stock steps after it (ledger audit of 0008, round 4)', async () => {
    const { id, period } = await funded('Zero cut', { held: false, jobs: { A: { ...CUSTOMER_JOB, price: 4_000_000n }, B: { ...CUSTOMER_JOB, price: 2_200_000n } } });
    // Job A sold to the customer at exactly the car's quote-rate cost with no landing charge: no 4100/4200 line at all.
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const zeroCut = completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_000_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'A') }).lines;
    assert.equal(zeroCut.filter((l) => l.account === '4100' || l.account === '4200').length, 0);
    await postLines(id, period, zeroCut);
    await postLines(id, period, sharedCost({ amountNgn: 1n, vehicleIds: ['A'] })); // a late kobo of cost
    // The ledger rule can't see the completion (no 4100/4200), so the database is the guard: the delivered car never becomes stock.
    await assert.rejects(postLines(id, period, convertToStock({ ...job('A'), history: await historyOf(id, 'A') })), /only an open customer-funded job/);
    // Job B converted, then a Form M posted for it as stock: the conversion can only be undone after the Form M.
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 300_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 2_000_000n, vehicleId: 'B', spot: SPOT_CBN }).lines);
    const conversion = convertToStock({ ...job('B'), history: await historyOf(id, 'B') });
    const conversionId = await postLines(id, period, conversion);
    const formM = sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['B'], funding: 'emm_funded' });
    const formMId = await postLines(id, period, formM);
    await assert.rejects(postLines(id, period, swap(conversion), { reverses: conversionId }), /undo the car's later stock postings before reversing its conversion/);
    await postLines(id, period, swap(formM), { reverses: formMId });
    await postLines(id, period, swap(conversion), { reverses: conversionId });
    await postLines(id, period, completeAgentJob({ ...job('B'), quote: { currency: 'CNY', sellingMinor: 2_200_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'B') }).lines);
  });

  test('a conversion repays the customer in cash, exactly: none of it diverted (ledger audit of 0008, round 3)', async () => {
    const { id, period } = await funded('Convert diversion', { held: false });
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const conversion = convertToStock({ ...job('A'), history: await historyOf(id, 'A') });
    const diverted = [...conversion.filter((l) => l.account !== '1000'), ngnOn('1000', -100_000_000n), ngnOn('2000', -500_000_000n, undefined, SUPPLIER)];
    await assert.rejects(postLines(id, period, diverted), orShape(/repays the customer's whole funds held \(2150\), nothing else/));
    await postLines(id, period, conversion);
  });

  test('inventory only from real costs; corrections undo later steps first; deposits stay with their buyer (ledger audit of 0008)', async () => {
    const { id, period } = await funded('Stock corrections', { jobs: { C: EMM } });
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'C', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
    // A "cost" conjured from equity or income: refused.
    await assert.rejects(postLines(id, period, [ngnOn('1200', 100_000_000n, 'C'), ngnOn('3000', -100_000_000n)]), orShape(/paid for only from the pool \(1010\), payables \(2000\), cash \(1000\)/));
    const formM = sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['C'], funding: 'emm_funded' });
    const formMId = await postLines(id, period, formM);
    const arrival = arriveInYard({ vehicleId: 'C', history: await historyOf(id, 'C') });
    const arrivalId = await postLines(id, period, arrival);
    // The Form M was wrong: reversing it now would leave transit below zero. Reverse the arrival first, then the Form M, then arrive again.
    await assert.rejects(postLines(id, period, swap(formM), { reverses: formMId }), /never cross zero: undo later steps first/);
    await postLines(id, period, swap(arrival), { reverses: arrivalId });
    await postLines(id, period, swap(formM), { reverses: formMId });
    await postLines(id, period, arriveInYard({ vehicleId: 'C', history: await historyOf(id, 'C') }));
    // Customer A put down a deposit and walked away; customer B buys. A's deposit can't pay for B's car, and goes back to A.
    await assert.rejects(postLines(id, period, [ngnOn('1000', 1_000n), ngnOn('2100', -1_000n, 'C')]), orShape(/every deposit line \(2100\) its car and buyer/));
    await postLines(id, period, stockDeposit({ ...job('A'), vehicleId: 'C', amountNgn: 200_000_000n }));
    const sale = sellStockCar({ ...job('B'), vehicleId: 'C', priceNgn: 450_000_000n, history: await historyOf(id, 'C') });
    assert.equal(sale.find((l) => l.account === '1100')?.debit, 450_000_000n, 'B owes the whole price');
    await assert.rejects(postLines(id, period, [ngnOn('2100', 200_000_000n, 'C', 'B'), ...sale.map((l) => (l.account === '1100' ? { ...l, debit: 250_000_000n, amountMinor: 250_000_000n } : l))]),
      /a buyer's deposit \(2100\) is used or repaid only up to what that buyer paid/);
    await postLines(id, period, sale);
    await postLines(id, period, refundStockDeposit({ ...job('A'), vehicleId: 'C', amountNgn: 200_000_000n, history: await historyOf(id, 'C') }));
    const net = await netOf(id);
    assert.deepEqual([net['1200'], net['1210'], net['2100'], net['4000'], net['5000']], [0n, 0n, 0n, -450_000_000n, 320_000_000n]);
  });
  const netOf = (tenant: string) => tx(tenant, async (t) => Object.fromEntries((await t.client.query<{ code: string; net: string }>(
    'SELECT a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id GROUP BY a.code')).rows.map((r) => [r.code, BigInt(r.net)])));

  // EMM-funded stock car C (principal, ADR 0012), the ledger package's worked example through Postgres: CNY 30,000.00 from a
  // pool at 16,000,000.00 / 150,000.00 = NGN 3,200,000.00, Form M NGN 500,000.00, to the yard at 3,700,000.00, deposit
  // 2,000,000.00, sold for 4,500,000.00 -> gross profit NGN 800,000.00, inventory cleared.
  test('worked example: an EMM-funded stock car through the database, to the kobo', async () => {
    const { id, period } = await funded('Stock car', { jobs: { C: EMM } });
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'C', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
    await postLines(id, period, sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['C'], funding: 'emm_funded' }));
    await postLines(id, period, arriveInYard({ vehicleId: 'C', history: await historyOf(id, 'C') }));
    await postLines(id, period, stockDeposit({ ...job('C'), amountNgn: 200_000_000n }));
    await postLines(id, period, sellStockCar({ ...job('C'), priceNgn: 450_000_000n, history: await historyOf(id, 'C') }));
    const net = await netOf(id);
    assert.deepEqual([net['1200'], net['1210'], net['2100'], net['1100'], net['4000'], net['5000']], [0n, 0n, 0n, 250_000_000n, -450_000_000n, 370_000_000n]);
    assert.equal(net['1150'] ?? 0n, 0n, 'no agent cost account touched');
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('the app can execute no privileged (definer) function except the ones meant for it (security review of 0008)', async () => {
    // A definer function runs as the owner, past RLS: one the app could call would read or lock any tenant. Trigger functions
    // can't be called directly. Any new check function must have EXECUTE revoked, or this list changes and the test fails.
    // Every role but the owner (superuser): the app, the API and rates logins, and any role added later.
    const callable = await owner<{ who: string }>(
      `SELECT r.rolname || ': ' || p.proname AS who FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE NOT r.rolsuper AND n.nspname = 'public' AND p.prosecdef AND p.prorettype <> 'trigger'::regtype AND has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY 1`);
    assert.deepEqual(callable.rows.map((r) => r.who), []);
    // The ledger's helpers aren't definers, but are revoked too (security review of 0015): a blanket grant would show here.
    const helpers = await owner<{ who: string }>(
      `SELECT r.rolname || ': ' || p.proname AS who FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE NOT r.rolsuper AND n.nspname = 'public' AND p.proname IN ('entry_is_live', 'job_cars_completed', 'entry_line_slots') AND has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY 1`);
    assert.deepEqual(helpers.rows.map((r) => r.who), []);
  });

  test('inventory moves only whole: arrival, sale with revenue, every line naming its car', async () => {
    const { id, period } = await funded('Stock guards', { jobs: { C: EMM } });
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'C', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
    const ngnLine = (account: string, signed: bigint, vehicleId?: string): LedgerLine =>
      ({ account, debit: signed > 0n ? signed : 0n, credit: signed < 0n ? -signed : 0n, currency: 'NGN', amountMinor: signed < 0n ? -signed : signed, ...(vehicleId && { vehicleId }) });
    await assert.rejects(postLines(id, period, [ngnLine('1200', 100n), ngnLine('1000', -100n)]), orShape(/1200, 1210\) names its car/));
    // Half the car to the yard: refused. All of it: fine.
    await assert.rejects(postLines(id, period, [ngnLine('1210', 160_000_000n, 'C'), ngnLine('1200', -160_000_000n, 'C')]), orShape(/leaves transit \(1200\) only by moving its whole cost/));
    // Out of transit into an expense instead of the yard: refused.
    await assert.rejects(postLines(id, period, [ngnLine('6000', 320_000_000n), ngnLine('1200', -320_000_000n, 'C')]), orShape(/leaves transit \(1200\) only by moving its whole cost/));
    await postLines(id, period, arriveInYard({ vehicleId: 'C', history: await historyOf(id, 'C') }));
    // Written off to cost of sales without a sale, or sold at part of its cost: refused.
    await assert.rejects(postLines(id, period, [ngnLine('5000', 320_000_000n, 'C'), ngnLine('1210', -320_000_000n, 'C')]), orShape(/leaves the yard \(1210\) only when sold/));
    const sale = sellStockCar({ ...job('C'), priceNgn: 450_000_000n, history: await historyOf(id, 'C') });
    await assert.rejects(postLines(id, period, sale.map((l) => (l.account === '5000' ? { ...l, debit: l.debit - 1n, amountMinor: l.amountMinor - 1n } : l.account === '1210' ? { ...l, credit: l.credit - 1n, amountMinor: l.amountMinor - 1n } : l))),
      orShape(/leaves the yard \(1210\) only when sold/));
    // A late in-transit cost after arrival must reach the yard before the car can be sold.
    await postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['C'], funding: 'emm_funded' }));
    await assert.rejects(postLines(id, period, sale), /nothing left in transit/);
  });

  test('convert to stock through the database: the job\'s cost becomes inventory and the customer is repaid in full', async () => {
    const { id, period } = await funded('Convert to stock', { held: false });
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    await postLines(id, period, sharedCost({ amountNgn: 131_666_667n, vehicleIds: ['A'] }));
    await postLines(id, period, convertToStock({ ...job('A'), history: await historyOf(id, 'A') }));
    const net = await netOf(id);
    assert.deepEqual([net['1150'], net['2150'], net['1200']], [0n, 0n, 558_333_334n], 'NGN 5,583,333.34 is now EMM stock; the customer got back NGN 6,000,000.00');
    // The converted car then goes the stock way: to the yard and sold.
    await postLines(id, period, arriveInYard({ vehicleId: 'A', history: await historyOf(id, 'A') }));
    await postLines(id, period, sellStockCar({ ...job('A'), priceNgn: 600_000_000n, history: await historyOf(id, 'A') }));
    const after = await netOf(id);
    assert.deepEqual([after['1200'], after['1210'], after['4000'], after['5000']], [0n, 0n, -600_000_000n, 558_333_334n]);
  });

  // Job orders and the books (migration 0014, ADR 0016). The client transacts; we keep its books: the database refuses only
  // what would make them wrong or untraceable, and raises a flag as each entry commits for the rest, which stays until a
  // firm reviewer signs it off.
  const UNSIGNED = {
    A: { jobType: 'car_purchase', funding: 'customer_funded' },
    B: { jobType: 'clearing_only', funding: 'customer_funded', landing: 180_000_000n },
    C: { jobType: 'car_purchase', funding: 'emm_funded' },
  } as const;
  /** The tenant's open flags as [kind, car], cars by their test letter. */
  const flags = (tenant: string) => tx(tenant, async (t) => (await t.client.query<{ kind: string; vehicle_id: string }>(
    'SELECT kind, vehicle_id FROM job_order_exceptions ORDER BY kind, vehicle_id, flag_id')).rows
    .map((r) => [r.kind, Object.entries(cars[tenant] ?? {}).find(([, c]) => c === r.vehicle_id)?.[0]]));
  /** One more car on its own draft job in this tenant (clearing-only, or an EMM-funded car purchase), known to the helpers by its letter. */
  const draftJob = async (tenant: string, v: string, userId = USER, funding: 'customer_funded' | 'emm_funded' = 'customer_funded') => {
    const mine = cars[tenant];
    const people = customers[tenant];
    const jobs = jobIds[tenant];
    assert.ok(mine && people && jobs);
    people[v] = people.B ?? '';
    await withTenant(apiPool, as(tenant, userId), async (t) => {
      mine[v] = await one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, $2, 'Test', 'Car', 2024) RETURNING id", [tenant, `TESTCAR${v}000000000`]);
      const emm = funding === 'emm_funded'; // an EMM-funded job is always a car purchase (0014)
      jobs[v] = await one(t.client, `INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
        VALUES ($1, $2, $3, $4, $5, '2026-01-05', $6, $7, $8, $9, $10, 0) RETURNING id`,
        [tenant, people[v], emm ? 'car_purchase' : 'clearing_only', funding, emm ? 'fixture: bought ahead of a buyer' : null,
          emm ? 1_000_000n : null, emm ? 'CNY' : null, emm ? '110.000000' : null, emm ? 'manual' : null, emm ? 'FIXTURE_RATE_QUOTE' : null]);
      await t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor, landing_charge_ngn) VALUES ($1, $2, $3, $4, 0)', [tenant, jobs[v], mine[v], emm ? 1_000_000n : null]);
    });
  };

  test('the books record what the client did; only entries that would make them wrong are refused, the rest is flagged as it posts (0014)', async () => {
    const { id, period } = await funded('Job rules', { held: false, jobs: UNSIGNED });
    const { id: other, period: otherPeriod } = await funded('Job rules elsewhere', { held: false, jobs: UNSIGNED });
    const pay = async (tenant: string, v: string, funding?: 'emm_funded') =>
      payFromPool({ pool: await poolOf(tenant), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: v, spot: SPOT_CBN, ...(funding && { funding }) }).lines;
    // A car on no job order takes nothing. On a draft job its costs post (flagged), but it can't complete: the cut comes from the accepted quote.
    const mine = cars[id];
    assert.ok(mine);
    mine.Z = await tx(id, (t) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, 'TESTCARZ000000000', 'Test', 'Car', 2024) RETURNING id", [id]));
    await assert.rejects(postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['Z'] })), /must be on a job order \(not cancelled\) before anything posts/);
    await draftJob(id, 'D');
    await postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['D'] }));
    await assert.rejects(postLines(id, period, completeClearingJob({ ...job('D'), landingChargeNgn: 5_000n, history: await historyOf(id, 'D') }).lines),
      /can't complete before its quote is accepted/);
    // Customer-funded A: the client paid the supplier before its customer paid. It posts, flagged; the flag stays after the
    // customer pays (it happened) until a firm reviewer signs it off. Each tenant sees only its own flags.
    await postLines(id, period, await pay(id, 'A'));
    await postLines(other, otherPeriod, await pay(other, 'A'));
    assert.deepEqual(await flags(id), [['posted_before_quote', 'D'], ['supplier_cost_not_covered', 'A']]);
    assert.deepEqual(await flags(other), [['supplier_cost_not_covered', 'A']]);
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 106_667_667n })); // NGN 1,066,676.67: NGN 10.00 more than paid out
    assert.deepEqual(await flags(id), [['posted_before_quote', 'D'], ['supplier_cost_not_covered', 'A']]);
    await approve(id, 'A', 'supplier_cost_not_covered');
    assert.deepEqual(await flags(id), [['posted_before_quote', 'D']]);
    // Reversing the customer's receipt after the supplier was paid opens the gap again: the reversal raises its own flag.
    const otherReceipt = await postLines(other, otherPeriod, customerReceipt({ ...job('A'), amountNgn: 300_000_000n }));
    await postLines(other, otherPeriod, await pay(other, 'A')); // covered: no new flag
    assert.deepEqual(await flags(other), [['supplier_cost_not_covered', 'A']]);
    await postLines(other, otherPeriod, swap(customerReceipt({ ...job('A'), amountNgn: 300_000_000n })), { reverses: otherReceipt });
    assert.deepEqual(await flags(other), [['supplier_cost_not_covered', 'A'], ['supplier_cost_not_covered', 'A']]);
    // Customer funds come in only as cash from the job's own customer, nothing else in the entry (a bank charge is its own
    // entry): never conjured from a charge, equity or a receivable, moved from another car, or split between customers.
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 10_000_000n }));
    await postLines(id, period, [ngnOn('6100', 5_375n), ngnOn('1000', -5_375n)]); // the bank's NGN 53.75 charge on it
    for (const forged of [
      [ngnOn('1000', 9_994_625n), ngnOn('6100', 5_375n), ngnOn('2150', -10_000_000n, 'A', 'A')],
      [ngnOn('6100', 500_000_000n), ngnOn('2150', -500_000_000n, 'A', 'A')],
      [ngnOn('2150', 1_000n, 'B', 'B'), ngnOn('2150', -1_000n, 'A', 'A')],
      [ngnOn('3000', 1_000n), ngnOn('2150', -1_000n, 'A', 'A')],
      [ngnOn('1100', 1_000n, 'A', 'A'), ngnOn('2150', -1_000n, 'A', 'A')],
      [ngnOn('1000', 2_000n), ngnOn('2150', -1_000n, 'A', 'A'), ngnOn('2150', -1_000n, 'B', 'B')],
    ]) await assert.rejects(postLines(id, period, forged), orShape(/come in only by a receipt from one customer|leave only in the car's completion/)); // per car, whichever is checked first
    await assert.rejects(postLines(id, period, customerReceipt({ vehicleId: 'A', counterpartyId: 'B', amountNgn: 1_000n })), /name that job's customer/);
    // ...and leave only as a completion, a refund in cash or a conversion: a forfeit to income is refused (owner 2026-11-15),
    // and so is a cut outside a completion, or revenue that names no car.
    await assert.rejects(postLines(id, period, [ngnOn('2150', 1_000n, 'A', 'A'), ngnOn('4100', -1_000n, 'A')]), orShape(/leave only in the car's completion, a refund/));
    await assert.rejects(postLines(id, period, [ngnOn('2150', 1_000n, 'A', 'A'), ngnOn('6100', 100n), ngnOn('1000', -1_100n)]), orShape(/leave only in the car's completion, a refund/));
    await assert.rejects(postLines(id, period, [ngnOn('1100', 1_000n, 'A', 'A'), ngnOn('4100', -1_000n, 'A')]), orShape(/post only in the car's completion/));
    await assert.rejects(postLines(id, period, [ngnOn('1000', 1_000n), ngnOn('4100', -1_000n)]), orShape(/always name their car/));
    await postLines(id, period, customerRefund({ ...job('A'), amountNgn: 1_000n, history: await historyOf(id, 'A') })); // the NGN 10.00 overpaid goes back
    // Converted to stock: it posts, flagged until signed off.
    await postLines(id, period, convertToStock({ ...job('A'), history: await historyOf(id, 'A') }));
    assert.deepEqual(await flags(id), [['converted_to_stock', 'A'], ['posted_before_quote', 'D']]);
    await approve(id, 'A', 'converted_to_stock');
    // A supplier's credit note or refund brings a car's job costs down (cash back); nothing else may.
    await assert.rejects(postLines(id, period, [ngnOn('3000', 400n), ngnOn('1150', -400n, 'D')]), SHAPE);
    await postLines(id, period, supplierCredit({ vehicleId: 'D', amountNgn: 400n, history: await historyOf(id, 'D') })); // flagged for a reviewer to check against the supplier's document
    // Clearing-only B is the customer's own car: no supplier is paid for it. The database re-performs its completion from B's
    // own landing charge (NGN 1,800,000.00) and ledger (0015), so a cut moved between lines, a typed charge, or another car's
    // costs are refused; it completes once, which completes its job; a cost after it is flagged.
    await assert.rejects(postLines(id, period, await pay(id, 'B')), /clearing-only: the customer owns the car, so no supplier is paid for it/);
    await postLines(id, period, sharedCost({ amountNgn: 150_000_000n, vehicleIds: ['B'] }));
    const completion = completeClearingJob({ ...job('B'), landingChargeNgn: 180_000_000n, history: await historyOf(id, 'B') }).lines;
    const reperformed = /the completion for job order \d+ must match the car's quote and ledger: job costs cleared 150000000, funds held applied 10000000, billed 170000000, car markup 0, clearing margin 30000000, FX 0/;
    const lessCut = (by: bigint) => completion.map((l) => (l.account === '4200' ? { ...l, credit: l.credit - by, amountMinor: l.amountMinor - by } : l));
    await assert.rejects(postLines(id, period, [...lessCut(1_000n), ngnOn('4900', -1_000n)]), SHAPE); // part of the cut to car-less income
    await assert.rejects(postLines(id, period, [...lessCut(1_000n), ngnOn('7000', -1_000n, 'B')]), reperformed); // part of the cut shown as FX
    await assert.rejects(postLines(id, period, [...lessCut(400n), ngnOn('1150', -400n, 'D')]), SHAPE); // another car's costs
    await assert.rejects(postLines(id, period, completeClearingJob({ ...job('B'), landingChargeNgn: 190_000_000n, history: await historyOf(id, 'B') }).lines), reperformed); // a typed charge
    await assert.rejects(postLines(id, period, completion.map((l) => (l.account === '1150' ? { ...l, credit: 1n, amountMinor: 1n } : l.account === '4200' ? { ...l, credit: l.credit + 149_999_999n, amountMinor: l.amountMinor + 149_999_999n } : l))),
      reperformed);
    const status = async (v: string) => (await tx(id, (t) => t.client.query<{ status: string }>('SELECT status FROM job_orders WHERE id = $1', [jobIds[id]?.[v]]))).rows[0]?.status;
    assert.equal(await status('B'), 'quote_accepted');
    await assert.rejects(tx(id, (t) => t.client.query("UPDATE job_orders SET status = 'completed' WHERE id = $1", [jobIds[id]?.B])), /only the ledger completes a job/);
    await postLines(id, period, completion);
    assert.equal(await status('B'), 'completed');
    await postLines(id, period, sharedCost({ amountNgn: 1n, vehicleIds: ['B'] })); // a late kobo of cost
    assert.deepEqual(await flags(id), [['cost_after_completion', 'B'], ['cost_credited', 'D'], ['posted_before_quote', 'D'], ['posted_before_quote', 'D']]);
    await assert.rejects(postLines(id, period, completeClearingJob({ ...job('B'), landingChargeNgn: 1_000n, history: await historyOf(id, 'B') }).lines), /already completed: a car completes once/);
    for (const [v, kind] of [['B', 'cost_after_completion'], ['D', 'cost_credited']] as const) await approve(id, v, kind);
    // EMM-funded C: the client's own stock, never customer funds or job costs. Its first posting raises the flag, which stays
    // even if that posting is reversed (it was recorded); the next posting then raises it again, as the car's first live one.
    await assert.rejects(postLines(id, period, customerReceipt({ ...job('C'), amountNgn: 1_000n })), /EMM-funded: its car is stock \(1200, 1210, 2100\), never job costs/);
    await assert.rejects(postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['C'] })), /EMM-funded: its car is stock/);
    const cPaid = await pay(id, 'C', 'emm_funded');
    const cPaidId = await postLines(id, period, cPaid);
    await postLines(id, period, swap(cPaid), { reverses: cPaidId });
    await postLines(id, period, await pay(id, 'C', 'emm_funded'));
    assert.deepEqual(await flags(id), [['emm_funded', 'C'], ['emm_funded', 'C'], ['posted_before_quote', 'D'], ['posted_before_quote', 'D']]);
    await approve(id, 'C', 'emm_funded');
    // D's quote accepted later: the app can't backdate it (the database stamps the time), and D's earlier postings stay flagged.
    await tx(id, async (t) => {
      const quote = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'accepted_quote', 'application/pdf', 100, $2, 'q.pdf') RETURNING id", [id, 'c'.repeat(64)]);
      await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [quote]);
      await t.client.query('SAVEPOINT backdate');
      await assert.rejects(t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2, accepted_at = '2025-01-01' WHERE id = $1", [jobIds[id]?.D, quote]), /permission denied/);
      await t.client.query('ROLLBACK TO SAVEPOINT backdate');
      await t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [jobIds[id]?.D, quote]);
    });
    const accepted = (await tx(id, (t) => t.client.query<{ fresh: boolean }>("SELECT accepted_at > now() - interval '1 minute' AS fresh FROM job_orders WHERE id = $1", [jobIds[id]?.D]))).rows[0];
    assert.deepEqual(accepted, { fresh: true });
    assert.deepEqual(await flags(id), [['posted_before_quote', 'D'], ['posted_before_quote', 'D']]);
    await approve(id, 'D', 'posted_before_quote');
    assert.deepEqual(await flags(id), []);
    await postLines(other, otherPeriod, completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_500_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(other, 'A') }).lines);
    await postLines(other, otherPeriod, await pay(other, 'A')); // a supplier paid after the completion: a late cost, not covered
    assert.deepEqual(await flags(other), [['cost_after_completion', 'A'], ['supplier_cost_not_covered', 'A'], ['supplier_cost_not_covered', 'A'], ['supplier_cost_not_covered', 'A']]);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('every entry fits the shape of its type; a manual journal keeps off the job accounts (0015)', async () => {
    const { id, period } = await funded('Entry shapes');
    const receipt = customerReceipt({ ...job('A'), amountNgn: 1_000n });
    // An unknown type is refused, and so are the right lines under the wrong type, or a reversal that changes its type.
    await assert.rejects(postLines(id, period, receipt, { sourceType: 'deposit' }), /deposit is not an entry type/);
    await assert.rejects(postLines(id, period, receipt, { sourceType: 'customer_refund' }), /a customer_refund entry has no place for that line on 1000/);
    const receiptId = await postLines(id, period, receipt);
    await assert.rejects(postLines(id, period, swap(receipt), { reverses: receiptId, sourceType: 'customer_refund' }), /a reversal keeps the entry type of the entry it reverses/);
    await postLines(id, period, swap(receipt), { reverses: receiptId });
    // Who a line names is checked against the counterparty itself: customer funds never name the supplier.
    await assert.rejects(postLines(id, period, customerReceipt({ vehicleId: 'A', counterpartyId: SUPPLIER, amountNgn: 1_000n })), /a customer_receipt entry has no place for that line on 2150/);
    // Each slot holds as many lines as its type allows; only a car cost splits over several cars.
    await assert.rejects(postLines(id, period, [...receipt, ...receipt]), /a customer_receipt entry holds 1 to 1 "cash" line\(s\)/);
    await postLines(id, period, sharedCost({ amountNgn: 3n, vehicleIds: ['A', 'B', 'C'] }));
    const paid = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    await assert.rejects(postLines(id, period, paid.map((l) => (l.account === '1010' ? { ...l, vehicleId: 'B' } : l))), /a pool_payment entry is for one car/);
    // Manual journals: an NGN supplier bill for a general expense posts; a car, the job accounts or a foreign payable never.
    await postLines(id, period, [ngnOn('6000', 5_000n), ngnOn('2000', -5_000n, undefined, SUPPLIER)], { sourceType: 'manual_journal' });
    for (const forged of [
      [ngnOn('6100', 1_000n, 'A'), ngnOn('1000', -1_000n)],
      [ngnOn('1150', 1_000n), ngnOn('1000', -1_000n)],
      [ngnOn('3000', 1_000n), ngnOn('4100', -1_000n)],
      [ngnOn('2150', 1_000n), ngnOn('3000', -1_000n)],
      [ngnOn('7100', 1_000n), ngnOn('3000', -1_000n)],
      [ngnOn('6100', 1_000n), ngnOn('1100', -1_000n)],
    ]) await assert.rejects(postLines(id, period, forged, { sourceType: 'manual_journal' }), /a manual journal names no car and keeps off the accounts the posting rules own/);
    // The shapes are the owner's: the app can't read or change them.
    await assert.rejects(tx(id, (t) => t.client.query('SELECT 1 FROM entry_shapes')), /permission denied/);
    await assert.rejects(tx(id, (t) => t.client.query('DELETE FROM entry_shapes')), /permission denied/);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
  });

  test("worked example: each car's cut re-performed from its own price and landing charge; the job completes with its last car (0015)", async () => {
    // One job order for two cars, X (CNY 45,000.00, landing NGN 1,500,000.00) and Y (CNY 25,000.00, landing NGN 1,000,000.00),
    // quoted at FIXTURE_RATE_QUOTE (110). Pool: CNY 150,000.00 for NGN 16,000,000.00 (average 106.666666..).
    //   X: paid CNY 40,000.00 = NGN 4,266,666.67; container NGN 1,000,000.01 split X 500,000.01, Y 500,000.00.
    //      markup (45,000 - 40,000) x 110 = 550,000.00; FX 40,000 x 110 - 4,266,666.67 = 133,333.33;
    //      margin 1,500,000.00 - 500,000.01 = 999,999.99; bill 4,950,000.00 + 1,500,000.00 = 6,450,000.00, from funds held 6,000,000.00, owed 450,000.00.
    //   Y: paid CNY 20,000.00 from a pool now CNY 110,000.00 / NGN 11,733,333.33 = NGN 2,133,333.33.
    //      markup (25,000 - 20,000) x 110 = 550,000.00; FX 20,000 x 110 - 2,133,333.33 = 66,666.67;
    //      margin 1,000,000.00 - 500,000.00 = 500,000.00; bill 2,750,000.00 + 1,000,000.00 = 3,750,000.00, all from funds held 4,000,000.00.
    const { id, period } = await funded('Two-car job', { held: false });
    const mine = cars[id];
    const people = customers[id];
    const jobs = jobIds[id];
    assert.ok(mine && people && jobs);
    const jobId = await tx(id, async (t) => {
      const quote = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'accepted_quote', 'application/pdf', 100, $2, 'q.pdf') RETURNING id", [id, 'd'.repeat(64)]);
      await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [quote]);
      const j = await one(t.client, `INSERT INTO job_orders (tenant_id, customer_id, job_type, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
        VALUES ($1, $2, 'car_purchase', '2026-01-05', 7000000, 'CNY', '110.000000', 'manual', 'FIXTURE_RATE_QUOTE', 250000000) RETURNING id`, [id, people.A]);
      for (const [v, price, landing] of [['X', 4_500_000n, 150_000_000n], ['Y', 2_500_000n, 100_000_000n]] as const) {
        mine[v] = await one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, $2, 'Test', 'Car', 2024) RETURNING id", [id, `TESTCAR${v}000000000`]);
        people[v] = people.A ?? '';
        jobs[v] = j;
        await t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor, landing_charge_ngn) VALUES ($1, $2, $3, $4, $5)', [id, j, mine[v], price, landing]);
      }
      await t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [j, quote]);
      return j;
    });
    const status = async () => (await tx(id, (t) => t.client.query<{ status: string }>('SELECT status FROM job_orders WHERE id = $1', [jobId]))).rows[0]?.status;
    const quoteOf = (sellingMinor: bigint, landingChargeNgn: bigint) => ({ currency: 'CNY', sellingMinor, rate: parseRate('110.000000'), landingChargeNgn }); // FIXTURE_RATE_QUOTE
    await postLines(id, period, customerReceipt({ ...job('X'), amountNgn: 600_000_000n }));
    await postLines(id, period, customerReceipt({ ...job('Y'), amountNgn: 400_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'X', spot: SPOT_CBN }).lines);
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 2_000_000n, vehicleId: 'Y', spot: SPOT_CBN }).lines);
    await postLines(id, period, sharedCost({ amountNgn: 100_000_001n, vehicleIds: ['X', 'Y'] }));
    const doneX = completeAgentJob({ ...job('X'), quote: quoteOf(4_500_000n, 150_000_000n), history: await historyOf(id, 'X') }).lines;
    const net = (lines: LedgerLine[]) => Object.fromEntries(lines.map((l) => [l.account, l.debit - l.credit]));
    assert.deepEqual(net(doneX), { 2150: 600_000_000n, 1100: 45_000_000n, 1150: -476_666_668n, 4100: -55_000_000n, 4200: -99_999_999n, 7000: -13_333_333n });
    // An FX gain shown as markup, Y's price and landing charge on X, or a typed price: refused, though each balances.
    const x = /the completion for job order \d+ must match the car's quote and ledger: job costs cleared 476666668, funds held applied 600000000, billed 45000000, car markup 55000000, clearing margin 99999999, FX 13333333/;
    const swapped = doneX.map((l) => (l.account === '4100' ? { ...l, account: '7000' } : l.account === '7000' ? { ...l, account: '4100' } : l));
    await assert.rejects(postLines(id, period, swapped), x);
    await assert.rejects(postLines(id, period, completeAgentJob({ ...job('X'), quote: quoteOf(2_500_000n, 100_000_000n), history: await historyOf(id, 'X') }).lines), x);
    await assert.rejects(postLines(id, period, completeAgentJob({ ...job('X'), quote: quoteOf(4_500_001n, 150_000_000n), history: await historyOf(id, 'X') }).lines), x);
    await postLines(id, period, doneX);
    assert.equal(await status(), 'quote_accepted'); // Y is still open
    const doneY = completeAgentJob({ ...job('Y'), quote: quoteOf(2_500_000n, 100_000_000n), history: await historyOf(id, 'Y') }).lines;
    assert.deepEqual(net(doneY), { 2150: 375_000_000n, 1150: -263_333_333n, 4100: -55_000_000n, 4200: -50_000_000n, 7000: -6_666_667n });
    const doneYId = await postLines(id, period, doneY);
    assert.equal(await status(), 'completed');
    // Reversing Y's completion reopens the job; completing it again closes it. Y's leftover NGN 250,000.00 goes back to the customer.
    await postLines(id, period, swap(doneY), { reverses: doneYId });
    assert.equal(await status(), 'quote_accepted');
    await postLines(id, period, doneY);
    assert.equal(await status(), 'completed');
    await postLines(id, period, customerRefund({ ...job('Y'), amountNgn: 25_000_000n, history: await historyOf(id, 'Y') }));
    // X's customer settles the NGN 450,000.00 owed.
    await postLines(id, period, receivableReceipt({ vehicleId: 'X', counterpartyId: 'A', amountNgn: 45_000_000n, history: await historyOf(id, 'X') })); // X's customer is A's (historyOf names a customer by its first letter)
    const left = await tx(id, async (t) => (await t.client.query<{ code: string; net: string }>(
      "SELECT a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id = ANY ($1) AND a.code IN ('1100', '1150', '2150') GROUP BY a.code ORDER BY a.code",
      [[mine.X, mine.Y]])).rows);
    assert.deepEqual(left, [{ code: '1100', net: '0' }, { code: '1150', net: '0' }, { code: '2150', net: '0' }]);
    assert.deepEqual(await flags(id), []);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('job fuzz: random postings through every rule keep each car exactly as the rules say; tampered and mistyped entries are refused (0015)', { timeout: 900_000 }, async () => {
    let seed = 20261117n;
    const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed >> 11n) % max);
    const pickOf = <T,>(xs: readonly T[]): T => xs[Number(rnd(BigInt(xs.length)))] as T;
    const { id, period } = await freshTenant('Job fuzz');
    await jobsFor(id);
    type Car = { v: string; kind: 'agent' | 'clearing' | 'stock'; price: bigint; landing: bigint; viaInvoice: boolean; stage: 'open' | 'completed' | 'transit' | 'yard' | 'sold' };
    const fleet: Car[] = [];
    const mine = cars[id];
    const people = customers[id];
    const jobs = jobIds[id];
    assert.ok(mine && people && jobs);
    await tx(id, async (t) => {
      for (let i = 0; i < 200; i++) {
        const v = `F${String(i)}`;
        const kind = pickOf(['agent', 'agent', 'agent', 'clearing', 'stock'] as const);
        const purchase = kind !== 'clearing';
        const price = rnd(5_000_000n) + 1_000_000n; // CNY 10,000.00-60,000.00
        const landing = rnd(200_000_000n); // NGN 0-2,000,000.00
        people[v] = await one(t.client, "INSERT INTO counterparties (tenant_id, kind, name) VALUES ($1, 'customer', $2) RETURNING id", [id, `Customer ${v}`]);
        mine[v] = await one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, $2, 'Test', 'Car', 2024) RETURNING id", [id, `FUZZCAR${String(i).padStart(10, '0')}`]);
        const quote = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'accepted_quote', 'application/pdf', 100, $2, 'q.pdf') RETURNING id",
          [id, String(i).padStart(64, 'f')]);
        await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [quote]);
        jobs[v] = await one(t.client,
          `INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
           VALUES ($1, $2, $3, $4, $5, '2026-01-05', $6, $7, $8, $9, $10, $11) RETURNING id`,
          [id, people[v], purchase ? 'car_purchase' : 'clearing_only', kind === 'stock' ? 'emm_funded' : 'customer_funded', kind === 'stock' ? 'fixture: bought ahead of a buyer' : null,
            purchase ? price : null, purchase ? 'CNY' : null, purchase ? '110.000000' : null, purchase ? 'manual' : null, purchase ? 'FIXTURE_RATE_QUOTE' : null, landing]);
        await t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor, landing_charge_ngn) VALUES ($1, $2, $3, $4, $5)',
          [id, jobs[v], mine[v], purchase ? price : null, landing]);
        await t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [jobs[v], quote]);
        fleet.push({ v, kind, price, landing, viaInvoice: kind === 'agent' && rnd(3n) === 0n, stage: kind === 'stock' ? 'transit' : 'open' });
      }
    });

    // Everything posted, as the rules built it; balances are read back from here, the way the API reads the ledger.
    const all: LedgerLine[] = [];
    const sum = (f: (l: LedgerLine) => boolean, by: (l: LedgerLine) => bigint) => all.filter(f).reduce((s, l) => s + by(l), 0n);
    const pool = () => ({
      balanceMinor: sum((l) => l.account === '1010' && l.currency === 'CNY', (l) => (l.debit > 0n ? l.amountMinor : -l.amountMinor)),
      costNgn: sum((l) => l.account === '1010' && l.currency === 'CNY', (l) => l.debit - l.credit),
    });
    const payable = (v: string) => ({
      balanceMinor: sum((l) => l.account === '2000' && l.vehicleId === v && l.currency === 'CNY', (l) => (l.credit > 0n ? l.amountMinor : -l.amountMinor)),
      costNgn: sum((l) => l.account === '2000' && l.vehicleId === v && l.currency === 'CNY', (l) => l.credit - l.debit),
    });
    const bal = (v: string, account: string) => sum((l) => l.vehicleId === v && l.account === account, (l) => l.debit - l.credit);
    const TYPES = ['customer_receipt', 'customer_refund', 'receivable_receipt', 'currency_purchase', 'pool_payment', 'supplier_invoice', 'supplier_settlement', 'car_cost',
      'supplier_credit', 'job_completion', 'stock_deposit', 'stock_deposit_refund', 'yard_arrival', 'stock_sale', 'stock_conversion', 'fx_revaluation', 'manual_journal'];
    let posted = 0;
    let refused = 0;
    let reversed = 0;
    /** Post one rule's lines; one in thirty is reversed straight away (a mistake corrected). Resolves to whether it stands. */
    const post = async (sourceType: string, lines: LedgerLine[]) => {
      if (rnd(25n) === 0n) { // the same lines under another type never fit
        await assert.rejects(postLines(id, period, lines, { sourceType: pickOf(TYPES.filter((x) => x !== sourceType)) }), SHAPE);
        refused++;
      }
      const entryId = await postLines(id, period, lines, { sourceType });
      all.push(...lines);
      posted++;
      if (sourceType === 'supplier_invoice' || rnd(30n) !== 0n) return true;
      await postLines(id, period, swap(lines), { reverses: entryId });
      all.push(...swap(lines));
      reversed++;
      return false;
    };
    const cash = () => rnd(300_000_000n) + 1n;

    const N = 8_000;
    for (let step = 0; step < N; step++) {
      if (pool().balanceMinor < 2_000_000n || rnd(15n) === 0n) {
        const rateScaled = rnd(150n * RATE_SCALE) + 50n * RATE_SCALE; // fixture range (50-200) for property testing, not real rates
        await post('currency_purchase', buyCurrency({ currency: 'CNY', amountMinor: rnd(10_000_000n) + 1_000_000n, rate: rateScaled, rateSource: 'bdc_receipt' }));
        continue;
      }
      const c = pickOf(fleet);
      const held = -bal(c.v, '2150');
      const choice = rnd(10n);
      if (c.kind !== 'stock' && c.stage === 'open') {
        const carMinor = sum((l) => l.vehicleId === c.v && l.currency === 'CNY' && (l.account === '1010' || (l.account === '2000' && l.rateSource === 'agent_invoice')), (l) => (l.credit > 0n ? l.amountMinor : -l.amountMinor));
        if (choice < 3n) await post('customer_receipt', customerReceipt({ ...job(c.v), amountNgn: cash() }));
        else if (choice < 5n && c.kind === 'agent' && !c.viaInvoice) {
          const amountMinor = rnd(pool().balanceMinor / 2n) + 10_000n;
          await post('pool_payment', payFromPool({ pool: pool(), currency: 'CNY', amountMinor, vehicleId: c.v, spot: SPOT_CBN }).lines);
        } else if (choice < 5n && c.kind === 'agent') {
          const owed = payable(c.v);
          if (owed.balanceMinor === 0n || rnd(2n) === 0n) {
            const rate = rnd(150n * RATE_SCALE) + 50n * RATE_SCALE; // fixture range, as above
            await post('supplier_invoice', supplierInvoice({ vehicleId: c.v, supplierId: SUPPLIER, currency: 'CNY', amountMinor: rnd(3_000_000n) + 10_000n, rate, spot: SPOT_CBN }));
          } else {
            const cap = owed.balanceMinor < pool().balanceMinor ? owed.balanceMinor : pool().balanceMinor;
            await post('supplier_settlement', payPayableFromPool({ vehicleId: c.v, supplierId: SUPPLIER, pool: pool(), payable: owed, currency: 'CNY', amountMinor: rnd(cap) + 1n, spot: SPOT_CBN }).lines);
          }
        } else if (choice < 7n) {
          const open = fleet.filter((o) => o.kind !== 'stock' && o.stage === 'open' && o.v !== c.v);
          const others = open.length > 0 && rnd(2n) === 0n ? [pickOf(open).v] : [];
          await post('car_cost', sharedCost({ amountNgn: rnd(50_000_000n) + 3n, vehicleIds: [c.v, ...others] }));
        } else if (choice < 8n && rnd(4n) === 0n && bal(c.v, '1150') > 1n) {
          await post('supplier_credit', supplierCredit({ vehicleId: c.v, amountNgn: rnd(bal(c.v, '1150') / 2n) + 1n, history: all }));
        } else if (choice < 8n && held > 0n) {
          await post('customer_refund', customerRefund({ ...job(c.v), amountNgn: rnd(held) + 1n, history: all }));
        } else if (choice === 9n && rnd(3n) === 0n && bal(c.v, '1150') > 0n && (c.kind === 'clearing' || carMinor > 0n)) {
          const done = c.kind === 'agent'
            ? completeAgentJob({ ...job(c.v), quote: { currency: 'CNY', sellingMinor: c.price, rate: parseRate('110.000000'), landingChargeNgn: c.landing }, history: all }).lines // FIXTURE_RATE_QUOTE
            : completeClearingJob({ ...job(c.v), landingChargeNgn: c.landing, history: all }).lines;
          // A kobo moved between two lines the completion already has (cut to FX, markup to margin, bill to funds held):
          // it still fits the shape and balances, so only the re-performance can refuse it.
          const bump = (ls: LedgerLine[], account: string, by: bigint) => ls.map((l) => (l.account !== account ? l
            : l.credit > 0n ? { ...l, credit: l.credit + by, amountMinor: l.amountMinor + by } : { ...l, debit: l.debit - by, amountMinor: l.amountMinor - by }));
          const sound = (ls: LedgerLine[]) => ls.every((l) => (l.debit > 0n) !== (l.credit > 0n));
          const pair = pickOf([['4100', '7000'], ['4200', '7000'], ['4100', '4200'], ['1100', '2150']] as const);
          if (rnd(4n) === 0n && pair.every((acc) => done.some((l) => l.account === acc))) {
            const tampered = bump(bump(done, pair[0], -1n), pair[1], 1n);
            if (sound(tampered)) {
              await assert.rejects(postLines(id, period, tampered, { sourceType: 'job_completion' }), /must match the car's quote and ledger/);
              refused++;
            }
          }
          if (await post('job_completion', done)) c.stage = 'completed';
        }
      } else if (c.stage === 'completed') {
        const owed = bal(c.v, '1100');
        if (choice < 5n && owed > 0n) await post('receivable_receipt', receivableReceipt({ ...job(c.v), amountNgn: rnd(owed) + 1n, history: all }));
        else if (held > 0n) await post('customer_refund', customerRefund({ ...job(c.v), amountNgn: held, history: all }));
      } else if (c.stage === 'transit') {
        const paidFor = sum((l) => l.vehicleId === c.v && l.account === '1010', (l) => l.credit - l.debit) > 0n;
        if (choice < 4n) {
          await post('pool_payment', payFromPool({ pool: pool(), currency: 'CNY', amountMinor: rnd(pool().balanceMinor / 2n) + 10_000n, vehicleId: c.v, spot: SPOT_CBN, funding: 'emm_funded' }).lines);
        } else if (choice < 7n) {
          await post('car_cost', sharedCost({ amountNgn: rnd(50_000_000n) + 1n, vehicleIds: [c.v], funding: 'emm_funded' }));
        } else if (paidFor) {
          if (await post('yard_arrival', arriveInYard({ vehicleId: c.v, history: all }))) c.stage = 'yard';
        }
      } else if (c.stage === 'yard') {
        const deposits = -bal(c.v, '2100');
        if (choice < 4n) await post('stock_deposit', stockDeposit({ ...job(c.v), amountNgn: cash() }));
        else if (choice < 6n && deposits > 0n) await post('stock_deposit_refund', refundStockDeposit({ ...job(c.v), amountNgn: rnd(deposits) + 1n, history: all }));
        else if (choice === 9n && rnd(3n) === 0n) {
          if (await post('stock_sale', sellStockCar({ ...job(c.v), priceNgn: deposits + rnd(500_000_000n) + 1n, history: all }))) c.stage = 'sold';
        }
      }
    }

    // The database holds exactly what the rules built, car by car and account by account.
    const rows = (await tx(id, (t) => t.client.query<{ vehicle_id: string; code: string; net: string }>(
      'SELECT l.vehicle_id, a.code, sum(l.debit_ngn - l.credit_ngn)::text AS net FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id IS NOT NULL GROUP BY 1, 2'))).rows;
    const letter = new Map(Object.entries(mine).map(([v, uuid]) => [uuid, v]));
    const fromDb = Object.fromEntries(rows.filter((r) => r.net !== '0').map((r) => [`${letter.get(r.vehicle_id) ?? '?'} ${r.code}`, BigInt(r.net)]));
    const nets = new Map<string, bigint>();
    for (const l of all) if (l.vehicleId) nets.set(`${l.vehicleId} ${l.account}`, (nets.get(`${l.vehicleId} ${l.account}`) ?? 0n) + l.debit - l.credit);
    assert.deepEqual(fromDb, Object.fromEntries([...nets].filter(([, n]) => n !== 0n)));
    // Every completed car's job is completed with its job costs cleared; customer funds and the pool never went below zero.
    const statuses = (await tx(id, (t) => t.client.query<{ id: string; status: string }>('SELECT id, status FROM job_orders'))).rows;
    for (const c of fleet) {
      assert.equal(statuses.find((s) => s.id === jobs[c.v])?.status, c.stage === 'completed' ? 'completed' : 'quote_accepted', c.v);
      if (c.stage === 'completed') assert.equal(bal(c.v, '1150'), 0n, c.v);
      assert.ok(bal(c.v, '2150') <= 0n, c.v);
    }
    assert.ok(pool().balanceMinor >= 0n);
    assert.ok(fleet.filter((c) => c.stage === 'completed').length > 10 && fleet.some((c) => c.stage === 'sold'), 'the walk reached completions and sales');
    assert.ok(posted > 3_000 && refused > 120 && reversed > 50, `posted ${String(posted)}, refused ${String(refused)}, reversed ${String(reversed)}`);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n, 'trial balance nets to zero');
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('worked example: half-kobo ties round up; receivables never go below zero or name another customer; a negative cut is flagged (ledger audit of 0015)', async () => {
    // Car A: CNY 45,000.01 quoted at FIXTURE_RATE_QUOTE_TIE (108.5), landing NGN 0.00. A USD 1,000.00 payment made by mistake
    // and reversed, then CNY 40,000.01 from the pool (CNY 150,000.00 for NGN 16,000,000.00):
    //   4,000,001 x 1,600,000,000 / 15,000,000 = 426,666,773.33 -> NGN 4,266,667.73 paid
    //   price 4,500,001 x 108.5 = 488,250,108.5 -> 488,250,109 (a tie, half-up); cost at quote 4,000,001 x 108.5 = 434,000,108.5 -> 434,000,109
    //   markup 488,250,109 - 434,000,109 = NGN 542,500.00; FX 434,000,109 - 426,666,773 = NGN 73,333.36; all from funds held.
    // Car B (clearing-only, landing NGN 1,000,000.00) costs NGN 1,500,000.00: its margin is -NGN 500,000.00, flagged.
    const { id, period } = await funded('Audit of 0015', { held: false, jobs: {
      A: { ...CUSTOMER_JOB, price: 4_500_001n, rate: '108.500000' }, // FIXTURE_RATE_QUOTE_TIE
      B: { jobType: 'clearing_only', funding: 'customer_funded', landing: 100_000_000n },
    } });
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, buyCurrency({ currency: 'USD', amountMinor: 100_000n, rate: parseRate('1500.000000'), rateSource: 'manual', rateNote: 'FIXTURE_RATE_USD' }));
    const usd = payFromPool({ pool: { balanceMinor: 100_000n, costNgn: 150_000_000n }, currency: 'USD', amountMinor: 100_000n, vehicleId: 'A',
      spot: { rate: parseRate('1500.000000'), source: 'manual' }, rateNote: 'FIXTURE_RATE_USD: wrong currency, reversed' }).lines;
    const usdId = await postLines(id, period, usd);
    await postLines(id, period, swap(usd), { reverses: usdId });
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_001n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const doneA = completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 4_500_001n, rate: parseRate('108.500000'), landingChargeNgn: 0n }, history: await historyOf(id, 'A') }).lines;
    assert.deepEqual(Object.fromEntries(doneA.map((l) => [l.account, l.debit - l.credit])), { 2150: 488_250_109n, 1150: -426_666_773n, 4100: -54_250_000n, 7000: -7_333_336n });
    await postLines(id, period, doneA);
    // B: nothing is owed before its completion, so no receivable receipt yet; after it, only B's own customer pays, up to what they owe.
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 10_000_000n }));
    await postLines(id, period, sharedCost({ amountNgn: 150_000_000n, vehicleIds: ['B'] }));
    const owes = /what a customer owes for a car \(1100\) is paid only up to what they owe/;
    await assert.rejects(postLines(id, period, [ngnOn('1000', 1_000n), ngnOn('1100', -1_000n, 'B', 'B')]), owes); // a deposit booked as a receivable
    const doneB = completeClearingJob({ ...job('B'), landingChargeNgn: 100_000_000n, history: await historyOf(id, 'B') }).lines;
    const doneBId = await postLines(id, period, doneB);
    await assert.rejects(postLines(id, period, [ngnOn('1000', 90_000_000n), ngnOn('1100', -90_000_000n, 'B', 'A')]), owes); // A owes nothing for B
    await assert.rejects(postLines(id, period, [ngnOn('1000', 90_000_001n), ngnOn('1100', -90_000_001n, 'B', 'B')]), owes);
    await postLines(id, period, receivableReceipt({ ...job('B'), amountNgn: 90_000_000n, history: await historyOf(id, 'B') }));
    // Undoing B's completion now would leave the customer's payment with no bill: reverse the payment first.
    await assert.rejects(postLines(id, period, swap(doneB), { reverses: doneBId }), owes);
    // More money in from B's customer after the completion: it posts, flagged (most likely meant for a balance owed).
    await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 1_000n }));
    // C: the supplier credits NGN 20,000.00, then the customer walks away: the car still converts to stock (it never completed).
    await postLines(id, period, customerReceipt({ ...job('C'), amountNgn: 200_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'C', spot: SPOT_CBN }).lines);
    await postLines(id, period, sharedCost({ amountNgn: 5_000_000n, vehicleIds: ['C'] }));
    await postLines(id, period, supplierCredit({ vehicleId: 'C', amountNgn: 2_000_000n, history: await historyOf(id, 'C') }));
    await postLines(id, period, convertToStock({ ...job('C'), history: await historyOf(id, 'C') }));
    assert.deepEqual(await flags(id), [['converted_to_stock', 'C'], ['cost_credited', 'C'], ['funds_after_completion', 'B'], ['negative_cut', 'B']]);
    const tb = await trialBalance(id);
    assert.equal(tb.dr - tb.cr, 0n);
    assert.deepEqual(await chainBreaks(id), []);
  });

  test('a car sold to its customer below its cost at the quote rate posts a negative markup, flagged (ledger audit of 0015)', async () => {
    // Car A quoted CNY 30,000.00 at FIXTURE_RATE_QUOTE (110) but paid CNY 40,000.00: markup (30,000 - 40,000) x 110 = -NGN 1,100,000.00.
    const { id, period } = await funded('Negative markup', { held: false, jobs: { A: { ...CUSTOMER_JOB, price: 3_000_000n } } });
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 600_000_000n }));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    const done = completeAgentJob({ ...job('A'), quote: { currency: 'CNY', sellingMinor: 3_000_000n, rate: parseRate('110.000000'), landingChargeNgn: 0n }, history: await historyOf(id, 'A') }).lines;
    assert.equal(done.find((l) => l.account === '4100')?.debit, 110_000_000n);
    await postLines(id, period, done);
    assert.deepEqual(await flags(id), [['negative_cut', 'A']]);
  });

  test("four eyes: a reviewer who uploaded a receipt's evidence doesn't sign off that car's flags (0016)", async () => {
    const { id, period } = await funded('Four eyes on evidence', { held: false });
    // The client paid the supplier for A before its customer paid: flagged.
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    // The firm reviewer uploads the customer's bank slip; the receipt carries it on its cash line, which names no car.
    const slip = await withTenant(apiPool, as(id, REVIEWER), async (t) => {
      const d = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'slip.pdf') RETURNING id", [id, randomHex()]);
      await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [d]);
      return d;
    });
    await postLines(id, period, customerReceipt({ ...job('A'), amountNgn: 200_000_000n, evidenceDocumentId: slip }));
    await assert.rejects(approve(id, 'A', 'supplier_cost_not_covered'), /signed off by someone who touched nothing it is about/);
  });

  test('evidence: foreign lines need theirs; anything else without it is pending until attached; shared slips are listed for review (0017)', async () => {
    const { id, period } = await funded('Evidence rules', { held: false, jobs: { B: { jobType: 'clearing_only', funding: 'customer_funded', landing: 100_000_000n } } });
    const doc = (sha = randomHex()) => tx(id, async (t) => {
      const d = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'r.pdf') RETURNING id", [id, sha]);
      await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [d]);
      return d;
    });
    const pending = async () => (await tx(id, (t) => t.client.query<{ entry_id: string }>('SELECT entry_id FROM entries_missing_evidence ORDER BY entry_date, entry_id'))).rows.map((r) => r.entry_id);
    const shared = async () => (await tx(id, (t) => t.client.query<{ entry_ids: string[] }>('SELECT entry_ids FROM evidence_shared'))).rows.map((r) => [...r.entry_ids].sort());
    const attach = (entryId: string, documentId: string) => tx(id, (t) => t.client.query('INSERT INTO entry_evidence (tenant_id, entry_id, document_id) VALUES ($1, $2, $3)', [id, entryId, documentId]));
    // A foreign line without its document is refused: its rate is provable only from it.
    await assert.rejects(postLines(id, period, buyCurrency({ currency: 'CNY', amountMinor: 1_000_000n, rate: parseRate('100.000000'), rateSource: 'bdc_receipt' }), { fixtureEvidence: false }),
      /journal_lines_foreign_evidence/);
    assert.deepEqual(await pending(), []); // funded()'s purchases carry their receipts
    // An NGN receipt without its slip posts, pending; attaching the slip clears it, once.
    const bare = await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 5_000_000n }));
    assert.deepEqual(await pending(), [bare]);
    await assert.rejects(attach(bare, (await tx(id, (t) => one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'p.pdf') RETURNING id", [id, randomHex()])))),
      /evidence must be a stored document/); // a pending upload
    const slip = await doc();
    await attach(bare, slip);
    assert.deepEqual(await pending(), []);
    await assert.rejects(attach(bare, await doc()), /already has its evidence, or takes none/);
    // One transfer paying for two things is two entries on one slip: both post, and the slip is listed for a reviewer. The
    // same bytes uploaded again count as the same slip.
    const second = await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 2_000_000n, evidenceDocumentId: slip }));
    assert.deepEqual(await shared(), [[bare, second].sort()]);
    const sha = (await tx(id, (t) => t.client.query<{ sha256: string }>('SELECT sha256 FROM documents WHERE id = $1', [slip]))).rows[0]?.sha256 ?? '';
    const third = await postLines(id, period, customerReceipt({ ...job('B'), amountNgn: 1_000_000n, evidenceDocumentId: await doc(sha) }));
    assert.deepEqual(await shared(), [[bare, second, third].sort()]);
    // A correction: reversing the second receipt releases its slip, so the corrected receipt takes it and nothing extra is shared.
    await postLines(id, period, swap(customerReceipt({ ...job('B'), amountNgn: 2_000_000n, evidenceDocumentId: slip })), { reverses: second });
    assert.deepEqual(await shared(), [[bare, third].sort()]);
    // A completion takes no evidence of its own (the accepted quote is its evidence); a cost does.
    const cost = await postLines(id, period, sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['B'] }));
    const done = await postLines(id, period, completeClearingJob({ ...job('B'), landingChargeNgn: 100_000_000n, history: await historyOf(id, 'B') }).lines);
    assert.deepEqual(await pending(), [cost]);
    await assert.rejects(attach(done, await doc()), /already has its evidence, or takes none/);
    // Four eyes: the reviewer who attaches the cost's invoice doesn't sign off the car's flags.
    await withTenant(apiPool, as(id, REVIEWER), (t) => t.client.query('INSERT INTO entry_evidence (tenant_id, entry_id, document_id) VALUES ($1, $2, $3)', [id, cost, slip]));
    await postLines(id, period, sharedCost({ amountNgn: 1n, vehicleIds: ['B'], evidenceDocumentId: await doc() })); // a late cost: flagged
    await assert.rejects(approve(id, 'B', 'cost_after_completion'), /signed off by someone who touched nothing it is about/);
  });

  test('a sign-off answers one flag, by a firm reviewer or admin who touched nothing the flag is about (0014)', async () => {
    const { id, period } = await funded('Sign-offs', { held: false, jobs: UNSIGNED });
    const { id: elsewhere } = await freshTenant('Sign-offs elsewhere');
    const flagOf = async (v: string, kind: string) => (await tx(id, (t) => t.client.query<{ flag_id: string }>(
      'SELECT flag_id FROM job_order_exceptions WHERE vehicle_id = $1 AND kind = $2', [cars[id]?.[v], kind]))).rows[0]?.flag_id;
    const insert = (userId: string, tenant: string, flagId: string | undefined, extra = '', reason = 'fixture sign-off') =>
      withTenant(apiPool, as(tenant, userId), (t) => t.client.query(
        `INSERT INTO job_order_sign_offs (tenant_id, flag_id, reason${extra ? ', signed_by' : ''}) VALUES ($1, $2, $3${extra ? ', $4' : ''})`,
        [tenant, flagId, reason, ...(extra ? [extra] : [])]));
    const postAs = (userId: string, lines: LedgerLine[]) => withTenant(apiPool, as(id, userId), (t) => insertPosting(t.client, id, period, lines));
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'C', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
    await postLines(id, period, payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines);
    // Not a signer here: a client user, a firm accountant of this business, a firm reviewer of another business.
    await owner("INSERT INTO firm_staff (clerk_user_id) VALUES ('user_accountant'), ('user_elsewhere'), ('user_firm_admin') ON CONFLICT DO NOTHING");
    await owner(`INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_accountant', 'firm_accountant', 'test'),
      ($2, 'user_elsewhere', 'firm_reviewer', 'test'), ($1, 'user_firm_admin', 'firm_admin', 'test')`, [id, elsewhere]);
    for (const who of [USER, 'user_accountant', 'user_elsewhere']) await assert.rejects(approve(id, 'C', 'emm_funded', who), /only a firm reviewer or firm admin for this business can sign off/);
    // A firm admin signs off too (owner, 2026-11-17), but never what they touched: a job they created, a car they recorded for.
    await draftJob(id, 'E', 'user_firm_admin', 'emm_funded');
    await postLines(id, period, sharedCost({ amountNgn: 1_000n, vehicleIds: ['E'], funding: 'emm_funded' }));
    await assert.rejects(approve(id, 'E', 'emm_funded', 'user_firm_admin'), /touched nothing it is about/);
    await postAs('user_firm_admin', customerReceipt({ ...job('A'), amountNgn: 1_000n }));
    await assert.rejects(approve(id, 'A', 'supplier_cost_not_covered', 'user_firm_admin'), /touched nothing it is about/);
    await approve(id, 'C', 'emm_funded', 'user_firm_admin');
    // One sign-off per flag; another tenant's flag looks like no flag at all.
    const cFlag = (await tx(id, (t) => t.client.query<{ id: string }>("SELECT id FROM job_order_flags WHERE vehicle_id = $1 AND kind = 'emm_funded'", [cars[id]?.C]))).rows[0]?.id;
    await assert.rejects(insert(REVIEWER, id, cFlag), /job_order_sign_offs_one_per_flag/);
    await assert.rejects(insert('user_elsewhere', elsewhere, await flagOf('A', 'supplier_cost_not_covered')), /job_order_sign_offs_flag/);
    // A reason, never a supplied signer, and never changed or deleted, even by the owner; flags can't be written or changed by the app.
    const aFlag = await flagOf('A', 'supplier_cost_not_covered');
    await assert.rejects(insert(REVIEWER, id, aFlag, '', '  '), /job_order_sign_offs_reason/);
    await assert.rejects(insert(REVIEWER, id, aFlag, 'user_someone_else'), /permission denied/);
    await assert.rejects(tx(id, (t) => t.client.query("INSERT INTO job_order_flags (tenant_id, job_order_id, vehicle_id, entry_id, kind) SELECT tenant_id, job_order_id, vehicle_id, entry_id, 'emm_funded' FROM job_order_flags LIMIT 1")), /permission denied/);
    await assert.rejects(owner('DELETE FROM job_order_flags'), /append-only/);
    await insert(REVIEWER, id, aFlag);
    await approve(id, 'E', 'emm_funded');
    const row = (await tx(id, (t) => t.client.query<{ signed_by: string; fresh: boolean }>(
      "SELECT signed_by, signed_at > now() - interval '1 minute' AS fresh FROM job_order_sign_offs WHERE flag_id = $1", [aFlag]))).rows[0];
    assert.deepEqual(row, { signed_by: REVIEWER, fresh: true });
    await assert.rejects(tx(id, (t) => t.client.query("UPDATE job_order_sign_offs SET reason = 'changed'")), /permission denied/);
    await assert.rejects(owner('UPDATE job_order_sign_offs SET reason = $1', ['changed']), /append-only/);
    await assert.rejects(owner('DELETE FROM job_order_sign_offs'), /append-only/);
    assert.equal(await tx(id, async (t) => (await t.client.query("SELECT 1 FROM audit_log WHERE entity = 'job_order_sign_offs' AND actor = $1", [REVIEWER])).rowCount), 2);
    assert.deepEqual(await flags(id), [['posted_before_quote', 'E']]);
    assert.equal(await count(elsewhere, 'job_order_sign_offs'), 0);
  });

  test('each car on a car purchase carries its own quoted price, adding up to the job\'s; clearing-only cars carry none (0014)', async () => {
    const { id } = await funded('Per-car prices', { held: false });
    await tx(id, async (t) => {
      const customerId = customers[id]?.A;
      const quote = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'accepted_quote', 'application/pdf', 100, $2, 'q.pdf') RETURNING id", [id, 'b'.repeat(64)]);
      await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [quote]);
      const purchase = await one(t.client, `INSERT INTO job_orders (tenant_id, customer_id, job_type, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
        VALUES ($1, $2, 'car_purchase', '2026-01-05', 9000000, 'CNY', '110.000000', 'manual', 'FIXTURE_RATE_QUOTE', 0) RETURNING id`, [id, customerId]);
      const car = async (vin: string) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, $2, 'Test', 'Car', 2024) RETURNING id", [id, vin]);
      const savepoint = async (run: () => Promise<unknown>) => {
        await t.client.query('SAVEPOINT s');
        try {
          await run();
          await t.client.query('RELEASE SAVEPOINT s');
        } catch (err) {
          await t.client.query('ROLLBACK TO SAVEPOINT s');
          throw err;
        }
      };
      const add = (job: string, vehicle: string, price: bigint | null) => savepoint(() =>
        t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor, landing_charge_ngn) VALUES ($1, $2, $3, $4, 0)', [id, job, vehicle, price]));
      const [x, y] = [await car('TESTCARX000000000'), await car('TESTCARY000000000')];
      await assert.rejects(add(purchase, x, null), /each car on a car purchase needs its own quoted price/);
      await add(purchase, x, 4_000_000n);
      await add(purchase, y, 4_000_000n);
      await assert.rejects(savepoint(() => t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [purchase, quote])),
        /the cars' own prices must add up to the quoted car price/); // CNY 80,000.00 of 90,000.00
      const clearing = await one(t.client, "INSERT INTO job_orders (tenant_id, customer_id, job_type, ordered_on, landing_charge_ngn) VALUES ($1, $2, 'clearing_only', '2026-01-05', 0) RETURNING id", [id, customerId]);
      await assert.rejects(add(clearing, await car('TESTCARW000000000'), 1n), /a clearing-only job's cars carry no car price/);
    });
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
    await assert.rejects(postLines(id, period, [payNgn, ngn('1000', 0n, 210_000_000n)]), orShape(/more NGN than is owed/));
    await assert.rejects(postLines(id, period, [ngn('2000', 210_000_000n, 0n), ngn('1000', 0n, 210_000_000n)]), /must name the supplier/);
    await assert.rejects(postLines(id, period, [ngn('6000', 1_000n, 0n), ngn('2000', 0n, 1_000n)]), /must name the supplier/); // an unnamed bill could never be paid
    const invoiceB = supplierInvoice({ vehicleId: 'B', supplierId: SUPPLIER, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    await assert.rejects(postLines(id, period, [{ ...payNgn, vehicleId: 'B' }, ...invoiceB, ngn('1000', 0n, 210_000_000n)]), orShape(/more NGN than is owed/));
    await postLines(id, period, payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines);
    // An NGN bill and its payment post; paying a kobo more than the bill does not.
    await postLines(id, period, [ngn('6000', 5_000_000n, 0n), ngn('2000', 0n, 5_000_000n, { counterpartyId: SUPPLIER })]);
    await assert.rejects(postLines(id, period, [ngn('2000', 5_000_001n, 0n, { counterpartyId: SUPPLIER }), ngn('1000', 0n, 5_000_001n)]), orShape(/more NGN than is owed/));
    await postLines(id, period, [ngn('2000', 5_000_000n, 0n, { counterpartyId: SUPPLIER }), ngn('1000', 0n, 5_000_000n)]);
  });

  test('a car\'s supplier cost goes to that car\'s job costs, and a settlement cannot pay a car from the pool as well', async () => {
    const { id, period } = await funded('Entry shape');
    const pay = payFromPool({ pool: await poolOf(id), currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
    const cost = orShape(/must go to that car's job costs \(1150\)/);
    await assert.rejects(postLines(id, period, pay.map((l) => (l.account === '1010' ? { ...l, vehicleId: 'B' } : l))), cost); // pool names B, 1150 names A
    const inv = supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN });
    await assert.rejects(postLines(id, period, inv.map((l) => (l.account === '1150' ? { ...l, account: '6000', vehicleId: undefined } : l))), cost); // invoice expensed, car never costed
    await postLines(id, period, inv);
    const settle = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines;
    const shape = orShape(/a supplier settlement holds only the payable \(2000\), the pool \(1010, no car\) and realized FX \(7000\)/);
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '1010' ? { ...l, vehicleId: 'A' } : l))), orShape(/settle a supplier invoice in the same entry/)); // pool line names the car
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '7000' ? { ...l, account: '1150', vehicleId: 'B' } : l))), shape); // FX gap into car B's cost
    // Clear the payable with no currency leaving the pool, as "income": refused.
    const [payableLine] = settle;
    if (!payableLine) throw new Error('settlement has a payable line');
    await assert.rejects(postLines(id, period, [payableLine, { account: '7000', debit: 0n, credit: payableLine.debit, currency: 'NGN', amountMinor: payableLine.debit }]), orShape(/an invoice is settled only from the pool/));
    await postLines(id, period, settle);
  });

  test('a chart without 7000 refuses a settlement whose FX gap goes elsewhere (a missing account does not open the shape check)', async () => {
    const { id, period } = await funded('No 7000');
    await owner("UPDATE accounts SET code = '7999' WHERE tenant_id = $1 AND code = '7000'", [id]); // the app can't recode accounts; the owner sets up the odd chart
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    const settle = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines;
    await assert.rejects(postLines(id, period, settle.map((l) => (l.account === '7000' ? { ...l, account: '1150', vehicleId: 'B' } : l))), orShape(/a supplier settlement holds only/));
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
    await assert.rejects(postLines(id, period, carless), orShape(/must name the car, or settle a supplier invoice/));
    // Clearing the tenant setting before COMMIT must not blind the commit-time check (security review).
    await assert.rejects(postLines(id, period, carless, { beforeCommit: (c) => c.query("SELECT set_config('app.tenant_id', '', true)") }), orShape(/must name the car, or settle a supplier invoice/));
    await postLines(id, period, supplierInvoice({ ...bill, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }));
    // Pays CNY 20,000.00 from the pool but settles only CNY 10,000.00 of the invoice: refused.
    const settled = payPayableFromPool({ ...bill, pool: await poolOf(id), payable: await payableOf(id), currency: 'CNY', amountMinor: 1_000_000n, spot: SPOT_CBN });
    const settle = settled.lines;
    const extra = payFromPool({ pool: settled.pool, currency: 'CNY', amountMinor: 1_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines
      .map((l) => (l.account === '1010' ? { ...l, vehicleId: undefined, counterpartyId: SUPPLIER } : { ...l, account: '6000', vehicleId: undefined }));
    await assert.rejects(postLines(id, period, [...settle, ...extra]), orShape(/must name the car, or settle a supplier invoice/));
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
    // No 2000 or 2150: an unnamed NGN line on payables, or on customer funds held, is refused (they name a supplier or a car).
    const ngnCodes = ['1000', '3000', '4900', '6100', '6000', '7000']; // vehicle revenue always names a car (0014)
    const pick = () => ngnCodes[Number(rnd(BigInt(ngnCodes.length)))] ?? '1000';

    // Random balanced entry. One in eight is a currency purchase (CNY into the pool 1010, paid from cash: its own entry type,
    // 0015); the rest are manual journals: 1-3 NGN lines on one side, the same total split over 1-3 NGN lines on the other,
    // half the time with the sides swapped.
    const randomEntry = (): Entry => {
      const date = `2026-01-${String(Number(rnd(31n)) + 1).padStart(2, '0')}`;
      if (rnd(8n) === 0n) {
        const amountMinor = rnd(10n ** 9n) + 10_000n;
        const rateScaled = rnd(2_000n * RATE_SCALE) + RATE_SCALE / 100n; // fixture range (0.01-2000) for property testing, not real rates
        const cost = convert(amountMinor, rateScaled);
        return { periodId: periodA, date, sourceType: 'currency_purchase', lines: [
          { account: '1010', debit: cost, currency: 'CNY', amountMinor, rate: rateString(rateScaled), rateSource: 'bank_receipt' }, { account: '1000', credit: cost }] };
      }
      const side: Line[] = [];
      for (let i = 0, n = Number(rnd(3n)) + 1; i < n; i++) side.push({ account: pick(), debit: rnd(10n ** 11n) + 100n });
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
      return { periodId: periodA, date, sourceType: 'manual_journal', lines };
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

describe('default chart of accounts (migration 0016)', () => {
  test('a new client gets the default chart once; existing accounts are kept; only the owner seeds it', async () => {
    const tenant = (await owner<{ id: string }>("INSERT INTO tenants (legal_name) VALUES ('Chart seed') RETURNING id")).rows[0]?.id ?? '';
    const seed = async () => {
      const c = await ownerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.user_id', 'user_firm_admin', true)");
        await c.query('SELECT seed_default_chart($1)', [tenant]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    };
    // Firm staff already set up 1000 under the client's own bank name: the seed leaves it as it is.
    await tx(tenant, (t) => t.client.query("INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '1000', 'Cash – GTBank', 'asset')", [tenant]));
    await seed();
    await seed();
    const chart = (await tx(tenant, (t) => t.client.query<{ code: string; name: string; type: string; is_system: boolean }>('SELECT code, name, type, is_system FROM accounts ORDER BY code'))).rows;
    assert.deepEqual(chart.map((a) => a.code), ['1000', '1010', '1019', '1100', '1150', '1200', '1210', '1300', '2000', '2009', '2100', '2150', '2200', '3000', '3100', '4000', '4100', '4200', '5000', '6000', '7000', '7100']);
    assert.equal(chart[0]?.name, 'Cash – GTBank');
    assert.deepEqual(chart.filter((a) => !a.is_system).map((a) => a.code), ['1000', '1300', '2200', '3000', '3100', '6000']);
    assert.equal(await count(tenant, 'accounts'), 22);
    await assert.rejects(tx(tenant, (t) => t.client.query('SELECT seed_default_chart($1)', [tenant])), /permission denied for function seed_default_chart/);
  });

  test('a client\'s books take entries from its go-live date to today; no month opens behind a locked one (0016)', async () => {
    const entry = (date: string, sourceType = 'manual_journal') => tx(tenantA, (t) => insertEntry(t.client, tenantA, { ...simple(periodA, 100n, date), sourceType }));
    await assert.rejects(tx(tenantA, (t) => insertEntry(t.client, tenantA, simple(lockedA, 100n, '2025-11-30'))), /entry date 2025-11-30 is before this business went live \(2025-12-01\)/);
    const tomorrow = (await owner<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Africa/Lagos')::date + 1, 'YYYY-MM-DD') AS d")).rows[0]?.d ?? '';
    await assert.rejects(entry(tomorrow), new RegExp(`entry date ${tomorrow} is in the future`));
    await entry('2026-01-20');
    const unlive = (await owner<{ id: string }>("INSERT INTO tenants (legal_name) VALUES ('Not live yet') RETURNING id")).rows[0]?.id ?? '';
    await assert.rejects(tx(unlive, async (t) => {
      const acct = async (code: string) => one(t.client, "INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, 'x', 'asset') RETURNING id", [unlive, code]);
      const [a, b] = [await acct('1000'), await acct('3000')];
      const per = await one(t.client, "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-01', '2026-01-31') RETURNING id", [unlive]);
      const e = await one(t.client, "INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key) VALUES ($1, $2, '2026-01-05', 'x', 'manual_journal', uuidv7(), 'k') RETURNING id", [unlive, per]);
      await t.client.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, amount_minor) VALUES ($1, $2, $3, 1, 0, 1), ($1, $2, $4, 0, 1, 1)", [unlive, e, a, b]);
    }), /no go-live date yet/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2025-11-01', '2025-11-30')", [tenantA])),
      /period 2025-11-01 to 2025-11-30 is before this business went live \(2025-12-01\)/);
    // January open, March locked, February never had an entry: February can't open behind March's lock; April can.
    const { id: gaps } = await freshTenant('Gap month');
    await tx(gaps, async (t) => {
      const march = await one(t.client, "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-03-01', '2026-03-31') RETURNING id", [gaps]);
      await t.client.query("UPDATE periods SET status = 'locked', locked_by = 'user_admin', locked_at = now() WHERE id = $1", [march]);
    });
    await assert.rejects(tx(gaps, (t) => t.client.query("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-02-01', '2026-02-28')", [gaps])),
      /period 2026-02-01 to 2026-02-28 would open behind a locked period/);
    await tx(gaps, (t) => t.client.query("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-04-01', '2026-04-30')", [gaps]));
  });

  test('the seed refuses a system account set up with another type (0016)', async () => {
    const tenant = (await owner<{ id: string }>("INSERT INTO tenants (legal_name) VALUES ('Mistyped chart') RETURNING id")).rows[0]?.id ?? '';
    await tx(tenant, (t) => t.client.query("INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '2150', 'Deposits', 'income')", [tenant]));
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', 'user_firm_admin', true)");
      await assert.rejects(c.query('SELECT seed_default_chart($1)', [tenant]), /account 2150 already exists with another type/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  test("a line's evidence is one of this tenant's own stored documents (0016)", async () => {
    const doc = (status: 'pending' | 'stored') => tx(tenantA, async (t) => {
      const d = await one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'r.pdf') RETURNING id",
        [tenantA, randomHex()]);
      if (status === 'stored') await t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [d]);
      return d;
    });
    const withEvidence = (documentId: string) => tx(tenantA, async (t) => {
      const entryId = await insertEntry(t.client, tenantA, { ...simple(periodA, 100n), lines: [] });
      await t.client.query("INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, evidence_document_id) VALUES ($1, $2, $3, 100, 0, 'NGN', 100, $4), ($1, $2, $5, 0, 100, 'NGN', 100, NULL)",
        [tenantA, entryId, accounts[tenantA]?.['1000'], documentId, accounts[tenantA]?.['3000']]);
    });
    await assert.rejects(withEvidence(await doc('pending')), /evidence must be a stored document/);
    await assert.rejects(withEvidence('019a0000-0000-7000-8000-00000000dead'), /^error: evidence must be a stored document: confirm the upload first$/);
    const bDoc = await tx(tenantB, (t) => one(t.client, "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, 'receipt', 'application/pdf', 100, $2, 'r.pdf') RETURNING id", [tenantB, randomHex()]));
    await assert.rejects(withEvidence(bDoc), /^error: evidence must be a stored document: confirm the upload first$/); // another tenant's: the same answer
    await withEvidence(await doc('stored'));
  });
});

describe('tenant access (migration 0009)', () => {
  let hookPool: pg.Pool; // finbook_hook: the Clerk webhook's own login
  const ev = (clerkUserId: string, role: string | null, eventMs: bigint, clerkOrgId = 'org_a') => applyMembershipEvent(hookPool, { clerkOrgId, clerkUserId, role, eventMs });

  before(async () => {
    hookPool = new pg.Pool({ host: container.getHost(), port: container.getPort(), database: container.getDatabase(), user: 'finbook_hook', password: HOOK_PASSWORD, max: 2 });
    await owner("UPDATE tenants SET clerk_org_id = 'org_a' WHERE id = $1", [tenantA]);
    await owner("UPDATE tenants SET clerk_org_id = 'org_b' WHERE id = $1", [tenantB]);
    await owner("INSERT INTO firm_staff (clerk_user_id) VALUES ('user_staff'), ('user_both')");
    await owner("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_owner_a', 'client_owner'), ($2, 'user_owner_b', 'client_owner')", [tenantA, tenantB]);
    await owner("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_staff', 'firm_accountant', 'user_admin')", [tenantA]);
  });
  after(() => hookPool.end());

  test("a client role counts only while the token's live org is the tenant's org", async () => {
    const ownerA = { tenantId: tenantA, role: 'client_owner' };
    assert.deepEqual(await resolveAccess(apiPool, 'user_owner_a', { clerkOrgId: 'org_a' }, 'org_a'), ownerA);
    assert.deepEqual(await resolveAccess(apiPool, 'user_owner_a', { tenantId: tenantA }, 'org_a'), ownerA);
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { tenantId: tenantA }, undefined), null); // removed from the org in Clerk
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { tenantId: tenantA }, 'org_b'), null);
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { tenantId: tenantB }, 'org_a'), null); // another tenant's id
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { clerkOrgId: 'org_b' }, 'org_b'), null); // another tenant's org
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { clerkOrgId: 'org_none' }, 'org_none'), null);
    assert.equal(await resolveAccess(apiPool, 'user_owner_a', { tenantId: '00000000-0000-7000-8000-000000000000' }, 'org_a'), null);
  });

  test('firm staff reach only the tenants they are assigned to', async () => {
    assert.deepEqual(await resolveAccess(apiPool, 'user_staff', { tenantId: tenantA }, undefined), { tenantId: tenantA, role: 'firm_accountant' });
    assert.equal(await resolveAccess(apiPool, 'user_staff', { tenantId: tenantB }, undefined), null);
    assert.equal(await tx(tenantA, async (t) => (await t.client.query('SELECT 1 FROM memberships WHERE tenant_id = $1', [tenantB])).rowCount), 0);
    assert.equal(await tx(tenantB, async (t) => (await t.client.query('SELECT 1 FROM firm_access')).rowCount), 0);
  });

  test('firm staff never hold a client role, whichever row came first, in any tenant', async () => {
    // a client membership written before they were made firm staff, in a tenant where they also have firm_access
    await owner("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'user_both', 'client_owner')", [tenantB]);
    await owner("INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_both', 'firm_reviewer', 'user_admin')", [tenantB]);
    assert.deepEqual(await resolveAccess(apiPool, 'user_both', { tenantId: tenantB }, 'org_b'), { tenantId: tenantB, role: 'firm_reviewer' });
    await owner("DELETE FROM firm_access WHERE clerk_user_id = 'user_both'"); // unassigned: no client role comes back
    assert.equal(await resolveAccess(apiPool, 'user_both', { tenantId: tenantB }, 'org_b'), null);
    assert.equal(await resolveAccess(apiPool, 'user_both', { clerkOrgId: 'org_b' }, 'org_b'), null);
    // firm staff of tenant A invited into client B's org: never mirrored
    assert.equal(await ev('user_staff', 'client_owner', 100n, 'org_b'), 'applied');
    assert.equal(await resolveAccess(apiPool, 'user_staff', { clerkOrgId: 'org_b' }, 'org_b'), null);
  });

  test('a tenant that is not active gives no access', async () => {
    await owner("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantB]);
    try {
      assert.equal(await resolveAccess(apiPool, 'user_owner_b', { clerkOrgId: 'org_b' }, 'org_b'), null);
    } finally {
      await owner("UPDATE tenants SET status = 'active' WHERE id = $1", [tenantB]);
    }
    assert.deepEqual(await resolveAccess(apiPool, 'user_owner_b', { clerkOrgId: 'org_b' }, 'org_b'), { tenantId: tenantB, role: 'client_owner' });
  });

  test('membership events apply once, in order; on a tie a removal wins', async () => {
    assert.equal(await ev('user_new', 'client_staff', 100n), 'applied');
    assert.equal(await ev('user_new', 'client_staff', 100n), 'stale'); // the same delivery twice
    assert.deepEqual(await resolveAccess(apiPool, 'user_new', { clerkOrgId: 'org_a' }, 'org_a'), { tenantId: tenantA, role: 'client_staff' });
    assert.equal(await ev('user_new', null, 200n), 'applied'); // removed
    assert.equal(await ev('user_new', 'client_owner', 150n), 'stale'); // a late, older delivery can't bring them back
    assert.equal(await resolveAccess(apiPool, 'user_new', { clerkOrgId: 'org_a' }, 'org_a'), null);
    assert.equal(await ev('user_late', null, 300n), 'applied'); // removal first: a tombstone
    assert.equal(await ev('user_late', 'client_owner', 250n), 'stale');
    assert.equal(await ev('user_tie', 'client_owner', 400n), 'applied');
    assert.equal(await ev('user_tie', null, 400n), 'applied'); // same millisecond: the removal wins
    assert.equal(await ev('user_tie', 'client_owner', 400n), 'stale');
    assert.equal(await ev('user_down', 'client_owner', 500n), 'applied');
    assert.equal(await ev('user_down', 'client_viewer', 500n), 'applied'); // same millisecond: the downgrade wins
    assert.equal(await ev('user_down', 'client_owner', 500n), 'stale');
    assert.deepEqual(await resolveAccess(apiPool, 'user_down', { clerkOrgId: 'org_a' }, 'org_a'), { tenantId: tenantA, role: 'client_viewer' });
    assert.equal(await ev('user_x', 'client_owner', 100n, 'org_firm'), 'no_tenant');
    await assert.rejects(ev('user_future', 'client_owner', 9_000_000_000_000_000n), /memberships_event_time/);
    const audit = (await owner<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE entity = 'memberships' AND after->>'clerk_user_id' = 'user_new' AND actor = 'system:clerk-webhook'")).rows[0]?.n;
    assert.equal(audit, '2'); // created, then revoked: both audited, as the webhook
  });

  test('deleting an organization revokes every membership of its tenant only', async () => {
    assert.equal(await ev('user_c1', 'client_staff', 100n, 'org_b'), 'applied');
    assert.equal(await revokeOrganization(hookPool, 'org_b', 500n), 'applied');
    assert.equal(await resolveAccess(apiPool, 'user_c1', { clerkOrgId: 'org_b' }, 'org_b'), null);
    assert.equal(await resolveAccess(apiPool, 'user_owner_b', { clerkOrgId: 'org_b' }, 'org_b'), null);
    assert.deepEqual(await resolveAccess(apiPool, 'user_owner_a', { clerkOrgId: 'org_a' }, 'org_a'), { tenantId: tenantA, role: 'client_owner' });
    assert.equal(await ev('user_c1', 'client_owner', 450n, 'org_b'), 'stale'); // a delayed pre-deletion event: no revival
    assert.equal(await revokeOrganization(hookPool, 'org_none', 500n), 'no_tenant');
  });

  test('only the webhook login writes memberships; nobody deletes; the app writes no access rows', async () => {
    assert.equal(await tx(tenantA, async (t) => (await t.client.query('SELECT 1 FROM tenants')).rowCount), 1); // org lookup scoped to one call
    for (const sql of [
      "INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'x', 'client_owner')",
      "UPDATE memberships SET role = 'client_owner' WHERE tenant_id = $1",
      "INSERT INTO firm_access (tenant_id, clerk_user_id, role, granted_by) VALUES ($1, 'user_staff', 'firm_admin', 'x')",
      "INSERT INTO firm_staff (clerk_user_id) SELECT 'x' WHERE $1::uuid IS NOT NULL",
    ]) await assert.rejects(tx(tenantA, (t) => t.client.query(sql, [tenantA])), /permission denied/, sql);
    await assert.rejects(apiPool.query('SET ROLE finbook_sync'), /permission denied/); // the API login can't become the webhook
    await assert.rejects(withTenant(hookPool, as(tenantA), (t) => t.client.query('DELETE FROM memberships'), 'finbook_sync'), /permission denied/);
    await assert.rejects(withTenant(hookPool, as(tenantA), (t) => t.client.query("UPDATE memberships SET tenant_id = $1", [tenantB]), 'finbook_sync'), /permission denied/);
    await assert.rejects(withTenant(hookPool, as(tenantA), (t) => t.client.query("INSERT INTO memberships (tenant_id, clerk_user_id, role) VALUES ($1, 'x', 'client_owner')", [tenantB]), 'finbook_sync'), /row-level security/);
    assert.equal(await withTenant(hookPool, as(tenantA), async (t) => (await t.client.query('SELECT 1 FROM journal_lines')).rowCount, 'finbook_sync').catch((e: unknown) => String(e)), 'error: permission denied for table journal_lines');
  });

  test('access rows are audited', async () => {
    const rows = (await owner<{ entity: string }>("SELECT DISTINCT entity FROM audit_log WHERE tenant_id = $1 AND entity IN ('memberships', 'firm_access') ORDER BY entity", [tenantA])).rows;
    assert.deepEqual(rows.map((r) => r.entity), ['firm_access', 'memberships']);
  });
});

describe('vehicles (migrations 0011-0012)', () => {
  test('the database VIN check agrees with the one users see, on every rule and on random VINs', async () => {
    const chars = '0123456789ABCDEFGHJKLMNPRSTUVWXYZIOQ-';
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const vins = ['1M8GDM9AXKP042788', '11111111111111111', '1M8GDM9A1KP042788', '1M8GDM9AXKP04278', '1M8GDM9AXKP0427O8', 'LGXCE4CB1N0000001'];
    for (let i = 0; i < 2000; i++) {
      const v = Array.from({ length: 17 }, () => chars.charAt(rnd(i % 10 === 0 ? chars.length : 33))).join('');
      // every other sample: set the 9th character to whichever check digit makes it valid, so both outcomes are tested
      const fixed = i % 2 === 0 ? ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'X'].map((c) => v.slice(0, 8) + c + v.slice(9)).find((w) => vinProblem(w) === null) : undefined;
      vins.push(fixed ?? v);
    }
    const { rows } = await owner<{ vin: string; status: string }>('SELECT v AS vin, vin_status_of(v) AS status FROM unnest($1::text[]) v', [vins]);
    let valid = 0;
    for (const r of rows) {
      const expected = vinProblem(r.vin) === null ? 'ok' : 'vin_needs_correction';
      if (expected === 'ok') valid++;
      assert.equal(r.status, expected, r.vin);
    }
    assert.ok(valid > 100, 'the random sample includes valid VINs');
  });

  test('vin_status is computed by the database and cannot be supplied; VINs are unique per tenant', async () => {
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO vehicles (tenant_id, vin, vin_status, make, model, year) VALUES ($1, '1M8GDM9A1KP042788', 'ok', 'x', 'y', 2020)", [tenantA])), /generated column|cannot insert/);
    await tx(tenantA, (t) => t.client.query("INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, '1M8GDM9A1KP042788', 'x', 'y', 2020)", [tenantA]));
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, '1M8GDM9A1KP042788', 'x', 'y', 2020)", [tenantA])), /vehicles_tenant_vin/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, ' lower ', 'x', 'y', 2020)", [tenantA])), /vehicles_vin_shape/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE vehicles SET vin = '11111111111111111'")), /permission denied/);
    assert.equal(await tx(tenantB, async (t) => (await t.client.query('SELECT 1 FROM vehicles')).rowCount), 0);
  });
});

describe('job orders and documents (migration 0013)', () => {
  const SHA = 'a'.repeat(64);
  const customer = (tenant: string, kind = 'customer') => tx(tenant, (t) => one(t.client,
    "INSERT INTO counterparties (tenant_id, kind, name) VALUES ($1, $2, 'Customer') RETURNING id", [tenant, kind]));
  const job = (t: Tx, tenant: string, customerId: string, funding = 'customer_funded') => one(t.client,
    `INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, ordered_on, landing_charge_ngn)
     VALUES ($1, $2, 'clearing_only', $3, '2026-01-08', 150000000) RETURNING id`, [tenant, customerId, funding]);
  const numberOf = async (tenant: string, id: string) => (await tx(tenant, (t) => t.client.query<{ number: number }>('SELECT number FROM job_orders WHERE id = $1', [id]))).rows[0]?.number;
  const doc = (tenant: string, type = 'accepted_quote') => tx(tenant, (t) => one(t.client,
    "INSERT INTO documents (tenant_id, doc_type, mime, size_bytes, sha256, original_filename) VALUES ($1, $2, 'application/pdf', 100, $3, 'q.pdf') RETURNING id", [tenant, type, SHA]));
  const store = (tenant: string, id: string) => tx(tenant, (t) => t.client.query(
    "UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || tenant_id || '/2026/01/' || id || '.pdf', stored_at = now() WHERE id = $1", [id]));

  test('job numbers are gapless per tenant: a rolled-back order gives its number back; nobody chooses one', async () => {
    const c = await customer(tenantA);
    const first = await tx(tenantA, (t) => job(t, tenantA, c));
    await assert.rejects(tx(tenantA, async (t) => { await job(t, tenantA, c); throw new Error('user cancelled'); }), /user cancelled/);
    const second = await tx(tenantA, (t) => job(t, tenantA, c));
    const [n1, n2] = [await numberOf(tenantA, first), await numberOf(tenantA, second)];
    assert.equal(n2, (n1 ?? 0) + 1);
    const cb = await customer(tenantB);
    assert.equal(await numberOf(tenantB, await tx(tenantB, (t) => job(t, tenantB, cb))), 1); // each tenant has its own series
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO job_orders (tenant_id, number, customer_id, job_type, ordered_on, landing_charge_ngn) VALUES ($1, 999, $2, 'clearing_only', '2026-01-08', 0)", [tenantA, c])), /permission denied/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE tenant_counters SET last = last + 50")), /permission denied/); // no gaps by hand
    const many = await Promise.all(Array.from({ length: 8 }, () => tx(tenantA, (t) => job(t, tenantA, c))));
    const numbers = await Promise.all(many.map((id) => numberOf(tenantA, id)));
    assert.equal(new Set(numbers).size, 8); // concurrent orders queue on the counter: no repeats
  });

  test('the customer must be a customer of this tenant', async () => {
    const supplier = await customer(tenantA, 'supplier');
    await assert.rejects(tx(tenantA, (t) => job(t, tenantA, supplier)), /job_orders_customer/);
    const other = await customer(tenantB);
    await assert.rejects(tx(tenantA, (t) => job(t, tenantA, other)), /job_orders_customer/);
  });

  test('a car purchase quotes a foreign price at a locked rate; cbn and market rates must match the stored rate', async () => {
    const c = await customer(tenantA);
    const purchase = (rate: string, source: string, note: string | null = null) => tx(tenantA, (t) => one(t.client,
      `INSERT INTO job_orders (tenant_id, customer_id, job_type, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
       VALUES ($1, $2, 'car_purchase', '2026-01-09', 9800000, 'CNY', $3, $4, $5, 150000000) RETURNING id`, [tenantA, c, rate, source, note]));
    assert.ok(await purchase(FIXTURE_RATE_SPOT, 'cbn')); // the stored CBN rate for 2026-01-08, one day before
    await assert.rejects(purchase('109.000000', 'cbn'), /marked cbn but/);
    await assert.rejects(purchase(FIXTURE_RATE_SPOT, 'market'), /no market rate/);
    await assert.rejects(purchase('230.000000', 'manual'), /job_orders_quote_rate_note/);
    assert.ok(await purchase('230.000000', 'manual', 'BDC rate quoted on WhatsApp'));
    await assert.rejects(tx(tenantA, (t) => t.client.query(
      "INSERT INTO job_orders (tenant_id, customer_id, job_type, ordered_on, car_price_minor, car_price_currency, landing_charge_ngn) VALUES ($1, $2, 'car_purchase', '2026-01-09', 1, 'CNY', 0)", [tenantA, c])), /job_orders_quote_shape/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, ordered_on, car_price_minor, car_price_currency, quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn) VALUES ($1, $2, 'car_purchase', 'emm_funded', '2026-01-09', 1, 'CNY', '230.000000', 'manual', 'fixture', 0)", [tenantA, c])), /job_orders_funding_reason/);
    // EMM-funded means the client bought the car as its own stock: never a clearing-only job, the customer's own car (0014)
    await assert.rejects(tx(tenantA, (t) => t.client.query("INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, landing_charge_ngn) VALUES ($1, $2, 'clearing_only', 'emm_funded', 'x', '2026-01-09', 0)", [tenantA, c])), /job_orders_emm_funded_is_purchase/);
  });

  test('a quote is accepted once, with a stored accepted_quote document and at least one car; then the job is fixed', async () => {
    const c = await customer(tenantA);
    const j = await tx(tenantA, (t) => job(t, tenantA, c));
    const accept = (d: string) => tx(tenantA, (t) => t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [j, d]));
    const pending = await doc(tenantA);
    await assert.rejects(accept(pending), /stored accepted_quote document/);
    const receipt = await doc(tenantA, 'receipt');
    await store(tenantA, receipt);
    await assert.rejects(accept(receipt), /stored accepted_quote document/);
    await store(tenantA, pending);
    await assert.rejects(accept(pending), /add its cars/);
    const car = await tx(tenantA, (t) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, 'JM1BK32F781234567', 'Mazda', '3', 2019) RETURNING id", [tenantA]));
    // Each car carries its own landing charge (owner 2026-11-17): together they make the job's NGN 1,500,000.00.
    const carB = await tx(tenantA, (t) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, 'JM1BK32F781234570', 'Mazda', '3', 2019) RETURNING id", [tenantA]));
    await tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, 100000000)', [tenantA, j, car]));
    await assert.rejects(accept(pending), /the cars' own landing charges must add up to the job's landing charge/);
    await assert.rejects(tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, -1)', [tenantA, j, carB])), /job_order_vehicles_landing_charge/);
    await tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, 50000000)', [tenantA, j, carB]));
    await accept(pending);
    await assert.rejects(accept(pending), /not an allowed change/);
    const j3 = await tx(tenantA, (t) => job(t, tenantA, c));
    const car3 = await tx(tenantA, (t) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, 'JM1BK32F781234569', 'Mazda', '3', 2019) RETURNING id", [tenantA]));
    await tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, 150000000)', [tenantA, j3, car3]));
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [j3, pending])), /job_orders_one_job_per_quote/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE job_orders SET landing_charge_ngn = 1 WHERE id = $1", [j])), /permission denied/);
    const car2 = await tx(tenantA, (t) => one(t.client, "INSERT INTO vehicles (tenant_id, vin, make, model, year) VALUES ($1, 'JM1BK32F781234568', 'Mazda', '3', 2019) RETURNING id", [tenantA]));
    await assert.rejects(tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, 0)', [tenantA, j, car2])), /only before its quote is accepted/);
    const j2 = await tx(tenantA, (t) => job(t, tenantA, c));
    await assert.rejects(tx(tenantA, (t) => t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, landing_charge_ngn) VALUES ($1, $2, $3, 0)', [tenantA, j2, car])), /one_job_per_car/);
    const audit = await owner<{ action: string }>("SELECT action FROM audit_log WHERE entity = 'job_orders' AND entity_id = $1 ORDER BY at", [j]);
    assert.deepEqual(audit.rows.map((r) => r.action), ['insert', 'update']);
  });

  test("evidence is checked once and never changes again; another tenant's document can't be attached", async () => {
    const d = await doc(tenantA);
    await store(tenantA, d);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE documents SET status = 'rejected', rejected_reason = 'x' WHERE id = $1", [d])), /never replaced/);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE documents SET sha256 = $2 WHERE id = $1", [d, 'b'.repeat(64)])), /permission denied/);
    const other = await doc(tenantA);
    await assert.rejects(tx(tenantA, (t) => t.client.query("UPDATE documents SET status = 'stored', evidence_key = 'evidence/' || $2 || '/x.pdf', stored_at = now() WHERE id = $1", [other, tenantB])), /documents_evidence_key_tenant/);
    await assert.rejects(tx(tenantA, (t) => t.client.query('DELETE FROM documents WHERE id = $1', [d])), /permission denied/);
    await assert.rejects(owner('DELETE FROM documents WHERE id = $1', [d]), /not allowed/); // not even the owner
    const uploader = (await owner<{ uploaded_by: string }>('SELECT uploaded_by FROM documents WHERE id = $1', [d])).rows[0]?.uploaded_by;
    assert.equal(uploader, USER);
    const c = await customer(tenantB);
    const jb = await tx(tenantB, (t) => job(t, tenantB, c));
    await assert.rejects(tx(tenantB, (t) => t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [jb, d])), /job_orders_quote_document|stored accepted_quote/);
    for (const table of ['documents', 'job_orders', 'job_order_vehicles', 'tenant_counters']) {
      assert.equal(await tx(tenantB, async (t) => (await t.client.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantA])).rowCount), 0, table);
    }
  });
});

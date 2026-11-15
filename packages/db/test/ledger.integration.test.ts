// Phase 1 gate (spec → Build phases): 10k random entries keep the trial balance at zero, and a
// cross-tenant read returns zero rows. Plus one test per ledger guarantee. Needs Docker.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { convert, RATE_SCALE } from '@app/money';
import { migrate, withTenant } from '../src/index.ts';

type Line = {
  account: string; debit?: bigint; credit?: bigint;
  currency?: string; amountMinor?: bigint; rate?: string; rateSource?: string; rateNote?: string;
};
type Entry = { periodId: string; date: string; lines: Line[]; key?: string; memo?: string };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool; // connects as the owner (superuser), like the API on Railway
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
const rateString = (scaled: bigint) => `${String(scaled / RATE_SCALE)}.${String(scaled % RATE_SCALE).padStart(6, '0')}`;

const owner = <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);

/** Insert one entry and its lines inside an existing tenant transaction. Returns the entry id. */
async function insertEntry(client: pg.PoolClient, tenant: string, e: Entry): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, 'manual_journal', uuidv7(), $5, 'test') RETURNING id`,
    [tenant, e.periodId, e.date, e.memo ?? 'test entry', e.key ?? `k-${String(++keySeq)}`],
  );
  const entryId = rows[0]?.id ?? '';
  const ids = accounts[tenant] ?? {};
  for (const l of e.lines) {
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenant, entryId, ids[l.account] ?? l.account, debit, credit, l.currency ?? 'NGN', l.amountMinor ?? debit + credit,
        l.rate ?? null, l.rateSource ?? null, l.rateNote ?? null],
    );
  }
  return entryId;
}

const post = (tenant: string, e: Entry) => withTenant(pool, tenant, ({ client }) => insertEntry(client, tenant, e));
const simple = (periodId: string, amount: bigint, date = '2026-01-15'): Entry => ({
  periodId, date, lines: [{ account: '1000', debit: amount }, { account: '3000', credit: amount }],
});
const count = async (tenant: string, table: string) =>
  withTenant(pool, tenant, async ({ client }) => Number((await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n));
const trialBalance = (tenant: string) =>
  withTenant(pool, tenant, async ({ client }) => {
    const r = (await client.query<{ dr: string | null; cr: string | null }>('SELECT sum(debit_ngn) AS dr, sum(credit_ngn) AS cr FROM journal_lines')).rows[0];
    return { dr: BigInt(r?.dr ?? 0), cr: BigInt(r?.cr ?? 0) };
  });
const chainBreaks = (tenant: string) =>
  withTenant(pool, tenant, async ({ client }) =>
    (await client.query<{ seq: string | null; entry_id: string; problem: string }>('SELECT * FROM ledger_chain_breaks($1)', [tenant])).rows);

before(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  await migrate(pool);
  for (const name of ['Tenant A', 'Tenant B']) {
    const { rows } = await owner<{ id: string }>('INSERT INTO tenants (legal_name) VALUES ($1) RETURNING id', [name]);
    const id = rows[0]?.id ?? '';
    accounts[id] = {};
    await withTenant(pool, id, async ({ client }) => {
      for (const [code, type] of [['1000', 'asset'], ['1010', 'asset'], ['2000', 'liability'], ['3000', 'equity'],
        ['4000', 'income'], ['5000', 'expense'], ['6000', 'expense'], ['7000', 'income']] as const) {
        const r = await client.query<{ id: string }>(
          'INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, $3, $4) RETURNING id', [id, code, `Account ${code}`, type]);
        (accounts[id] ?? {})[code] = r.rows[0]?.id ?? '';
      }
    });
    if (name === 'Tenant A') tenantA = id; else tenantB = id;
  }
  const period = (t: string, from: string, to: string) => withTenant(pool, t, async ({ client }) =>
    (await client.query<{ id: string }>('INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING id', [t, from, to])).rows[0]?.id ?? '');
  periodA = await period(tenantA, '2026-01-01', '2026-01-31');
  lockedA = await period(tenantA, '2025-12-01', '2025-12-31');
  periodB = await period(tenantB, '2026-01-01', '2026-01-31');
  await withTenant(pool, tenantA, ({ client }) =>
    client.query("UPDATE periods SET status = 'locked', locked_by = 'test', locked_at = now() WHERE id = $1", [lockedA]));
});

after(async () => {
  await pool.end();
  await container.stop();
});

describe('posting', () => {
  test('a balanced entry posts and gets the next hash in the chain', async () => {
    const id = await post(tenantA, simple(periodA, 1_000_00n));
    const h = await withTenant(pool, tenantA, async ({ client }) =>
      (await client.query<{ seq: string; hash: string }>('SELECT seq, hash FROM journal_entry_hashes WHERE entry_id = $1', [id])).rows[0]);
    assert.match(h?.hash ?? '', /^[0-9a-f]{64}$/);
    assert.deepEqual(await chainBreaks(tenantA), []);
  });

  test('an unbalanced entry is refused at commit and nothing is kept', async () => {
    const before = await count(tenantA, 'journal_entries');
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 100n }, { account: '3000', credit: 99n }] }),
      /does not balance: debits 100 kobo, credits 99 kobo/);
    assert.equal(await count(tenantA, 'journal_entries'), before);
  });

  test('an entry needs at least two lines', async () => {
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [] }), /has 0 line\(s\)/);
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 1n }] }), /has 1 line\(s\)/);
  });

  test('a line is a debit or a credit, never both or neither', async () => {
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15', lines: [{ account: '1000', debit: 5n, credit: 5n }, { account: '3000', credit: 0n }] }),
      /journal_lines_one_side/);
  });

  test('a retried request with the same idempotency key cannot post twice', async () => {
    await post(tenantA, { ...simple(periodA, 500n), key: 'retry-1' });
    await assert.rejects(post(tenantA, { ...simple(periodA, 500n), key: 'retry-1' }), /journal_entries_idempotency/);
  });

  test('lines cannot be added to an entry once it is posted', async () => {
    const id = await post(tenantA, simple(periodA, 700n));
    await assert.rejects(withTenant(pool, tenantA, ({ client }) => client.query(
      "INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, amount_minor) VALUES ($1, $2, $3, 1, 1)",
      [tenantA, id, accounts[tenantA]?.['1000']])), /already posted; lines cannot be added/);
  });
});

describe('periods', () => {
  test('a locked period refuses new entries', async () => {
    await assert.rejects(post(tenantA, simple(lockedA, 100n, '2025-12-10')), /is locked/);
  });

  test('an entry dated outside its period is refused', async () => {
    await assert.rejects(post(tenantA, simple(periodA, 100n, '2026-02-01')), /outside its period/);
  });

  test('periods cannot overlap, and a locked period cannot be changed or reopened', async () => {
    await assert.rejects(withTenant(pool, tenantA, ({ client }) =>
      client.query("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-20', '2026-02-20')", [tenantA])), /periods_no_overlap/);
    await assert.rejects(withTenant(pool, tenantA, ({ client }) =>
      client.query("UPDATE periods SET status = 'open' WHERE id = $1", [lockedA])), /cannot change/);
  });
});

describe('immutability', () => {
  test('the app role has no UPDATE or DELETE on posted rows', async () => {
    for (const sql of ['UPDATE journal_lines SET debit_ngn = debit_ngn', 'DELETE FROM journal_entries', 'UPDATE audit_log SET actor = actor']) {
      await assert.rejects(withTenant(pool, tenantA, ({ client }) => client.query(sql)), /permission denied/);
    }
  });

  test('even the owner cannot update, delete or truncate posted rows', async () => {
    await assert.rejects(owner('UPDATE journal_lines SET debit_ngn = debit_ngn'), /append-only/);
    await assert.rejects(owner('DELETE FROM journal_entries'), /append-only/);
    await assert.rejects(owner('TRUNCATE journal_lines CASCADE'), /append-only/);
  });

  test('tampering with history (bypassing triggers) breaks the hash chain', async () => {
    const t = (await owner<{ id: string }>("INSERT INTO tenants (legal_name) VALUES ('Tamper test') RETURNING id")).rows[0]?.id ?? '';
    const ids: Record<string, string> = {};
    accounts[t] = ids;
    const p = await withTenant(pool, t, async ({ client }) => {
      for (const code of ['1000', '3000']) {
        ids[code] = (await client.query<{ id: string }>("INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, $2, 'x', 'asset') RETURNING id", [t, code])).rows[0]?.id ?? '';
      }
      return (await client.query<{ id: string }>("INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, '2026-01-01', '2026-01-31') RETURNING id", [t])).rows[0]?.id ?? '';
    });
    await post(t, simple(p, 100n));
    const victim = await post(t, simple(p, 200n));
    await post(t, simple(p, 300n));
    assert.deepEqual(await chainBreaks(t), []);
    const c = await pool.connect();
    try {
      await c.query("SET session_replication_role = 'replica'"); // superuser-only: disables triggers
      await c.query('UPDATE journal_lines SET debit_ngn = 999, amount_minor = 999 WHERE entry_id = $1 AND debit_ngn > 0', [victim]);
    } finally {
      await c.query("SET session_replication_role = 'origin'");
      c.release();
    }
    const breaks = await chainBreaks(t);
    assert.deepEqual(breaks.map((b) => [b.entry_id, b.problem]), [[victim, 'content changed']]);
  });
});

describe('foreign currency lines', () => {
  const fx = (amountMinor: bigint, rate: string, ngn: bigint, extra: Partial<Line> = {}): Entry => ({
    periodId: periodA, date: '2026-01-20',
    lines: [{ account: '1010', debit: ngn, currency: 'CNY', amountMinor, rate, rateSource: 'bank_receipt', ...extra }, { account: '1000', credit: ngn }],
  });

  test('NGN must equal amount x rate rounded half-up to the kobo (same as packages/money)', async () => {
    const amount = 1_234_56n; // CNY 1,234.56
    const ngn = convert(amount, 111_111_111n); // FIXTURE_RATE_CNY scaled
    await post(tenantA, fx(amount, FIXTURE_RATE_CNY, ngn));
    await assert.rejects(post(tenantA, fx(amount, FIXTURE_RATE_CNY, ngn + 1n)), /journal_lines_fx/);
  });

  test('a foreign line needs a rate source, and a manual rate needs a note', async () => {
    const ngn = convert(100n, 999_999_999n);
    await assert.rejects(post(tenantA, fx(100n, FIXTURE_RATE_USD, ngn, { rateSource: undefined })), /journal_lines_fx/);
    await assert.rejects(post(tenantA, fx(100n, FIXTURE_RATE_USD, ngn, { rate: undefined })), /journal_lines_fx/);
    await assert.rejects(post(tenantA, fx(100n, FIXTURE_RATE_USD, ngn, { rateSource: 'manual' })), /journal_lines_fx/);
    await post(tenantA, fx(100n, FIXTURE_RATE_USD, ngn, { rateSource: 'manual', rateNote: 'cash deal, no receipt' }));
  });
});

describe('tenant isolation', () => {
  test('a cross-tenant read returns zero rows', async () => {
    await post(tenantB, simple(periodB, 42n));
    const seenByA = await withTenant(pool, tenantA, async ({ client }) =>
      (await client.query('SELECT 1 FROM journal_lines WHERE tenant_id = $1 UNION ALL SELECT 1 FROM accounts WHERE tenant_id = $1 UNION ALL SELECT 1 FROM tenants WHERE id = $1', [tenantB])).rowCount);
    assert.equal(seenByA, 0);
    assert.ok((await count(tenantB, 'journal_lines')) > 0);
  });

  test('no tenant set means no rows at all', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE finbook_app');
      for (const table of ['tenants', 'accounts', 'periods', 'journal_entries', 'journal_lines', 'journal_entry_hashes', 'audit_log']) {
        assert.equal((await c.query(`SELECT 1 FROM ${table}`)).rowCount, 0, table);
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  test('writing a row for another tenant is refused', async () => {
    await assert.rejects(withTenant(pool, tenantA, ({ client }) => client.query(
      "INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1, '9999', 'x', 'asset')", [tenantB])), /row-level security/);
    await assert.rejects(withTenant(pool, tenantA, ({ client }) => client.query(
      "INSERT INTO audit_log (tenant_id, actor, action, entity) VALUES ($1, 'x', 'x', 'x')", [tenantB])), /row-level security/);
  });

  test("a line cannot point at another tenant's account", async () => {
    await assert.rejects(post(tenantA, { periodId: periodA, date: '2026-01-15',
      lines: [{ account: accounts[tenantB]?.['1000'] ?? '', debit: 1n }, { account: '3000', credit: 1n }] }), /journal_lines_account/);
  });
});

describe('phase 1 gate', () => {
  test('10k random entries: trial balance nets to zero, chain intact, invalid entries all refused', { timeout: 600_000 }, async () => {
    let seed = 20260115n;
    const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed >> 11n) % max);
    const pick = <T,>(xs: readonly T[]): T => xs[Number(rnd(BigInt(xs.length)))] as T;
    const codes = ['1000', '1010', '2000', '3000', '4000', '5000', '6000', '7000'] as const;

    // Random balanced entry: 1-3 lines on one side (NGN or foreign), the same total split over 1-3 NGN lines on the other.
    const randomEntry = (): Entry => {
      const side: Line[] = [];
      for (let i = 0, n = Number(rnd(3n)) + 1; i < n; i++) {
        if (rnd(4n) === 0n) {
          const amountMinor = rnd(10n ** 9n) + 10_000n;
          const rateScaled = rnd(2_000n * RATE_SCALE) + RATE_SCALE / 100n; // fixture range (0.01-2000) for property testing, not real rates
          side.push({ account: pick(codes), debit: convert(amountMinor, rateScaled), currency: pick(['CNY', 'USD']), amountMinor, rate: rateString(rateScaled), rateSource: 'bank_receipt' });
        } else {
          side.push({ account: pick(codes), debit: rnd(10n ** 11n) + 100n });
        }
      }
      const total = side.reduce((s, l) => s + (l.debit ?? 0n), 0n);
      const parts = Number(rnd(3n)) + 1;
      const other: Line[] = [];
      let left = total;
      for (let i = 0; i < parts - 1; i++) {
        const share = rnd(left - BigInt(parts - i - 1)) + 1n; // leaves at least 1 kobo for each remaining line
        other.push({ account: pick(codes), credit: share });
        left -= share;
      }
      other.push({ account: pick(codes), credit: left });
      // Half the time swap sides, so foreign lines also appear as credits.
      const flip = (l: Line): Line => ({ ...l, debit: l.credit ?? 0n, credit: l.debit ?? 0n });
      const lines = rnd(2n) === 0n ? [...side, ...other] : [...side.map(flip), ...other.map(flip)];
      return { periodId: periodA, date: `2026-01-${String(Number(rnd(31n)) + 1).padStart(2, '0')}`, lines };
    };

    const entriesBefore = await count(tenantA, 'journal_entries');
    const tbBefore = await trialBalance(tenantA);
    const N = 10_000;
    const BATCH = 250;
    for (let done = 0; done < N; done += BATCH) {
      await withTenant(pool, tenantA, async ({ client }) => {
        for (let i = 0; i < BATCH; i++) await insertEntry(client, tenantA, randomEntry());
      });
    }
    // Invalid entries, each in its own transaction: off by one kobo either way. All must be refused.
    let refused = 0;
    for (let i = 0; i < 100; i++) {
      const e = randomEntry();
      const last = e.lines[e.lines.length - 1];
      if (last?.debit) last.debit += 1n; else if (last?.credit) last.credit += 1n;
      if (last && !last.rate) last.amountMinor = (last.debit ?? 0n) + (last.credit ?? 0n);
      await post(tenantA, e).then(() => assert.fail('unbalanced entry posted'), () => { refused++; });
    }

    assert.equal(refused, 100);
    assert.equal(await count(tenantA, 'journal_entries'), entriesBefore + N);
    assert.equal(await count(tenantA, 'journal_entry_hashes'), entriesBefore + N);
    const tb = await trialBalance(tenantA);
    assert.equal(tb.dr - tb.cr, 0n, 'trial balance nets to zero');
    assert.ok(tb.dr > tbBefore.dr);
    assert.deepEqual(await chainBreaks(tenantA), []);
    assert.equal(await withTenant(pool, tenantB, async ({ client }) =>
      (await client.query('SELECT 1 FROM journal_entries WHERE tenant_id = $1', [tenantA])).rowCount), 0, 'cross-tenant read returns zero rows');
  });
});

import { Body, Controller, Headers, Inject, Post, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type pg from 'pg';
import type { Tx } from '@app/db';
import { CreatePosting, type Posting } from '@app/contracts';
import { customerReceipt, customerRefund, receivableReceipt, RuleError, type EntryType, type Line } from '@app/ledger';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { WRITE_LIMIT } from './throttle.js';
import { idempotentWrite, input, pgErrors } from './write.js';

type Status = { status(code: number): void };

// The database's own rules in our words (0001-0016). Our check messages name only this tenant's figures, and only roles
// that keep the books post, so they pass through as 422s; nothing here echoes another tenant's data.
const POSTING_ERRORS = pgErrors({
  journal_lines_evidence: [422, 'that document is not one of yours'],
  periods_no_overlap: [422, 'no single accounting period covers that date: ask the firm to set up the period'],
  // the same key again after its stored answer expired (7 days): the entry stands, nothing is posted twice
  journal_entries_idempotency: [409, 'this Idempotency-Key already posted an entry'],
}, true);

/** A rule in packages/ledger refusing the request's own figures (a refund larger than what is held, say): a 422 in its words. */
function rule(build: () => Line[]): Line[] {
  try {
    return build();
  } catch (err) {
    if (err instanceof RuleError) throw new UnprocessableEntityException(err.message);
    throw err; // anything else is a bug: a 500, and Sentry sees it
  }
}

/** The job order a car is on, and its customer: the posting's counterparty comes from here, never from the request. */
async function jobOf(t: Tx, vehicleId: string): Promise<{ customerId: string }> {
  const job = (await t.client.query<{ customer_id: string }>(
    'SELECT o.customer_id FROM job_order_vehicles jv JOIN job_orders o ON o.id = jv.job_order_id WHERE jv.vehicle_id = $1', [vehicleId])).rows[0];
  // another tenant's car looks exactly like no car
  if (!job) throw new UnprocessableEntityException('that car is not on one of your job orders');
  return { customerId: job.customer_id };
}

/** Every line naming the car, as the rules read them (ADR 0008: balances come from the ledger, never stored). */
async function historyOf(t: Tx, vehicleId: string): Promise<Line[]> {
  const rows = (await t.client.query<{
    code: string; debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; rate: string | null; rate_source: Line['rateSource'] | null;
    spot_rate: string | null; counterparty_id: string | null;
  }>(`SELECT a.code, l.debit_ngn, l.credit_ngn, l.currency, l.amount_minor, l.rate, l.rate_source, l.spot_rate, l.counterparty_id
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.vehicle_id = $1`, [vehicleId])).rows;
  return rows.map((r) => ({
    account: r.code, debit: BigInt(r.debit_ngn), credit: BigInt(r.credit_ngn), currency: r.currency.trim(), amountMinor: BigInt(r.amount_minor), vehicleId,
    ...(r.rate && { rate: r.rate }), ...(r.rate_source && { rateSource: r.rate_source }), ...(r.spot_rate && { spotRate: r.spot_rate }),
    ...(r.counterparty_id && { counterpartyId: r.counterparty_id }),
  }));
}

/**
 * The period an entry dated `date` falls in. Periods are calendar months: the first entry in a month opens it. A locked
 * month still refuses the entry (0001); a month the firm set up differently is used as it is.
 */
async function periodFor(t: Tx, tenantId: string, date: string): Promise<string> {
  const found = (await t.client.query<{ id: string }>('SELECT id FROM periods WHERE $1::date BETWEEN starts_on AND ends_on', [date])).rows[0];
  if (found) return found.id;
  return (await t.client.query<{ id: string }>(
    "INSERT INTO periods (tenant_id, starts_on, ends_on) VALUES ($1, date_trunc('month', $2::date)::date, (date_trunc('month', $2::date) + interval '1 month - 1 day')::date) RETURNING id",
    [tenantId, date]).catch(POSTING_ERRORS)).rows[0]?.id ?? '';
}

/** Insert one rule's lines as one entry of its type, run the whole-entry checks now, and return what posted with its flags. */
async function postEntry(t: Tx, caller: Caller, key: string, type: EntryType, p: CreatePosting, memo: string, lines: Line[]): Promise<Posting> {
  const codes = [...new Set(lines.map((l) => l.account))];
  const ids = new Map((await t.client.query<{ id: string; code: string }>('SELECT id, code FROM accounts WHERE code = ANY ($1)', [codes])).rows.map((r) => [r.code, r.id]));
  const missing = codes.find((c) => !ids.has(c));
  if (missing) throw new UnprocessableEntityException(`this business's chart has no account ${missing}: the firm seeds the default chart`);
  const period = await periodFor(t, caller.tenantId, p.entryDate);
  // The facts as asked, kept for good: the entry's source (an auditor follows source_id here). Receipt and voucher numbers
  // come with their own records in phase 3.
  const source = (await t.client.query<{ id: string }>('INSERT INTO postings (tenant_id, type, facts) VALUES ($1, $2, $3) RETURNING id',
    [caller.tenantId, type, JSON.stringify(p)])).rows[0]?.id ?? '';
  const entryId = (await t.client.query<{ id: string }>(
    `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [caller.tenantId, period, p.entryDate, memo, type, source, `posting:${key}`]).catch(POSTING_ERRORS)).rows[0]?.id ?? '';
  for (const l of lines) {
    await t.client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note, spot_rate, spot_source,
         evidence_document_id, vehicle_id, counterparty_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [caller.tenantId, entryId, ids.get(l.account), l.debit, l.credit, l.currency, l.amountMinor, l.rate ?? null, l.rateSource ?? null, l.rateNote ?? null,
        l.spotRate ?? null, l.spotSource ?? null, l.evidenceDocumentId ?? null, l.vehicleId ?? null, l.counterpartyId ?? null]).catch(POSTING_ERRORS);
  }
  // The commit-time checks (balance, shape, job rules, flags) run now, so a refusal is answered here; once the entry's hash
  // is written no line can be added, so running them early opens nothing (0007).
  await t.client.query('SET CONSTRAINTS ALL IMMEDIATE').catch(POSTING_ERRORS);
  const flags = (await t.client.query<{ id: string; kind: Posting['flags'][number]['kind']; vehicle_id: string }>(
    'SELECT id, kind, vehicle_id FROM job_order_flags WHERE entry_id = $1 ORDER BY id', [entryId])).rows;
  return {
    entryId, type, entryDate: p.entryDate, memo,
    lines: lines.map((l) => ({ account: l.account, debitNgn: String(l.debit), creditNgn: String(l.credit), currency: l.currency, amountMinor: String(l.amountMinor),
      vehicleId: l.vehicleId ?? null, counterpartyId: l.counterpartyId ?? null })),
    flags: flags.map((f) => ({ id: f.id, kind: f.kind, vehicleId: f.vehicle_id })),
  };
}

const MEMOS: Record<CreatePosting['type'], string> = {
  customer_receipt: 'Customer receipt', customer_refund: 'Refund to customer', receivable_receipt: 'Customer payment of balance owed',
};

/**
 * Postings (ADR 0017; owner 2026-11-17: one route with a typed body). Each type is one rule in packages/ledger: the API reads
 * the car's job, history and balances from the ledger, the rule builds the lines, and the database checks the entry fits its
 * type's shape before it commits.
 */
@Controller('postings')
export class PostingsController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Post()
  @Can('postings.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<Posting> {
    const p = input(CreatePosting, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /postings', body: p }, async (t) => {
      // The tenant's posting lock first (ADR 0017 §7): the history read below is then the ledger this entry commits against.
      await t.client.query("SELECT pg_advisory_xact_lock(hashtextextended('ledger:' || $1, 0))", [req.caller.tenantId]);
      const { customerId } = await jobOf(t, p.vehicleId);
      const facts = { vehicleId: p.vehicleId, counterpartyId: customerId, amountNgn: BigInt(p.amountNgn), ...(p.evidenceDocumentId && { evidenceDocumentId: p.evidenceDocumentId }) };
      let lines: Line[];
      switch (p.type) {
        case 'customer_receipt': lines = rule(() => customerReceipt(facts)); break;
        case 'customer_refund': { const history = await historyOf(t, p.vehicleId); lines = rule(() => customerRefund({ ...facts, history })); break; }
        case 'receivable_receipt': { const history = await historyOf(t, p.vehicleId); lines = rule(() => receivableReceipt({ ...facts, history })); break; }
      }
      return { status: 201, body: await postEntry(t, req.caller, key ?? '', p.type, p, p.memo ?? MEMOS[p.type], lines) };
    });
    res.status(out.status);
    return out.body;
  }
}

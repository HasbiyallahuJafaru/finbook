import { Body, Controller, Headers, Inject, NotFoundException, Param, Post, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import type pg from 'pg';
import type { Tx } from '@app/db';
import { AttachEvidence, CreatePosting, CreateReversal, type EntryEvidence, type Posting } from '@app/contracts';
import { parseRate, type Pool } from '@app/money';
import {
  buyCurrency, completeAgentJob, completeClearingJob, customerReceipt, customerRefund, payFromPool, payPayableFromPool, receivableReceipt, RuleError, supplierCredit,
  supplierInvoice, type EntryType, type Funding, type Line,
} from '@app/ledger';
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
  journal_lines_foreign_evidence: [422, 'a foreign-currency line needs its evidence document'],
  entry_evidence_one_per_entry: [409, 'that entry already has its evidence'],
  periods_no_overlap: [422, 'no single accounting period covers that date: ask the firm to set up the period'],
  // the same key again after its stored answer expired (7 days): the entry stands, nothing is posted twice
  journal_entries_idempotency: [409, 'this Idempotency-Key already posted an entry'],
  journal_entries_reversed_once: [409, 'that entry is already reversed'],
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

type JobRow = {
  customer_id: string; funding: Funding; job_type: 'car_purchase' | 'clearing_only'; car_price_currency: string | null; quote_rate: string | null;
  car_price_minor: string | null; landing_charge_ngn: string;
};
/** The job order a car is on: its customer, funding and the car's own quote come from here, never from the request. */
async function jobOf(t: Tx, vehicleId: string): Promise<{ customerId: string; funding: Funding; row: JobRow }> {
  const job = (await t.client.query<JobRow>(
    `SELECT o.customer_id, o.funding, o.job_type, o.car_price_currency, o.quote_rate::text, jv.car_price_minor::text, jv.landing_charge_ngn::text
       FROM job_order_vehicles jv JOIN job_orders o ON o.id = jv.job_order_id WHERE jv.vehicle_id = $1`, [vehicleId])).rows[0];
  // another tenant's car looks exactly like no car
  if (!job) throw new UnprocessableEntityException('that car is not on one of your job orders');
  return { customerId: job.customer_id, funding: job.funding, row: job };
}

/** A supplier or agent of this business (another tenant's looks like none). */
async function supplierOf(t: Tx, supplierId: string): Promise<string> {
  const found = await t.client.query("SELECT 1 FROM counterparties WHERE id = $1 AND kind IN ('supplier', 'agent')", [supplierId]);
  if (found.rowCount !== 1) throw new UnprocessableEntityException('the supplier must be one of your suppliers or agents');
  return supplierId;
}

/** The foreign-currency pool for one currency, from the ledger (ADR 0008): what it holds and what that cost in naira. */
async function poolOf(t: Tx, currency: string): Promise<Pool> {
  const r = (await t.client.query<{ bal: string; cost: string }>(
    `SELECT coalesce(sum(CASE WHEN l.debit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS bal, coalesce(sum(l.debit_ngn - l.credit_ngn), 0)::text AS cost
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1010' AND l.currency = $1`, [currency])).rows[0];
  return { balanceMinor: BigInt(r?.bal ?? '0'), costNgn: BigInt(r?.cost ?? '0') };
}

/** What is owed to one supplier for one car in one currency (2000), from the ledger: foreign amount and booked naira. */
async function payableOf(t: Tx, vehicleId: string, supplierId: string, currency: string): Promise<Pool> {
  const r = (await t.client.query<{ bal: string; cost: string }>(
    `SELECT coalesce(sum(CASE WHEN l.credit_ngn > 0 THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS bal, coalesce(sum(l.credit_ngn - l.debit_ngn), 0)::text AS cost
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.code = '2000' AND l.vehicle_id = $1 AND l.counterparty_id = $2 AND l.currency = $3`, [vehicleId, supplierId, currency])).rows[0];
  return { balanceMinor: BigInt(r?.bal ?? '0'), costNgn: BigInt(r?.cost ?? '0') };
}

/** Lines as the rules read them (ADR 0008: balances come from the ledger, never stored), with every column a reversal mirrors. */
async function linesWhere(t: Tx, where: 'l.vehicle_id = $1' | 'l.entry_id = $1', id: string): Promise<Line[]> {
  const rows = (await t.client.query<{
    code: string; debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; rate: string | null; rate_source: Line['rateSource'] | null;
    rate_note: string | null; spot_rate: string | null; spot_source: Line['spotSource'] | null; evidence_document_id: string | null; vehicle_id: string | null;
    counterparty_id: string | null;
  }>(`SELECT a.code, l.debit_ngn, l.credit_ngn, l.currency, l.amount_minor, l.rate, l.rate_source, l.rate_note, l.spot_rate, l.spot_source, l.evidence_document_id,
             l.vehicle_id, l.counterparty_id
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE ${where} ORDER BY l.id`, [id])).rows;
  return rows.map((r) => ({
    account: r.code, debit: BigInt(r.debit_ngn), credit: BigInt(r.credit_ngn), currency: r.currency.trim(), amountMinor: BigInt(r.amount_minor),
    ...(r.rate && { rate: r.rate }), ...(r.rate_source && { rateSource: r.rate_source }), ...(r.rate_note && { rateNote: r.rate_note }),
    ...(r.spot_rate && { spotRate: r.spot_rate }), ...(r.spot_source && { spotSource: r.spot_source }),
    ...(r.evidence_document_id && { evidenceDocumentId: r.evidence_document_id }), ...(r.vehicle_id && { vehicleId: r.vehicle_id }),
    ...(r.counterparty_id && { counterpartyId: r.counterparty_id }),
  }));
}
/** Every line naming the car. */
const historyOf = (t: Tx, vehicleId: string) => linesWhere(t, 'l.vehicle_id = $1', vehicleId);

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
async function postEntry(t: Tx, caller: Caller, key: string, type: EntryType, p: { entryDate: string }, memo: string, lines: Line[], reverses: string | null = null): Promise<Posting> {
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
    `INSERT INTO journal_entries (tenant_id, period_id, entry_date, memo, source_type, source_id, idempotency_key, reverses_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [caller.tenantId, period, p.entryDate, memo, type, source, `posting:${key}`, reverses]).catch(POSTING_ERRORS)).rows[0]?.id ?? '';
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
  currency_purchase: 'Foreign currency bought', pool_payment: 'Supplier paid from the pool', supplier_invoice: 'Supplier invoice',
  supplier_settlement: 'Supplier invoice paid from the pool', supplier_credit: 'Supplier credit', job_completion: 'Job completed',
};

/** The rule's lines for one posting, from the facts and what the ledger already says. */
async function linesFor(t: Tx, p: CreatePosting): Promise<Line[]> {
  const evidence = 'evidenceDocumentId' in p && p.evidenceDocumentId ? { evidenceDocumentId: p.evidenceDocumentId } : {};
  const spotOf = (s: { rate: string; source: 'cbn' | 'manual'; note?: string | undefined }) => ({ spot: { rate: parseRate(s.rate), source: s.source }, ...(s.note && { rateNote: s.note }) });
  switch (p.type) {
    case 'customer_receipt': case 'customer_refund': case 'receivable_receipt': {
      const { customerId } = await jobOf(t, p.vehicleId);
      const facts = { vehicleId: p.vehicleId, counterpartyId: customerId, amountNgn: BigInt(p.amountNgn), ...evidence };
      if (p.type === 'customer_receipt') return rule(() => customerReceipt(facts));
      const history = await historyOf(t, p.vehicleId);
      return p.type === 'customer_refund' ? rule(() => customerRefund({ ...facts, history })) : rule(() => receivableReceipt({ ...facts, history }));
    }
    case 'currency_purchase':
      return rule(() => buyCurrency({ currency: p.currency, amountMinor: BigInt(p.amountMinor), rate: parseRate(p.rate.rate), rateSource: p.rate.source,
        ...(p.rate.note && { rateNote: p.rate.note }), ...evidence }));
    case 'pool_payment': {
      const { funding } = await jobOf(t, p.vehicleId);
      const pool = await poolOf(t, p.currency);
      return rule(() => payFromPool({ pool, currency: p.currency, amountMinor: BigInt(p.amountMinor), vehicleId: p.vehicleId, funding, ...spotOf(p.spot), ...evidence }).lines);
    }
    case 'supplier_invoice': {
      const { funding } = await jobOf(t, p.vehicleId);
      const supplierId = await supplierOf(t, p.supplierId);
      return rule(() => supplierInvoice({ vehicleId: p.vehicleId, supplierId, currency: p.currency, amountMinor: BigInt(p.amountMinor), rate: parseRate(p.invoiceRate), funding,
        ...spotOf(p.spot), ...evidence }));
    }
    case 'supplier_settlement': {
      await jobOf(t, p.vehicleId);
      const supplierId = await supplierOf(t, p.supplierId);
      const [pool, payable] = [await poolOf(t, p.currency), await payableOf(t, p.vehicleId, supplierId, p.currency)];
      return rule(() => payPayableFromPool({ vehicleId: p.vehicleId, supplierId, pool, payable, currency: p.currency, amountMinor: BigInt(p.amountMinor),
        ...spotOf(p.spot), ...evidence }).lines);
    }
    case 'supplier_credit': {
      await jobOf(t, p.vehicleId);
      const supplierId = p.supplierId && await supplierOf(t, p.supplierId);
      const history = await historyOf(t, p.vehicleId);
      return rule(() => supplierCredit({ vehicleId: p.vehicleId, amountNgn: BigInt(p.amountNgn), history, ...(supplierId && { supplierId }), ...evidence }));
    }
    case 'job_completion': {
      // The car's own quote (owner 2026-11-17) and ledger. The database re-performs the cut, and refuses a job whose quote isn't accepted (0015).
      const { customerId, row } = await jobOf(t, p.vehicleId);
      const job = { vehicleId: p.vehicleId, counterpartyId: customerId, history: await historyOf(t, p.vehicleId) };
      const landingChargeNgn = BigInt(row.landing_charge_ngn);
      if (row.job_type === 'clearing_only') return rule(() => completeClearingJob({ ...job, landingChargeNgn }).lines);
      return rule(() => completeAgentJob({ ...job, quote: { currency: row.car_price_currency ?? '', sellingMinor: BigInt(row.car_price_minor ?? '0'),
        rate: parseRate(row.quote_rate ?? '0'), landingChargeNgn } }).lines);
    }
  }
}

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
      return { status: 201, body: await postEntry(t, req.caller, key ?? '', p.type, p, p.memo ?? MEMOS[p.type], await linesFor(t, p)) };
    });
    res.status(out.status);
    return out.body;
  }

  /**
   * A correction (owner 2026-11-17: firm roles only, ADR 0018): the exact mirror of a standing entry, with the same type, dated
   * in an open month. Each line keeps its original's evidence, so a correction needs no new slip. The database checks the
   * mirror, refuses a second reversal or the reversal of a reversal, and undoes what the original did to its job (0015).
   */
  @Post(':entryId/reversal')
  @Can('postings.reverse')
  @Throttle(WRITE_LIMIT)
  async reverse(@Req() req: { caller: Caller }, @Param('entryId') entryId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Status): Promise<Posting> {
    const entry = input(z.uuid(), entryId);
    const r = input(CreateReversal, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /postings/:entryId/reversal', body: [entry, r] }, async (t) => {
      await t.client.query("SELECT pg_advisory_xact_lock(hashtextextended('ledger:' || $1, 0))", [req.caller.tenantId]);
      const original = (await t.client.query<{ source_type: EntryType; memo: string }>('SELECT source_type, memo FROM journal_entries WHERE id = $1', [entry])).rows[0];
      // another tenant's entry looks exactly like no entry
      if (!original) throw new NotFoundException();
      // The document in the request backs only a foreign line that has none (posted before 0017); one that backs nothing is refused, not kept unused.
      const needsDoc = (l: Line) => l.currency !== 'NGN' && !l.evidenceDocumentId;
      const lines = await linesWhere(t, 'l.entry_id = $1', entry);
      if (r.evidenceDocumentId && !lines.some(needsDoc)) throw new UnprocessableEntityException('every foreign line of that entry already has its evidence: send no document');
      const mirror = lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, ...(needsDoc(l) && r.evidenceDocumentId && { evidenceDocumentId: r.evidenceDocumentId }) }));
      const facts = { ...r, reverses: entry }; // kept in postings: the entry it corrects, and why
      return { status: 201, body: await postEntry(t, req.caller, key ?? '', original.source_type, facts, r.memo ?? `Reversal: ${original.memo}`, mirror, entry) };
    });
    res.status(out.status);
    return out.body;
  }

  /**
   * Evidence for an entry that posted without it (owner 2026-11-17). The entry never changes: the document is attached
   * beside it, and the database refuses an entry that already has evidence or takes none. A document backing several entries is listed for review.
   */
  @Post(':entryId/evidence')
  @Can('postings.write')
  @Throttle(WRITE_LIMIT)
  async attach(@Req() req: { caller: Caller }, @Param('entryId') entryId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Status): Promise<EntryEvidence> {
    const entry = input(z.uuid(), entryId);
    const { documentId } = input(AttachEvidence, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /postings/:entryId/evidence', body: [entry, documentId] }, async (t) => {
      // another tenant's entry looks exactly like no entry
      if ((await t.client.query('SELECT 1 FROM journal_entries WHERE id = $1', [entry])).rowCount !== 1) throw new NotFoundException();
      const row = (await t.client.query<{ attached_by: string; attached_at: Date }>(
        'INSERT INTO entry_evidence (tenant_id, entry_id, document_id) VALUES ($1, $2, $3) RETURNING attached_by, attached_at',
        [req.caller.tenantId, entry, documentId]).catch(POSTING_ERRORS)).rows[0];
      return { status: 201, body: { entryId: entry, documentId, attachedBy: row?.attached_by ?? '', attachedAt: row?.attached_at.toISOString() ?? '' } };
    });
    res.status(out.status);
    return out.body;
  }
}

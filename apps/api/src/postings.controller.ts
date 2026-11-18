import { Body, Controller, Headers, Inject, NotFoundException, Param, Post, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { Throttle } from '@nestjs/throttler';
import type pg from 'pg';
import type { Tx } from '@app/db';
import { AttachEvidence, CreatePosting, CreateReversal, type EntryEvidence, type Posting } from '@app/contracts';
import { parseRate, type Pool } from '@app/money';
import {
  arriveInYard, buyCurrency, completeAgentJob, completeClearingJob, convertToStock, customerReceipt, customerRefund, payFromPool, payPayableFromPool, receivableReceipt,
  allocateCarCost, refundStockDeposit, RuleError, sellStockCar, stockDeposit, supplierCredit, supplierInvoice, type CostBasis, type CostCar, type EntryType, type Funding, type Line,
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
  // a car cost's split naming another tenant's container, car or cost type: the same answer as none
  cost_allocations_shipment: [422, 'that container is not one of yours'],
  cost_allocations_vehicle: [422, 'that car is not one of yours'],
  cost_allocations_cost_type: [422, 'that cost type is not one of yours'],
}, true);

/** A rule in packages/ledger refusing the request's own figures (a refund larger than what is held, say): a 422 in its words. */
function rule<T = Line[]>(build: () => T): T {
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
/**
 * The job order a car is on: its customer, funding and the car's own quote come from here, never from the request. A car
 * converted to stock (a standing conversion) is EMM stock from then on, whatever its job's funding (ledger audit of 0019): its
 * costs go to inventory (1200), as the database requires (0008).
 */
async function jobOf(t: Tx, vehicleId: string): Promise<{ customerId: string; funding: Funding; row: JobRow }> {
  const job = (await t.client.query<JobRow>(
    `SELECT o.customer_id, CASE WHEN EXISTS (
              SELECT 1 FROM journal_lines l JOIN journal_entries x ON x.id = l.entry_id
               WHERE l.vehicle_id = jv.vehicle_id AND x.source_type = 'stock_conversion' AND x.reverses_entry_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = x.id)) THEN 'emm_funded' ELSE o.funding END AS funding,
            o.job_type, o.car_price_currency, o.quote_rate::text, jv.car_price_minor::text, jv.landing_charge_ngn::text
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

/** A stock car's buyer: one of this business's customers (another tenant's looks like none). */
async function buyerOf(t: Tx, buyerId: string): Promise<string> {
  const found = await t.client.query("SELECT 1 FROM counterparties WHERE id = $1 AND kind = 'customer'", [buyerId]);
  if (found.rowCount !== 1) throw new UnprocessableEntityException('the buyer must be one of your customers');
  return buyerId;
}

/**
 * Who owes for a car (1100), from its ledger: the job's customer after a completion, the buyer after a stock sale (ADR 0018).
 * Nobody owing leaves the job's customer, and the rule refuses the receipt. ponytail: one debtor per car; two at once is refused
 * until the request names the payer.
 */
function debtorOf(history: readonly Line[], customerId: string): string {
  const owed = new Map<string, bigint>();
  for (const l of history) if (l.account === '1100' && l.counterpartyId) owed.set(l.counterpartyId, (owed.get(l.counterpartyId) ?? 0n) + l.debit - l.credit);
  const owing = [...owed].filter(([, n]) => n > 0n).map(([id]) => id);
  if (owing.length > 1) throw new UnprocessableEntityException('more than one party owes for this car');
  return owing[0] ?? customerId;
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

/** One car's row of a car cost's split (cost_allocations, 0019), in order: the remainder sits on position 1. */
type SplitRow = { vehicleId: string; costTypeId: string; shipmentId: string | null; basis: CostBasis; weightNgn: bigint | null; shareNgn: bigint };

/** Insert one rule's lines as one entry of its type, run the whole-entry checks now, and return what posted with its flags. */

async function postEntry(t: Tx, caller: Caller, key: string, type: EntryType, p: { entryDate: string }, memo: string, lines: Line[], reverses: string | null = null,
  split: SplitRow[] = []): Promise<Posting> {
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
  // A car cost's split is kept with it, before the checks below re-perform it against these lines (0019).
  for (const [i, r] of split.entries()) {
    await t.client.query(
      'INSERT INTO cost_allocations (tenant_id, entry_id, position, vehicle_id, cost_type_id, shipment_id, basis, weight_ngn, share_ngn) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [caller.tenantId, entryId, i + 1, r.vehicleId, r.costTypeId, r.shipmentId, r.basis, r.weightNgn, r.shareNgn]).catch(POSTING_ERRORS);
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
  stock_deposit: 'Buyer deposit on a stock car', stock_deposit_refund: 'Buyer deposit refunded', yard_arrival: 'Car arrived in the yard',
  stock_sale: 'Stock car sold', stock_conversion: 'Job converted to stock', car_cost: 'Car cost',
};

/**
 * A car cost's lines and split. The cars come from the request (one car, the shares typed) or from the container; each car's
 * funding from its job; the weights (by value) from the cars' ledgers; the cost type must be this business's own.
 */
async function carCostOf(t: Tx, p: Extract<CreatePosting, { type: 'car_cost' }>): Promise<{ lines: Line[]; split: SplitRow[] }> {
  if ((await t.client.query('SELECT 1 FROM cost_types WHERE id = $1', [p.costTypeId])).rowCount !== 1) throw new UnprocessableEntityException('that cost type is not one of yours');
  const s = p.split;
  const shipmentId = 'shipmentId' in s ? (s.shipmentId ?? null) : null;
  let ids: string[];
  if (s.basis === 'per_car') ids = [s.vehicleId];
  else if (s.basis === 'manual') ids = s.shares.map((x) => x.vehicleId);
  else {
    ids = (await t.client.query<{ vehicle_id: string }>('SELECT vehicle_id FROM shipment_vehicles WHERE shipment_id = $1 AND removed_at IS NULL ORDER BY created_at, id', [s.shipmentId])).rows.map((r) => r.vehicle_id);
    // another tenant's container looks exactly like an empty one
    if (ids.length === 0) throw new UnprocessableEntityException('that container has no cars of yours');
  }
  const cars: CostCar[] = [];
  const history: Line[] = [];
  for (const [i, vehicleId] of ids.entries()) {
    const { funding } = await jobOf(t, vehicleId);
    if (s.basis === 'by_value') history.push(...await historyOf(t, vehicleId));
    cars.push({ vehicleId, funding, ...(s.basis === 'manual' && { shareNgn: BigInt(s.shares[i]?.amountNgn ?? '0') }) });
  }
  const built = rule(() => allocateCarCost({ amountNgn: BigInt(p.amountNgn), basis: s.basis, cars, history, ...(p.evidenceDocumentId && { evidenceDocumentId: p.evidenceDocumentId }) }));
  return {
    lines: built.lines,
    split: ids.map((vehicleId, i) => ({ vehicleId, costTypeId: p.costTypeId, shipmentId, basis: s.basis, weightNgn: built.weights?.[i] ?? null, shareNgn: built.shares[i] ?? 0n })),
  };
}

/** The rule's lines for one posting, from the facts and what the ledger already says. */
async function linesFor(t: Tx, p: Exclude<CreatePosting, { type: 'car_cost' }>): Promise<Line[]> {
  const evidence = 'evidenceDocumentId' in p && p.evidenceDocumentId ? { evidenceDocumentId: p.evidenceDocumentId } : {};
  const spotOf = (s: { rate: string; source: 'cbn' | 'manual'; note?: string | undefined }) => ({ spot: { rate: parseRate(s.rate), source: s.source }, ...(s.note && { rateNote: s.note }) });
  switch (p.type) {
    case 'customer_receipt': case 'customer_refund': case 'receivable_receipt': {
      const { customerId } = await jobOf(t, p.vehicleId);
      const facts = { vehicleId: p.vehicleId, counterpartyId: customerId, amountNgn: BigInt(p.amountNgn), ...evidence };
      if (p.type === 'customer_receipt') return rule(() => customerReceipt(facts));
      const history = await historyOf(t, p.vehicleId);
      if (p.type === 'customer_refund') return rule(() => customerRefund({ ...facts, history }));
      // the payer is whoever owes for the car: after a stock sale, the buyer, not the job's customer
      return rule(() => receivableReceipt({ ...facts, counterpartyId: debtorOf(history, customerId), history }));
    }
    case 'stock_deposit': case 'stock_deposit_refund': case 'stock_sale': {
      await jobOf(t, p.vehicleId);
      const buyer = { vehicleId: p.vehicleId, counterpartyId: await buyerOf(t, p.buyerId) };
      if (p.type === 'stock_deposit') return rule(() => stockDeposit({ ...buyer, amountNgn: BigInt(p.amountNgn), ...evidence }));
      const history = await historyOf(t, p.vehicleId);
      if (p.type === 'stock_deposit_refund') return rule(() => refundStockDeposit({ ...buyer, amountNgn: BigInt(p.amountNgn), history, ...evidence }));
      return rule(() => sellStockCar({ ...buyer, priceNgn: BigInt(p.priceNgn), history, ...evidence }));
    }
    case 'yard_arrival': {
      await jobOf(t, p.vehicleId);
      const history = await historyOf(t, p.vehicleId);
      return rule(() => arriveInYard({ vehicleId: p.vehicleId, history }));
    }
    case 'stock_conversion': {
      const { customerId } = await jobOf(t, p.vehicleId);
      const history = await historyOf(t, p.vehicleId);
      return rule(() => convertToStock({ vehicleId: p.vehicleId, counterpartyId: customerId, history, ...evidence }));
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
      const built = p.type === 'car_cost' ? await carCostOf(t, p) : { lines: await linesFor(t, p), split: [] };
      return { status: 201, body: await postEntry(t, req.caller, key ?? '', p.type, p, p.memo ?? MEMOS[p.type], built.lines, null, built.split) };
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

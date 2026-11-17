// Posting rules: business events in, balanced journal lines out. Pure functions: no DB, no clock, no
// randomness. All arithmetic goes through packages/money. Accounts are chart codes (spec → Vehicle module);
// the API maps them to account ids and persists each result as one journal entry.
// ponytail: cash is always 1000, costs are paid in cash, and the foreign-currency pool is account 1010 for every
// currency; add bank-account and per-currency pool accounts when the API needs them.
import { allocateEqual, convert, formatRate, parseRate, poolSpend, rateOf, type Pool } from '@app/money';

/**
 * The entry type (journal_entries.source_type) each rule's lines post as. The database holds one shape per type and refuses
 * an entry that doesn't fit it (migration 0015, entry_shapes); a reversal keeps the type it reverses. manual_journal names no
 * car and keeps off the accounts these rules own.
 */
export type EntryType =
  | 'customer_receipt' | 'customer_refund' | 'receivable_receipt'
  | 'currency_purchase' | 'pool_payment' | 'supplier_invoice' | 'supplier_settlement' | 'car_cost' | 'supplier_credit'
  | 'job_completion' | 'stock_deposit' | 'stock_deposit_refund' | 'yard_arrival' | 'stock_sale' | 'stock_conversion'
  | 'fx_revaluation' | 'manual_journal';

/** A rule refusing the event's own figures (a refund larger than what is held, say): the API answers it as a 422 in these words. */
export class RuleError extends Error {}

export type RateSource = 'bank_receipt' | 'bdc_receipt' | 'agent_invoice' | 'manual' | 'pool_average' | 'payable_average';
/** The day's spot (reference) rate, and where it came from: the stored CBN rate, or typed in with a note (ADR 0009, 0010). */
export type Spot = { rate: bigint; source: 'cbn' | 'manual' };
export type Line = {
  account: string;
  debit: bigint;
  credit: bigint;
  currency: string;
  amountMinor: bigint;
  rate?: string;
  rateSource?: RateSource;
  rateNote?: string;
  /** Spot rate on the transaction day: required on pool payments and supplier invoices, for the spot basis clients see. */
  spotRate?: string;
  spotSource?: Spot['source'];
  evidenceDocumentId?: string;
  vehicleId?: string;
  counterpartyId?: string;
};
type Tags = Pick<Line, 'vehicleId' | 'counterpartyId' | 'evidenceDocumentId'>;
/**
 * Who funds a car's purchase (ADR 0001). customer_funded (default): agent accounting, the car's cost is recoverable from the
 * customer (1150). emm_funded: principal accounting, the car is EMM's inventory (1200 in transit, then 1210 in the yard).
 */
export type Funding = 'customer_funded' | 'emm_funded';
const costAccount = (f: Funding | undefined) => (f === 'emm_funded' ? '1200' : '1150');
/** The customer's job a line belongs to: every 2150 and 1100 line carries both, so funds held are traceable. */
type Job = { vehicleId: string; counterpartyId: string };

const positive = (n: bigint, what: string) => {
  if (n <= 0n) throw new RuleError(`${what} must be positive`);
};
const tagged = (t: Tags): Tags => ({
  ...(t.vehicleId && { vehicleId: t.vehicleId }),
  ...(t.counterpartyId && { counterpartyId: t.counterpartyId }),
  ...(t.evidenceDocumentId && { evidenceDocumentId: t.evidenceDocumentId }),
});

/** An NGN line: positive = debit, negative = credit, zero = no line at all. */
function ngn(account: string, signed: bigint, tags: Tags = {}): Line[] {
  if (signed === 0n) return [];
  const amount = signed > 0n ? signed : -signed;
  return [{ account, debit: signed > 0n ? amount : 0n, credit: signed < 0n ? amount : 0n, currency: 'NGN', amountMinor: amount, ...tagged(tags) }];
}

/** Customer pays towards a job: the money is theirs until the job completes. Dr cash, Cr 2150 customer funds held. */
export function customerReceipt(e: Job & { amountNgn: bigint; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'receipt');
  return [...ngn('1000', e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId }), ...ngn('2150', -e.amountNgn, e)];
}

/** Pay a customer back from their funds held (they overpaid, or walked away: owner 2026-11-15, never forfeited). Dr 2150 / Cr cash. */
export function customerRefund(e: Job & { amountNgn: bigint; history: readonly Line[]; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'refund');
  if (e.amountNgn > -carBalance(e.history, e.vehicleId, '2150')) throw new RuleError('refund exceeds the customer funds held for this job');
  return [...ngn('2150', e.amountNgn, e), ...ngn('1000', -e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId })];
}

/** The customer pays what they owe after a completion or stock sale (1100). Dr cash / Cr 1100, never more than is owed. */
export function receivableReceipt(e: Job & { amountNgn: bigint; history: readonly Line[]; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'receipt');
  const owed = carBalance(e.history.filter((l) => l.counterpartyId === e.counterpartyId), e.vehicleId, '1100');
  if (e.amountNgn > owed) throw new RuleError('receipt exceeds what this customer owes for this car');
  return [...ngn('1000', e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId }), ...ngn('1100', -e.amountNgn, e)];
}

/**
 * A supplier's NGN credit note or refund on a customer job (flagged cost_credited for a reviewer, 0014): the car's job costs
 * come down, off what is owed to that supplier for that car (Dr 2000, naming both), or as cash back (Dr 1000).
 * ponytail: NGN, customer-funded and before completion only; a foreign or EMM-funded credit, or one after completion, needs its own rule (ADR 0016).
 */
export function supplierCredit(e: { vehicleId: string; amountNgn: bigint; history: readonly Line[]; supplierId?: string; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'credit');
  if (e.amountNgn > carBalance(e.history, e.vehicleId, '1150')) throw new RuleError('credit exceeds the job costs recorded for this car');
  const against = e.supplierId
    ? ngn('2000', e.amountNgn, { vehicleId: e.vehicleId, counterpartyId: e.supplierId, evidenceDocumentId: e.evidenceDocumentId })
    : ngn('1000', e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId });
  return [...against, ...ngn('1150', -e.amountNgn, { vehicleId: e.vehicleId })];
}

/** Buy foreign currency at the rate on the receipt: it joins the weighted-average pool (1010). */
export function buyCurrency(e: { currency: string; amountMinor: bigint; rate: bigint; rateSource: 'bank_receipt' | 'bdc_receipt' | 'manual'; rateNote?: string; evidenceDocumentId?: string }): Line[] {
  positive(e.amountMinor, 'amount');
  const cost = convert(e.amountMinor, e.rate);
  return [
    {
      account: '1010', debit: cost, credit: 0n, currency: e.currency, amountMinor: e.amountMinor, rate: formatRate(e.rate), rateSource: e.rateSource,
      ...(e.rateNote && { rateNote: e.rateNote }), ...tagged(e),
    },
    ...ngn('1000', -cost),
  ];
}

/**
 * Pay a supplier from the pool for one car's job. The car carries the pool's weighted-average NGN cost
 * (spec → Currency and FX, rule 4). The foreign line's rate is that cost / amount (rate source pool_average);
 * the database re-computes the pool under the tenant lock and refuses any other figure (migration 0004).
 */
export function payFromPool(e: { pool: Pool; currency: string; amountMinor: bigint; vehicleId: string; spot: Spot; rateNote?: string; evidenceDocumentId?: string; funding?: Funding }): { lines: Line[]; pool: Pool } {
  const out = poolOut(e, { vehicleId: e.vehicleId, evidenceDocumentId: e.evidenceDocumentId });
  return { pool: out.pool, lines: [...ngn(costAccount(e.funding), out.line.credit, { vehicleId: e.vehicleId }), out.line] };
}

/** The spot fields of a line. A manual spot rate needs a note saying why it differs from the CBN rate. */
function spotOf(spot: Spot, rateNote: string | undefined): Pick<Line, 'spotRate' | 'spotSource' | 'rateNote'> {
  positive(spot.rate, 'spot rate');
  if (spot.source === 'manual' && !rateNote?.trim()) throw new RuleError('a manual spot rate needs a note');
  return { spotRate: formatRate(spot.rate), spotSource: spot.source, ...(rateNote && { rateNote }) };
}

/** Currency leaving the pool at its weighted-average cost, with the day's spot rate recorded for the spot basis. */
function poolOut(e: { pool: Pool; currency: string; amountMinor: bigint; spot: Spot; rateNote?: string }, tags: Tags): { line: Line; pool: Pool } {
  const spot = spotOf(e.spot, e.rateNote);
  const { costNgn, pool } = poolSpend(e.pool, e.amountMinor);
  // ponytail: a pool left holding currency with no NGN cost (rounding at extreme rates) refuses payments. 1010 takes no NGN
  // lines (migration 0006) and revaluation only moves 1019, so clearing it needs its own entry type; add one if it ever happens.
  if (costNgn === 0n) throw new RuleError('pool payment rounds to zero kobo');
  return {
    pool,
    line: {
      account: '1010', debit: 0n, credit: costNgn, currency: e.currency, amountMinor: e.amountMinor,
      rate: formatRate(rateOf(costNgn, e.amountMinor)), rateSource: 'pool_average', ...spot, ...tagged(tags),
    },
  };
}

/** A supplier and the car their invoice is for. The supplier is a different party from the job's customer. */
type SupplierBill = { vehicleId: string; supplierId: string };

/**
 * A supplier's invoice for one car, in foreign currency at the invoice rate: the car's cost goes up and a
 * foreign-currency payable (2000) is owed. The invoice-day spot rate is recorded for the spot basis (ADR 0009).
 */
export function supplierInvoice(e: SupplierBill & { currency: string; amountMinor: bigint; rate: bigint; spot: Spot; rateNote?: string; evidenceDocumentId?: string; funding?: Funding }): Line[] {
  positive(e.amountMinor, 'amount');
  const booked = convert(e.amountMinor, e.rate);
  return [
    ...ngn(costAccount(e.funding), booked, { vehicleId: e.vehicleId }),
    {
      account: '2000', debit: 0n, credit: booked, currency: e.currency, amountMinor: e.amountMinor, rate: formatRate(e.rate), rateSource: 'agent_invoice',
      ...spotOf(e.spot, e.rateNote), ...tagged({ vehicleId: e.vehicleId, counterpartyId: e.supplierId, evidenceDocumentId: e.evidenceDocumentId }),
    },
  ];
}

/**
 * Settle (part of) what's owed to a supplier for one car, from the pool. `payable` is the outstanding balance for
 * that supplier and car in this currency (foreign amount and booked NGN), read from the ledger like the pool. The payable
 * comes off at its weighted-average booked cost (paying the rest takes exactly what's left, so no kobo is stranded),
 * the currency leaves the pool at its average cost, and the difference is realized FX (7000), spec FX rule 5.
 * The payable and FX lines name the car, so realized FX lands on the right car; the pool line doesn't (the car was
 * capitalized at invoice), and car cost counts only invoice lines, so nothing is counted twice.
 */
export function payPayableFromPool(e: SupplierBill & {
  pool: Pool; payable: Pool; currency: string; amountMinor: bigint; spot: Spot; rateNote?: string; evidenceDocumentId?: string;
}): { lines: Line[]; pool: Pool; payable: Pool } {
  if (e.amountMinor > e.payable.balanceMinor) throw new RuleError('payment exceeds what is owed to this supplier for this car');
  const settled = poolSpend(e.payable, e.amountMinor);
  const out = poolOut(e, { counterpartyId: e.supplierId, evidenceDocumentId: e.evidenceDocumentId });
  const tags = tagged({ vehicleId: e.vehicleId, counterpartyId: e.supplierId, evidenceDocumentId: e.evidenceDocumentId });
  return {
    pool: out.pool,
    payable: settled.pool,
    lines: [
      { account: '2000', debit: settled.costNgn, credit: 0n, currency: e.currency, amountMinor: e.amountMinor, rate: formatRate(rateOf(settled.costNgn, e.amountMinor)), rateSource: 'payable_average', ...tags },
      out.line,
      ...ngn('7000', -(settled.costNgn - out.line.credit), { vehicleId: e.vehicleId }),
    ],
  };
}

/**
 * A car's foreign-currency cost, net: pool payments (1010) and supplier invoices (2000, agent_invoice) that name the car.
 * Credits add, debits (reversals) subtract, so a reversed payment or invoice drops out exactly. Settling a payable
 * (payable_average) is not a cost: the invoice already was.
 */
function carCost(history: readonly Line[], vehicleId: string) {
  const isCost = (l: Line) => (l.account === '1010' && l.rateSource !== 'payable_average') || (l.account === '2000' && l.rateSource === 'agent_invoice');
  const lines = history.filter((l) => l.vehicleId === vehicleId && l.currency !== 'NGN' && isCost(l));
  const sign = (l: Line) => (l.credit > 0n ? 1n : -1n);
  const net = (c: string) => lines.filter((l) => l.currency === c).reduce((s, l) => s + sign(l) * l.amountMinor, 0n);
  return {
    // a currency whose payments were all reversed nets to nothing and doesn't count (as the database, migration 0015)
    currencies: new Set(lines.map((l) => l.currency).filter((c) => net(c) !== 0n)),
    minor: lines.reduce((s, l) => s + sign(l) * l.amountMinor, 0n),
    ngn: lines.reduce((s, l) => s + l.credit - l.debit, 0n),
    spotNgn: lines.reduce((s, l) => s + sign(l) * (l.spotRate ? convert(l.amountMinor, parseRate(l.spotRate)) : l.credit + l.debit), 0n),
  };
}

/**
 * Spot-basis cost of a car's foreign purchase (ADR 0009, IAS 21): each pool payment at the spot rate on its payment
 * day, each supplier invoice at the spot rate on its invoice day. Pool basis stays in jobPosition, for the firm.
 */
export const spotCarCost = (history: readonly Line[], vehicleId: string): bigint => carCost(history, vehicleId).spotNgn;

/** An NGN cost for one or more cars (a container charge, or one car's IDEC bill), split equally in kobo, remainder on the first car. */
export function sharedCost(e: { amountNgn: bigint; vehicleIds: readonly string[]; evidenceDocumentId?: string; funding?: Funding }): Line[] {
  positive(e.amountNgn, 'cost');
  if (e.vehicleIds.length === 0) throw new RuleError('a cost needs at least one car');
  if (new Set(e.vehicleIds).size !== e.vehicleIds.length) throw new RuleError('a car can appear only once in a cost split');
  const shares = allocateEqual(e.amountNgn, e.vehicleIds.length);
  // ponytail: one funding for every car in the split; split a container holding both kinds of car into two costs.
  return [...shares.flatMap((share, i) => ngn(costAccount(e.funding), share, { vehicleId: e.vehicleIds[i] })), ...ngn('1000', -e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId })];
}

/** What the ledger says about one car's job: its supplier cost, everything capitalized, and the customer's funds held. */
export function jobPosition(history: readonly Line[], vehicleId: string) {
  const mine = history.filter((l) => l.vehicleId === vehicleId);
  const car = carCost(history, vehicleId);
  if (car.currencies.size > 1) throw new RuleError('a car must be paid for in one currency');
  const net = (account: string) => mine.filter((l) => l.account === account).reduce((s, l) => s + l.debit - l.credit, 0n);
  return {
    carCurrency: [...car.currencies][0],
    carMinor: car.minor,
    carNgn: car.ngn,
    costNgn: net('1150'), // everything capitalized for this car: completion clears it to exactly zero
    fundsHeldNgn: -net('2150'),
  };
}

/** Settle an invoice from the customer's funds held, with any balance owed going to receivables. Both lines name the job. */
function settle(invoiceNgn: bigint, fundsHeldNgn: bigint, job: Job): Line[] {
  if (fundsHeldNgn < 0n) throw new RuleError('customer funds held for this job are negative');
  const fromFunds = fundsHeldNgn < invoiceNgn ? fundsHeldNgn : invoiceNgn;
  return [...ngn('2150', fromFunds, job), ...ngn('1100', invoiceNgn - fromFunds, job)];
}

/**
 * Complete a customer-funded car-purchase job (agent accounting, ADR 0001/0002). The cut is never typed in, and
 * neither are the costs: they come from the car's own ledger history. Car markup (4100) = selling price - car cost,
 * both at the quote-day rate; clearing margin (4200) = landing charge - actual landed cost; the gap between the
 * quote-day rate and the rate actually paid goes to FX (7000).
 */
export function completeAgentJob(e: Job & {
  quote: { currency: string; sellingMinor: bigint; rate: bigint; landingChargeNgn: bigint };
  history: readonly Line[];
}): { lines: Line[]; invoiceNgn: bigint } {
  positive(e.quote.sellingMinor, 'selling price');
  if (e.quote.landingChargeNgn < 0n) throw new RuleError('landing charge cannot be negative');
  notStock(e.history, e.vehicleId);
  const p = jobPosition(e.history, e.vehicleId);
  if (p.carMinor === 0n) throw new RuleError('no supplier payment recorded for this car');
  if (p.carCurrency !== e.quote.currency) throw new RuleError(`quote is in ${e.quote.currency} but the car was paid in ${String(p.carCurrency)}`);
  const landedNgn = p.costNgn - p.carNgn;
  const sellingNgn = convert(e.quote.sellingMinor, e.quote.rate);
  const carAtQuoteNgn = convert(p.carMinor, e.quote.rate);
  const invoiceNgn = sellingNgn + e.quote.landingChargeNgn;
  const car = { vehicleId: e.vehicleId };
  return {
    invoiceNgn,
    lines: [
      ...settle(invoiceNgn, p.fundsHeldNgn, e),
      ...ngn('1150', -p.costNgn, car),
      ...ngn('4100', -(sellingNgn - carAtQuoteNgn), car),
      ...ngn('4200', -(e.quote.landingChargeNgn - landedNgn), car),
      ...ngn('7000', -(carAtQuoteNgn - p.carNgn), car),
    ],
  };
}

/** Complete a clearing-only job: the car was never ours; revenue is the landing charge minus the landed cost. */
export function completeClearingJob(e: Job & { landingChargeNgn: bigint; history: readonly Line[] }): { lines: Line[]; invoiceNgn: bigint } {
  positive(e.landingChargeNgn, 'landing charge');
  notStock(e.history, e.vehicleId);
  const p = jobPosition(e.history, e.vehicleId);
  const car = { vehicleId: e.vehicleId };
  return {
    invoiceNgn: e.landingChargeNgn,
    lines: [
      ...settle(e.landingChargeNgn, p.fundsHeldNgn, e),
      ...ngn('1150', -p.costNgn, car),
      ...ngn('4200', -(e.landingChargeNgn - p.costNgn), car),
    ],
  };
}

/** One car's net balance on one account, from its ledger history. */
const carBalance = (history: readonly Line[], vehicleId: string, account: string) =>
  history.filter((l) => l.vehicleId === vehicleId && l.account === account).reduce((s, l) => s + l.debit - l.credit, 0n);
/** Whether any of these accounts holds a balance for the car. Net, so a reversed mistake (entry plus its mirror) counts as nothing. */
const touched = (history: readonly Line[], vehicleId: string, accounts: readonly string[]) =>
  accounts.some((a) => carBalance(history, vehicleId, a) !== 0n);
/** A car in inventory, or sold from it, is EMM stock (EMM-funded or converted): it is sold, never completed as a job (migration 0008). */
function notStock(history: readonly Line[], vehicleId: string) {
  if (touched(history, vehicleId, ['1200', '1210', '4000', '5000'])) throw new RuleError('this car is EMM stock: sell it (sellStockCar), it is not completed as a job');
}

/** A buyer's deposit towards an EMM-funded stock car (principal): theirs until the sale, held in 2100 customer deposits. */
export function stockDeposit(e: Job & { amountNgn: bigint; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'deposit');
  return [...ngn('1000', e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId }), ...ngn('2100', -e.amountNgn, e)];
}

/** Pay a buyer's deposit back (they walked away, or paid more than the price): Dr 2100 / Cr cash, never more than they paid. */
export function refundStockDeposit(e: Job & { amountNgn: bigint; history: readonly Line[]; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'refund');
  const paid = -carBalance(e.history.filter((l) => l.counterpartyId === e.counterpartyId), e.vehicleId, '2100');
  if (e.amountNgn > paid) throw new RuleError('refund exceeds what this buyer paid towards this car');
  return [...ngn('2100', e.amountNgn, e), ...ngn('1000', -e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId })];
}

/** An EMM-funded car reaches the yard: its whole in-transit cost (1200) moves to 1210, read from its ledger history. */
export function arriveInYard(e: { vehicleId: string; history: readonly Line[] }): Line[] {
  const cost = carBalance(e.history, e.vehicleId, '1200');
  positive(cost, 'in-transit cost');
  const car = { vehicleId: e.vehicleId };
  return [...ngn('1210', cost, car), ...ngn('1200', -cost, car)];
}

/**
 * Sell an EMM-funded stock car (principal, spec → Vehicle module): gross revenue (4000) at the price, paid first from the
 * buyer's deposits (2100) with the rest receivable (1100); the car's full landed cost (specific identification) moves from
 * 1210 to 5000. The database refuses a sale that doesn't clear the car's 1210 (migration 0008).
 * ponytail: NGN price only; an RMB-priced stock sale needs the quote-day rate and FX-on-sale line like completeAgentJob.
 */
export function sellStockCar(e: Job & { priceNgn: bigint; history: readonly Line[] }): Line[] {
  positive(e.priceNgn, 'price');
  if (carBalance(e.history, e.vehicleId, '1200') !== 0n) throw new RuleError('the car is still in transit: record its arrival in the yard first');
  const cost = carBalance(e.history, e.vehicleId, '1210');
  positive(cost, 'cost in the yard');
  // Only this buyer's deposits on this car: another buyer's deposit stays theirs (refundStockDeposit).
  const deposits = -carBalance(e.history.filter((l) => l.counterpartyId === e.counterpartyId), e.vehicleId, '2100');
  if (deposits > e.priceNgn) throw new RuleError('deposits exceed the price: refund the difference first (refundStockDeposit)');
  const car = { vehicleId: e.vehicleId };
  return [
    ...ngn('2100', deposits, e), ...ngn('1100', e.priceNgn - deposits, e), ...ngn('4000', -e.priceNgn, car),
    ...ngn('5000', cost, car), ...ngn('1210', -cost, car),
  ];
}

/**
 * A customer abandons a customer-funded job after EMM paid the supplier ("convert to stock", spec → Vehicle module): the
 * car becomes EMM's inventory (1200) at everything capitalized for it in 1150, and the customer's funds held (2150) are
 * repaid in full. Owner ruling 2026-11-15 (ADR 0012): a deposit is never forfeited.
 */
export function convertToStock(e: Job & { history: readonly Line[]; evidenceDocumentId?: string }): Line[] {
  // ponytail: a completion at a zero cut posts no 4100/4200 line, and a flat line history can't show which 1150 credit was a
  // completion; the database refuses that case (migration 0008 reads entries). Pass job status here once job_orders exists.
  if (touched(e.history, e.vehicleId, ['4100', '4200'])) throw new RuleError('this job is already completed: it cannot be converted to stock');
  notStock(e.history, e.vehicleId);
  const p = jobPosition(e.history, e.vehicleId);
  positive(p.costNgn, 'job cost');
  if (p.carMinor === 0n) throw new RuleError('only a car EMM paid the supplier for can become stock: a clearing-only job is the customer\'s own car');
  if (p.fundsHeldNgn < 0n) throw new RuleError('customer funds held for this job are negative');
  const car = { vehicleId: e.vehicleId };
  return [
    ...ngn('1200', p.costNgn, car), ...ngn('1150', -p.costNgn, car),
    ...ngn('2150', p.fundsHeldNgn, e), ...ngn('1000', -p.fundsHeldNgn, { evidenceDocumentId: e.evidenceDocumentId }),
  ];
}

/** One monetary balance restated at month-end: the pool (1010) or the foreign supplier payables (2000), in one currency. */
export type RevaluationItem = {
  item: 'pool' | 'payables';
  currency: string;
  /** Foreign amount held (pool) or owed (payables) on the period's last day, read from the ledger. */
  balanceMinor: bigint;
  /** NGN it is carried at: cost on 1010 or booked on 2000, plus any revaluation still standing on 1019 or 2009. */
  carryingNgn: bigint;
  /** The CBN closing rate (latest revision, on or before the last day); the database checks it (migration 0007). */
  closingRate: bigint;
};

/**
 * Month-end revaluation (spec FX rule 6, ADR 0011): each item restated at the closing rate, the difference in 7100
 * Unrealized FX. The adjustment sits on 1019 (pool) and 2009 (payables), never on 1010 or 2000, so pool and payable
 * costs stay what was paid. `rows` is the evidence the database stores and re-performs; `reversal` posts on day 1 of the
 * next period. A gain on the pool, or a fall in what is owed, is a credit to 7100.
 */
export function revalue(items: readonly RevaluationItem[]): { lines: Line[]; reversal: Line[]; rows: (RevaluationItem & { closingNgn: bigint })[] } {
  const seen = new Set<string>();
  const rows = items.map((i) => {
    if (i.currency === 'NGN') throw new RuleError('NGN is not revalued');
    if (i.balanceMinor < 0n) throw new RuleError(`the ${i.currency} ${i.item} balance cannot be negative`);
    positive(i.closingRate, 'closing rate');
    const key = `${i.currency} ${i.item}`;
    if (seen.has(key)) throw new RuleError(`the ${key} is listed twice`);
    seen.add(key);
    return { ...i, closingNgn: convert(i.balanceMinor, i.closingRate) };
  });
  const lines = rows.flatMap((r) => {
    const diff = r.closingNgn - r.carryingNgn;
    return r.item === 'pool' ? [...ngn('1019', diff), ...ngn('7100', -diff)] : [...ngn('7100', diff), ...ngn('2009', -diff)];
  });
  return { lines, reversal: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })), rows };
}

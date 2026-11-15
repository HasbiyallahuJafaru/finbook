// Posting rules: business events in, balanced journal lines out. Pure functions: no DB, no clock, no
// randomness. All arithmetic goes through packages/money. Accounts are chart codes (spec → Vehicle module);
// the API maps them to account ids and persists each result as one journal entry.
// ponytail: cash is always 1000, costs are paid in cash, and the foreign-currency pool is account 1010 for every
// currency; add bank-account and per-currency pool accounts when the API needs them.
import { allocateEqual, convert, formatRate, parseRate, poolSpend, rateOf, type Pool } from '@app/money';

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
/** The customer's job a line belongs to: every 2150 and 1100 line carries both, so funds held are traceable. */
type Job = { vehicleId: string; counterpartyId: string };

const positive = (n: bigint, what: string) => {
  if (n <= 0n) throw new Error(`${what} must be positive`);
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
export function payFromPool(e: { pool: Pool; currency: string; amountMinor: bigint; vehicleId: string; spot: Spot; rateNote?: string; evidenceDocumentId?: string }): { lines: Line[]; pool: Pool } {
  const out = poolOut(e, { vehicleId: e.vehicleId, evidenceDocumentId: e.evidenceDocumentId });
  return { pool: out.pool, lines: [...ngn('1150', out.line.credit, { vehicleId: e.vehicleId }), out.line] };
}

/** The spot fields of a line. A manual spot rate needs a note saying why it differs from the CBN rate. */
function spotOf(spot: Spot, rateNote: string | undefined): Pick<Line, 'spotRate' | 'spotSource' | 'rateNote'> {
  positive(spot.rate, 'spot rate');
  if (spot.source === 'manual' && !rateNote?.trim()) throw new Error('a manual spot rate needs a note');
  return { spotRate: formatRate(spot.rate), spotSource: spot.source, ...(rateNote && { rateNote }) };
}

/** Currency leaving the pool at its weighted-average cost, with the day's spot rate recorded for the spot basis. */
function poolOut(e: { pool: Pool; currency: string; amountMinor: bigint; spot: Spot; rateNote?: string }, tags: Tags): { line: Line; pool: Pool } {
  const spot = spotOf(e.spot, e.rateNote);
  const { costNgn, pool } = poolSpend(e.pool, e.amountMinor);
  // ponytail: a pool left holding currency with no NGN cost (rounding at extreme rates) refuses payments; clear it with a manual journal.
  if (costNgn === 0n) throw new Error('pool payment rounds to zero kobo');
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
export function supplierInvoice(e: SupplierBill & { currency: string; amountMinor: bigint; rate: bigint; spot: Spot; rateNote?: string; evidenceDocumentId?: string }): Line[] {
  positive(e.amountMinor, 'amount');
  const booked = convert(e.amountMinor, e.rate);
  return [
    ...ngn('1150', booked, { vehicleId: e.vehicleId }),
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
  if (e.amountMinor > e.payable.balanceMinor) throw new Error('payment exceeds what is owed to this supplier for this car');
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
  return {
    currencies: new Set(lines.map((l) => l.currency)),
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
export function sharedCost(e: { amountNgn: bigint; vehicleIds: readonly string[]; evidenceDocumentId?: string }): Line[] {
  positive(e.amountNgn, 'cost');
  if (e.vehicleIds.length === 0) throw new Error('a cost needs at least one car');
  if (new Set(e.vehicleIds).size !== e.vehicleIds.length) throw new Error('a car can appear only once in a cost split');
  const shares = allocateEqual(e.amountNgn, e.vehicleIds.length);
  return [...shares.flatMap((share, i) => ngn('1150', share, { vehicleId: e.vehicleIds[i] })), ...ngn('1000', -e.amountNgn, { evidenceDocumentId: e.evidenceDocumentId })];
}

/** What the ledger says about one car's job: its supplier cost, everything capitalized, and the customer's funds held. */
export function jobPosition(history: readonly Line[], vehicleId: string) {
  const mine = history.filter((l) => l.vehicleId === vehicleId);
  const car = carCost(history, vehicleId);
  if (car.currencies.size > 1) throw new Error('a car must be paid for in one currency');
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
  if (fundsHeldNgn < 0n) throw new Error('customer funds held for this job are negative');
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
  if (e.quote.landingChargeNgn < 0n) throw new Error('landing charge cannot be negative');
  const p = jobPosition(e.history, e.vehicleId);
  if (p.carMinor === 0n) throw new Error('no supplier payment recorded for this car');
  if (p.carCurrency !== e.quote.currency) throw new Error(`quote is in ${e.quote.currency} but the car was paid in ${String(p.carCurrency)}`);
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

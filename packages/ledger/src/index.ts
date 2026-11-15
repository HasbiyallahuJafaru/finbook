// Posting rules: business events in, balanced journal lines out. Pure functions: no DB, no clock, no
// randomness. All arithmetic goes through packages/money. Accounts are chart codes (spec → Vehicle module);
// the API maps them to account ids and persists each result as one journal entry.
// ponytail: cash is always 1000, costs are paid in cash, and the foreign-currency pool is account 1010 for every
// currency; add bank-account, payable (2000) and per-currency pool accounts when the API needs them.
import { allocateEqual, convert, formatRate, poolSpend, rateOf, type Pool } from '@app/money';

export type RateSource = 'bank_receipt' | 'bdc_receipt' | 'agent_invoice' | 'manual' | 'pool_average';
export type Line = {
  account: string;
  debit: bigint;
  credit: bigint;
  currency: string;
  amountMinor: bigint;
  rate?: string;
  rateSource?: RateSource;
  rateNote?: string;
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
export function buyCurrency(e: { currency: string; amountMinor: bigint; rate: bigint; rateSource: Exclude<RateSource, 'pool_average'>; rateNote?: string; evidenceDocumentId?: string }): Line[] {
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
export function payFromPool(e: { pool: Pool; currency: string; amountMinor: bigint; vehicleId: string; evidenceDocumentId?: string }): { lines: Line[]; pool: Pool } {
  const { costNgn, pool } = poolSpend(e.pool, e.amountMinor);
  // ponytail: a pool left holding currency with no NGN cost (rounding at extreme rates) refuses payments; clear it with a manual journal.
  if (costNgn === 0n) throw new Error('pool payment rounds to zero kobo');
  return {
    pool,
    lines: [
      ...ngn('1150', costNgn, { vehicleId: e.vehicleId }),
      { account: '1010', debit: 0n, credit: costNgn, currency: e.currency, amountMinor: e.amountMinor, rate: formatRate(rateOf(costNgn, e.amountMinor)), rateSource: 'pool_average', ...tagged(e) },
    ],
  };
}

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
  const paid = mine.filter((l) => l.account === '1010' && l.credit > 0n);
  const currencies = new Set(paid.map((l) => l.currency));
  if (currencies.size > 1) throw new Error('a car must be paid for in one currency');
  const net = (account: string) => mine.filter((l) => l.account === account).reduce((s, l) => s + l.debit - l.credit, 0n);
  return {
    carCurrency: [...currencies][0],
    carMinor: paid.reduce((s, l) => s + l.amountMinor, 0n),
    carNgn: paid.reduce((s, l) => s + l.credit, 0n),
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

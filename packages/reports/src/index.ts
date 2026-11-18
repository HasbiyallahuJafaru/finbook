// Report queries (spec → Reports and PDF delivery): each report is a pure function of journal lines, a date range and a basis.
import { divHalfUp } from '@app/money';
import { bookedCarCost, spotCarCost, type Line } from '@app/ledger';

/** spot: each foreign cost at the spot rate on its own day (IAS 21; what clients see, ADR 0009). pool: what the pool really spent. */
export type Basis = 'spot' | 'pool';

/** One line naming a sold car, in posting order: in the sale entry, posted up to it (whatever its date), dated up to the report's end. */
export type ReportRow = { vehicleId: string; vin: string | null; soldOn: string; saleEntryId: string; inSale: boolean; inOtherSale?: boolean; uptoSale: boolean; inRange: boolean; line: Line };

/**
 * Every car whose completion or stock sale is dated in [$1, $2] and still stands on $2 (not reversed by then), with every line
 * naming it that was posted up to the sale (the cost the sale cleared, whatever its date: entries are dated freely) or is dated up
 * to $2 (net profit), in posting order (the tenant's hash-chain seq, assigned under the ledger lock). A reversal keeps its entry
 * type, so the sale is the latest entry of the type that reverses nothing. One statement, so one snapshot: ledger_seq (the tenant's
 * position, on every row and on the one empty row of an empty report) matches the lines it comes with. Runs under the tenant's RLS.
 */
export const CAR_PROFIT_SQL = `
  WITH pos AS (SELECT coalesce(max(seq), 0)::text AS ledger_seq FROM journal_entry_hashes),
  sale AS (
    SELECT DISTINCT ON (l.vehicle_id) l.vehicle_id, e.id AS entry_id, e.entry_date, h.seq
      FROM journal_entries e JOIN journal_entry_hashes h ON h.entry_id = e.id JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.source_type IN ('job_completion', 'stock_sale') AND e.reverses_entry_id IS NULL AND l.vehicle_id IS NOT NULL
       AND e.entry_date BETWEEN $1 AND $2
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id AND r.entry_date <= $2)
     ORDER BY l.vehicle_id, h.seq DESC),
  car_lines AS (
  SELECT s.vehicle_id, v.vin, s.entry_date::text AS sold_on, s.entry_id AS sale_entry_id, l.entry_id = s.entry_id AS in_sale,
         e.source_type IN ('job_completion', 'stock_sale') AND l.entry_id <> s.entry_id AS in_other_sale, h.seq <= s.seq AS upto_sale, e.entry_date <= $2 AS in_range,
         a.code, l.debit_ngn::text, l.credit_ngn::text, l.currency, l.amount_minor::text, l.rate_source, l.spot_rate::text, h.seq AS line_seq, l.id AS line_id
    FROM sale s
    JOIN vehicles v ON v.id = s.vehicle_id
    JOIN journal_lines l ON l.vehicle_id = s.vehicle_id
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN journal_entry_hashes h ON h.entry_id = e.id
    JOIN accounts a ON a.id = l.account_id
   WHERE h.seq <= s.seq OR e.entry_date <= $2)
  SELECT pos.ledger_seq, c.* FROM pos LEFT JOIN car_lines c ON true
   ORDER BY c.sold_on, c.vehicle_id, c.line_seq, c.line_id`;

export type CarProfitDbRow = {
  vehicle_id: string; vin: string | null; sold_on: string; sale_entry_id: string; in_sale: boolean; in_other_sale: boolean; upto_sale: boolean; in_range: boolean; code: string;
  debit_ngn: string; credit_ngn: string; currency: string; amount_minor: string; rate_source: Line['rateSource'] | null; spot_rate: string | null;
};
/** What CAR_PROFIT_SQL returns: the ledger position on every row; an empty report is one row with no car. */
export type CarProfitQueryRow = { ledger_seq: string } & (CarProfitDbRow | { vehicle_id: null });

/** The query's rows as the ledger position and the lines the report folds. */
export const readCarProfit = (rows: readonly CarProfitQueryRow[]): { asOfSeq: string; rows: ReportRow[] } => ({
  asOfSeq: rows[0]?.ledger_seq ?? '0',
  rows: rows.flatMap((r) => (r.vehicle_id === null ? [] : [fromDb(r)])),
});

/** A query row as the ledger rules read a line (only the columns the car's cost needs). */
export const fromDb = (r: CarProfitDbRow): ReportRow => ({
  vehicleId: r.vehicle_id, vin: r.vin, soldOn: r.sold_on, saleEntryId: r.sale_entry_id, inSale: r.in_sale, inOtherSale: r.in_other_sale, uptoSale: r.upto_sale, inRange: r.in_range,
  line: {
    account: r.code, debit: BigInt(r.debit_ngn), credit: BigInt(r.credit_ngn), currency: r.currency.trim(), amountMinor: BigInt(r.amount_minor),
    vehicleId: r.vehicle_id, ...(r.rate_source && { rateSource: r.rate_source }), ...(r.spot_rate && { spotRate: r.spot_rate }),
  },
});

export type CarProfit = {
  vehicleId: string; vin: string | null; soldOn: string; entryId: string; kind: 'agent' | 'stock'; basis: Basis;
  billedNgn: bigint; carCostNgn: bigint; landedCostNgn: bigint; tradingProfitNgn: bigint;
  /** FX = quoteFx (the sale entry's: quote rate vs the car's cost on this basis) + poolVsSpot (spot vs booked cost; zero on pool) + otherFx (the car's other 7000 lines, e.g. a settlement) */
  quoteFxNgn: bigint; poolVsSpotNgn: bigint; otherFxNgn: bigint; fxNgn: bigint;
  /** P&L on the car outside the sale entry that isn't FX (a second standing sale): zero unless something needs a look */
  otherProfitNgn: bigint; netProfitNgn: bigint;
  /** trading profit / billed, in basis points, half-up; null when nothing was billed */
  marginBp: bigint | null;
};

const TRADING = ['4000', '4100', '4200', '5000'];

/**
 * Per-car profitability (ADR 0020). Billed, landed cost and trading profit come from the sale entry; the car cost from what was
 * posted up to it; net profit from every P&L line naming the car dated up to the report's end. Every row foots twice:
 *   billed = car cost + landed cost + trading profit + quote FX,   net = trading profit + FX + other profit.
 * Spot moves a stock car's cost of sales (the gap leaves trading profit for FX); a job's markup is fixed at the quote rate, so on a
 * job spot moves only the car cost and splits its FX into quote-vs-spot and spot-vs-booked.
 */
export function carProfitReport(rows: readonly ReportRow[], basis: Basis): CarProfit[] {
  const cars = new Map<string, ReportRow[]>();
  for (const r of rows) cars.set(r.vehicleId, [...(cars.get(r.vehicleId) ?? []), r]);
  return [...cars.values()].map((mine) => {
    const first = mine[0] as ReportRow;
    const sum = (ls: readonly ReportRow[], accounts: string[], f: (l: Line) => bigint) => ls.filter((r) => accounts.includes(r.line.account)).reduce((s, r) => s + f(r.line), 0n);
    const net = (l: Line) => l.credit - l.debit;
    const sale = mine.filter((r) => r.inSale);
    const inRange = mine.filter((r) => r.inRange);
    const before = mine.filter((r) => r.uptoSale).map((r) => r.line);
    const stock = sale.some((r) => r.line.account === '4000');
    const booked = bookedCarCost(before, first.vehicleId);
    const poolVsSpot = basis === 'spot' ? spotCarCost(before, first.vehicleId) - booked : 0n;
    const billed = sum(sale, ['2150', '2100', '1100'], (l) => l.debit);
    const cleared = stock ? sum(sale, ['5000'], (l) => l.debit) : sum(sale, ['1150'], (l) => l.credit);
    const trading = sum(sale, TRADING, net) - (stock ? poolVsSpot : 0n);
    const quoteFx = sum(sale, ['7000'], net) - (stock ? 0n : poolVsSpot);
    // another standing sale's FX is part of its cut (other profit), not the car's FX
    const otherFx = sum(inRange.filter((r) => !r.inSale && r.inOtherSale !== true), ['7000'], net);
    const fx = quoteFx + poolVsSpot + otherFx;
    const netProfit = sum(inRange, [...TRADING, '7000'], net);
    return {
      vehicleId: first.vehicleId, vin: first.vin, soldOn: first.soldOn, entryId: first.saleEntryId, kind: stock ? 'stock' : 'agent', basis,
      billedNgn: billed, carCostNgn: booked + poolVsSpot, landedCostNgn: cleared - booked, tradingProfitNgn: trading,
      quoteFxNgn: quoteFx, poolVsSpotNgn: poolVsSpot, otherFxNgn: otherFx, fxNgn: fx, otherProfitNgn: netProfit - trading - fx, netProfitNgn: netProfit,
      marginBp: billed > 0n ? divHalfUp(trading * 10_000n, billed) : null,
    };
  });
}


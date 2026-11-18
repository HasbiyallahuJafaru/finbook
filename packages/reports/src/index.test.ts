// Per-car profitability (spec → Reports; ADR 0009, ADR 0020), worked by hand to the kobo on the ledger package's own worked
// examples, built with the real posting rules so the lines have the shapes the database stores.
//
// Car A, customer-funded (agent), from the phase 2 worked example: CNY 40,000.00 paid from the pool at NGN 4,266,666.67, on a day
// whose spot rate was FIXTURE_RATE_SPOT (108): spot cost 40,000.00 x 108 = NGN 4,320,000.00. Landed NGN 1,316,666.67. Completed
// for NGN 6,450,000.00: markup 550,000.00 + clearing margin 183,333.33 = trading profit NGN 733,333.33; FX gain NGN 133,333.33;
// net NGN 866,666.66. Margin 733,333.33 / 6,450,000.00 = 11.3695% -> 1,137 basis points. Both bases: the markup is set at the
// quote rate, so spot moves only the car cost shown (4,320,000.00) and splits FX: quote vs spot (110 - 108) x 40,000.00 = 80,000.00,
// plus spot vs pool 4,320,000.00 - 4,266,666.67 = 53,333.33.
//
// Car S, EMM-funded stock: CNY 30,000.00 from a pool at 106.666667 = NGN 3,200,000.00 (spot 108: NGN 3,240,000.00), plus NGN
// 500,000.00 of costs, sold for NGN 4,500,000.00. Pool basis: cost of sales 3,700,000.00, trading profit 800,000.00 (1,778 bp),
// FX 0. Spot basis: car 3,240,000.00, trading profit 4,500,000.00 - 3,240,000.00 - 500,000.00 = 760,000.00 (1,689 bp), FX
// 40,000.00 (the pool was cheaper than spot). Net 800,000.00 either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRate } from '@app/money';
import { arriveInYard, completeAgentJob, customerReceipt, payFromPool, sellStockCar, sharedCost, stockDeposit, type Line } from '@app/ledger';
import { carProfitReport, readCarProfit, type CarProfit, type CarProfitQueryRow, type ReportRow } from './index.ts';

const FIXTURE_RATE_QUOTE = parseRate('110.000000');
const SPOT = { rate: parseRate('108.000000'), source: 'cbn' as const }; // FIXTURE spot rate

/** Entries in posting order as the report query returns them: the sale entry marked, entries after it marked too. */
function rows(vehicleId: string, entries: Line[][], saleIndex: number): ReportRow[] {
  return entries.flatMap((lines, i) => lines.filter((l) => l.vehicleId === vehicleId).map((l) => ({
    vehicleId, vin: `VIN-${vehicleId}`, soldOn: '2026-02-14', saleEntryId: `entry-${String(saleIndex)}`,
    inSale: i === saleIndex, uptoSale: i <= saleIndex, inRange: true, line: l,
  })));
}

const agentA = (): ReportRow[] => {
  const e: Line[][] = [];
  e.push(customerReceipt({ vehicleId: 'A', counterpartyId: 'customer-A', amountNgn: 600_000_000n }));
  e.push(payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT }).lines);
  e.push(sharedCost({ amountNgn: 83_333_333n + 33_333_334n + 15_000_000n, vehicleIds: ['A'] }));
  e.push(completeAgentJob({ vehicleId: 'A', counterpartyId: 'customer-A', history: e.flat(),
    quote: { currency: 'CNY', sellingMinor: 4_500_000n, rate: FIXTURE_RATE_QUOTE, landingChargeNgn: 150_000_000n } }).lines);
  return rows('A', e, 3);
};

const stockS = (): ReportRow[] => {
  const e: Line[][] = [];
  e.push(payFromPool({ pool: { balanceMinor: 3_000_000n, costNgn: 320_000_000n }, currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'S', spot: SPOT, funding: 'emm_funded' }).lines);
  e.push(sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['S'], funding: 'emm_funded' }));
  e.push(arriveInYard({ vehicleId: 'S', history: e.flat() }));
  e.push(stockDeposit({ vehicleId: 'S', counterpartyId: 'buyer-K', amountNgn: 200_000_000n }));
  e.push(sellStockCar({ vehicleId: 'S', counterpartyId: 'buyer-K', priceNgn: 450_000_000n, history: e.flat() }));
  return rows('S', e, 4);
};

test('worked example: a customer-funded car and a stock car, on both bases, to the kobo', () => {
  const [a, s] = carProfitReport([...agentA(), ...stockS()], 'pool');
  assert.deepEqual(a, { vehicleId: 'A', vin: 'VIN-A', soldOn: '2026-02-14', entryId: 'entry-3', kind: 'agent', basis: 'pool',
    billedNgn: 645_000_000n, carCostNgn: 426_666_667n, landedCostNgn: 131_666_667n, tradingProfitNgn: 73_333_333n,
    quoteFxNgn: 13_333_333n, poolVsSpotNgn: 0n, otherFxNgn: 0n, fxNgn: 13_333_333n, otherProfitNgn: 0n, netProfitNgn: 86_666_666n, marginBp: 1137n });
  assert.deepEqual(s, { vehicleId: 'S', vin: 'VIN-S', soldOn: '2026-02-14', entryId: 'entry-4', kind: 'stock', basis: 'pool',
    billedNgn: 450_000_000n, carCostNgn: 320_000_000n, landedCostNgn: 50_000_000n, tradingProfitNgn: 80_000_000n,
    quoteFxNgn: 0n, poolVsSpotNgn: 0n, otherFxNgn: 0n, fxNgn: 0n, otherProfitNgn: 0n, netProfitNgn: 80_000_000n, marginBp: 1778n });

  const [aSpot, sSpot] = carProfitReport([...agentA(), ...stockS()], 'spot');
  assert.deepEqual([aSpot?.carCostNgn, aSpot?.tradingProfitNgn, aSpot?.quoteFxNgn, aSpot?.poolVsSpotNgn, aSpot?.fxNgn, aSpot?.netProfitNgn, aSpot?.marginBp],
    [432_000_000n, 73_333_333n, 8_000_000n, 5_333_333n, 13_333_333n, 86_666_666n, 1137n]);
  assert.deepEqual([sSpot?.carCostNgn, sSpot?.tradingProfitNgn, sSpot?.fxNgn, sSpot?.poolVsSpotNgn, sSpot?.netProfitNgn, sSpot?.marginBp],
    [324_000_000n, 76_000_000n, 4_000_000n, 4_000_000n, 80_000_000n, 1689n]);

  for (const r of [a, s, aSpot, sSpot]) foots(r);
});

/** Every row foots twice: billed = car + landed + trading + quote FX, and net = trading + FX + other profit, FX = its three parts. */
function foots(r: CarProfit | undefined) {
  assert.ok(r);
  assert.equal(r.billedNgn, r.carCostNgn + r.landedCostNgn + r.tradingProfitNgn + r.quoteFxNgn, `${r.vehicleId} billed`);
  assert.equal(r.fxNgn, r.quoteFxNgn + r.poolVsSpotNgn + r.otherFxNgn, `${r.vehicleId} fx`);
  assert.equal(r.netProfitNgn, r.tradingProfitNgn + r.fxNgn + r.otherProfitNgn, `${r.vehicleId} net`);
}

test('a cost or FX after the sale counts in net profit, never in the cost the sale cleared; a clearing-only car has no car cost', () => {
  const late = agentA();
  const fx = { vehicleId: 'A', vin: 'VIN-A', soldOn: '2026-02-14', saleEntryId: 'entry-3', inSale: false, uptoSale: false, inRange: true };
  // a supplier settlement after completion: NGN 10,000.00 realized FX loss on the car
  late.push({ ...fx, line: { account: '7000', debit: 1_000_000n, credit: 0n, currency: 'NGN', amountMinor: 1_000_000n, vehicleId: 'A' } });
  // a CNY payment after completion (flagged cost_after_completion): not in the car cost the completion cleared
  late.push({ ...fx, line: { account: '1010', debit: 0n, credit: 100_000n, currency: 'CNY', amountMinor: 1_000n, rate: '100.000000', rateSource: 'pool_average', spotRate: '108.000000', vehicleId: 'A' } });
  // dated after the report's end: in neither net profit nor anything else
  late.push({ ...fx, inRange: false, line: { account: '7000', debit: 0n, credit: 9_999n, currency: 'NGN', amountMinor: 9_999n, vehicleId: 'A' } });
  const [a] = carProfitReport(late, 'pool');
  assert.deepEqual([a?.carCostNgn, a?.landedCostNgn, a?.tradingProfitNgn, a?.quoteFxNgn, a?.otherFxNgn, a?.fxNgn, a?.netProfitNgn],
    [426_666_667n, 131_666_667n, 73_333_333n, 13_333_333n, -1_000_000n, 12_333_333n, 85_666_666n]);
  foots(a);

  // A payment posted before the sale but dated after the report's end (entries are dated freely): it is in the cost the sale cleared.
  const backdated = agentA().map((r) => (r.line.account === '1010' ? { ...r, inRange: false } : r));
  assert.deepEqual(carProfitReport(backdated, 'spot')[0], carProfitReport(agentA(), 'spot')[0]);

  // A second standing completion of the same car: its cut is other profit, never FX, so the row says something needs a look.
  const firstCompletion = agentA().filter((r) => r.inSale).map((r) => ({ ...r, inSale: false, inOtherSale: true }));
  const doubled = carProfitReport([...firstCompletion, ...agentA()], 'pool')[0];
  // the first cut is other profit in full: markup, clearing margin and its FX on the quote (733,333.33 + 133,333.33)
  assert.deepEqual([doubled?.tradingProfitNgn, doubled?.otherFxNgn, doubled?.otherProfitNgn], [73_333_333n, 0n, 86_666_666n]);
  foots(doubled);

  // A stock car paid in two currencies still reports (the car cost is the sum of its booked naira).
  const usd: ReportRow = { ...stockS()[0] as ReportRow, line: { account: '1010', debit: 0n, credit: 150_000n, currency: 'USD', amountMinor: 100n, rate: '1500.000000', rateSource: 'pool_average', spotRate: '1500.000000', vehicleId: 'S' } };
  const [mixed] = carProfitReport([usd, ...stockS()], 'spot');
  assert.equal(mixed?.carCostNgn, 324_150_000n);
  foots(mixed);

  const clearing: ReportRow[] = [
    { line: { account: '1150', debit: 500_000n, credit: 0n, currency: 'NGN', amountMinor: 500_000n, vehicleId: 'Y' }, inSale: false, uptoSale: true },
    { line: { account: '2150', debit: 400_000n, credit: 0n, currency: 'NGN', amountMinor: 400_000n, vehicleId: 'Y' }, inSale: true, uptoSale: true },
    { line: { account: '1150', debit: 0n, credit: 500_000n, currency: 'NGN', amountMinor: 500_000n, vehicleId: 'Y' }, inSale: true, uptoSale: true },
    { line: { account: '4200', debit: 100_000n, credit: 0n, currency: 'NGN', amountMinor: 100_000n, vehicleId: 'Y' }, inSale: true, uptoSale: true },
  ].map((r) => ({ ...r, vehicleId: 'Y', vin: null, soldOn: '2026-02-15', saleEntryId: 'entry-y', inRange: true }));
  assert.deepEqual(carProfitReport(clearing, 'spot'), [{ vehicleId: 'Y', vin: null, soldOn: '2026-02-15', entryId: 'entry-y', kind: 'agent', basis: 'spot',
    billedNgn: 400_000n, carCostNgn: 0n, landedCostNgn: 500_000n, tradingProfitNgn: -100_000n, quoteFxNgn: 0n, poolVsSpotNgn: 0n, otherFxNgn: 0n, fxNgn: 0n,
    otherProfitNgn: 0n, netProfitNgn: -100_000n, marginBp: -2500n }]);
});

test('a sale billed at nothing has no margin, and no cars is an empty report', () => {
  const free: ReportRow[] = [{ vehicleId: 'Z', vin: null, soldOn: '2026-02-15', saleEntryId: 'e', inSale: true, uptoSale: true, inRange: true,
    line: { account: '4200', debit: 0n, credit: 0n, currency: 'NGN', amountMinor: 0n, vehicleId: 'Z' } }];
  assert.equal(carProfitReport(free, 'pool')[0]?.marginBp, null);
  assert.deepEqual(carProfitReport([], 'spot'), []);
});

test('the query rows read as the ledger position and the lines; an empty report is one row with no car', () => {
  assert.deepEqual(readCarProfit([{ ledger_seq: '7', vehicle_id: null }]), { asOfSeq: '7', rows: [] });
  assert.deepEqual(readCarProfit([]), { asOfSeq: '0', rows: [] });
  const row: CarProfitQueryRow = { ledger_seq: '9', vehicle_id: 'A', vin: null, sold_on: '2026-02-14', sale_entry_id: 'e', in_sale: false, in_other_sale: false, upto_sale: true,
    in_range: true, code: '1010', debit_ngn: '0', credit_ngn: '426666667', currency: 'CNY', amount_minor: '4000000', rate_source: 'pool_average', spot_rate: '108.000000' };
  assert.deepEqual(readCarProfit([row, { ...row, rate_source: null, spot_rate: null, currency: 'NGN ' }]).rows.map((r) => r.line), [
    { account: '1010', debit: 0n, credit: 426_666_667n, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', rateSource: 'pool_average', spotRate: '108.000000' },
    { account: '1010', debit: 0n, credit: 426_666_667n, currency: 'NGN', amountMinor: 4_000_000n, vehicleId: 'A' },
  ]);
});

// Phase 2 worked example (spec → Build phases): 3 cars, 1 shared container, 3 different rates, 1 sale.
// Every expected figure below was worked out by hand, to the kobo. Phase 2 gate: approved by the owner on
// 2026-11-15, provisionally; the firm's accountant still re-performs it, and any fix is reopened in docs/PROGRESS.md.
//
// The story (EMM's Shop, all three jobs customer-funded, so agent accounting):
//  1. Buy CNY 100,000.00 at FIXTURE_RATE_BUY_1 (100) = NGN 10,000,000.00  -> pool CNY 100,000.00 / NGN 10,000,000.00
//  2. Buy CNY  50,000.00 at FIXTURE_RATE_BUY_2 (120) = NGN  6,000,000.00  -> pool CNY 150,000.00 / NGN 16,000,000.00
//  3. Customers pay first: A NGN 6,000,000.00, B NGN 5,000,000.00, C NGN 6,500,000.00 (held in 2150, tagged to each job)
//  4. Pay the China supplier from the pool at weighted-average cost:
//       A CNY 40,000.00: 16,000,000.00 x 40/150 = 4,266,666.666.. -> NGN 4,266,666.67  pool left CNY 110,000.00 / NGN 11,733,333.33
//       B CNY 35,000.00: 11,733,333.33 x 35/110 = 3,733,333.333.. -> NGN 3,733,333.33  pool left CNY  75,000.00 / NGN  8,000,000.00
//       C CNY 45,000.00:  8,000,000.00 x 45/75                    =  NGN 4,800,000.00  pool left CNY  30,000.00 / NGN  3,200,000.00
//  5. Container C4 (cars A, B, C), split equally in kobo, remainder on the first car:
//       shipping company fee NGN 2,499,999.99 -> 833,333.33 each (exact)
//       Form M               NGN 1,000,000.00 -> A 333,333.34, B 333,333.33, C 333,333.33
//     Car A only: IDEC bill NGN 150,000.00
//  6. Job A completes. Accepted quote: car CNY 45,000.00 at the quote-day rate FIXTURE_RATE_QUOTE (110) = NGN 4,950,000.00,
//     plus landing charge NGN 1,500,000.00 -> invoice NGN 6,450,000.00. The customer paid 6,000,000.00 and owes 450,000.00.
//       actual car cost        NGN 4,266,666.67 (CNY 40,000.00)
//       actual landed cost     833,333.33 + 333,333.34 + 150,000.00 = NGN 1,316,666.67
//       car markup (4100)      (45,000 - 40,000) x 110             = NGN   550,000.00
//       FX gain (7000)         40,000 x 110 - 4,266,666.67         = NGN   133,333.33 (quote rate vs rate paid: never margin)
//       clearing margin (4200) 1,500,000.00 - 1,316,666.67         = NGN   183,333.33
//       check: 4,266,666.67 + 1,316,666.67 + 550,000.00 + 133,333.33 + 183,333.33 = 6,450,000.00
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, parseRate, type Pool } from '@app/money';
import {
  RuleError, arriveInYard, buyCurrency, completeAgentJob, completeClearingJob, convertToStock, customerReceipt, jobPosition, payFromPool, payPayableFromPool, revalue, sellStockCar,
  customerRefund, receivableReceipt, refundStockDeposit, sharedCost, supplierCredit, spotCarCost, stockDeposit, supplierInvoice, type Line,
} from './index.ts';

const FIXTURE_RATE_BUY_1 = parseRate('100.000000');
const FIXTURE_RATE_BUY_2 = parseRate('120.000000');
const FIXTURE_RATE_QUOTE = parseRate('110.000000');
const FIXTURE_RATE_SPOT = parseRate('108.000000'); // spot (reference) rate on the payment day
const FIXTURE_RATE_INVOICE_LOW = parseRate('95.000000');
const SPOT_CBN = { rate: FIXTURE_RATE_SPOT, source: 'cbn' as const };
const FIXTURE_RATE_INVOICE = parseRate('105.000000'); // rate on the supplier's invoice

const balanced = (lines: Line[]) => lines.reduce((s, l) => s + l.debit - l.credit, 0n) === 0n;
const balances = (lines: Line[]) => {
  const b: Record<string, bigint> = {};
  for (const l of lines) b[l.account] = (b[l.account] ?? 0n) + l.debit - l.credit;
  return b;
};
const only = (lines: Line[]) => lines.map((l) => [l.account, l.debit, l.credit, l.vehicleId ?? null]);
const job = (v: string) => ({ vehicleId: v, counterpartyId: `customer-${v}` });
const quoteA = { currency: 'CNY', sellingMinor: 4_500_000n, rate: FIXTURE_RATE_QUOTE, landingChargeNgn: 150_000_000n };

test('worked example: 3 cars, 1 shared container, 3 rates, 1 sale, to the kobo', () => {
  const entries: Line[][] = [];
  entries.push(buyCurrency({ currency: 'CNY', amountMinor: 10_000_000n, rate: FIXTURE_RATE_BUY_1, rateSource: 'bdc_receipt', evidenceDocumentId: 'doc-bdc-1' }));
  entries.push(buyCurrency({ currency: 'CNY', amountMinor: 5_000_000n, rate: FIXTURE_RATE_BUY_2, rateSource: 'bdc_receipt' }));
  assert.deepEqual(entries[0]?.[0], { account: '1010', debit: 1_000_000_000n, credit: 0n, currency: 'CNY', amountMinor: 10_000_000n, rate: '100.000000', rateSource: 'bdc_receipt', evidenceDocumentId: 'doc-bdc-1' });

  entries.push(customerReceipt({ ...job('A'), amountNgn: 600_000_000n, evidenceDocumentId: 'doc-receipt-a' }));
  entries.push(customerReceipt({ ...job('B'), amountNgn: 500_000_000n }), customerReceipt({ ...job('C'), amountNgn: 650_000_000n }));
  assert.deepEqual(entries[2], [
    { account: '1000', debit: 600_000_000n, credit: 0n, currency: 'NGN', amountMinor: 600_000_000n, evidenceDocumentId: 'doc-receipt-a' },
    { account: '2150', debit: 0n, credit: 600_000_000n, currency: 'NGN', amountMinor: 600_000_000n, vehicleId: 'A', counterpartyId: 'customer-A', evidenceDocumentId: 'doc-receipt-a' },
  ]);

  let pool: Pool = { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n };
  const pay = (vehicleId: string, amountMinor: bigint) => {
    const r = payFromPool({ pool, currency: 'CNY', amountMinor, vehicleId, spot: SPOT_CBN });
    pool = r.pool;
    entries.push(r.lines);
    return r.lines;
  };
  assert.deepEqual(pay('A', 4_000_000n), [
    { account: '1150', debit: 426_666_667n, credit: 0n, currency: 'NGN', amountMinor: 426_666_667n, vehicleId: 'A' },
    { account: '1010', debit: 0n, credit: 426_666_667n, currency: 'CNY', amountMinor: 4_000_000n, rate: '106.666667', rateSource: 'pool_average', spotRate: '108.000000', spotSource: 'cbn', vehicleId: 'A' },
  ]);
  pay('B', 3_500_000n);
  pay('C', 4_500_000n);
  assert.deepEqual(pool, { balanceMinor: 3_000_000n, costNgn: 320_000_000n });

  const shipping = sharedCost({ amountNgn: 249_999_999n, vehicleIds: ['A', 'B', 'C'] });
  assert.deepEqual(only(shipping), [['1150', 83_333_333n, 0n, 'A'], ['1150', 83_333_333n, 0n, 'B'], ['1150', 83_333_333n, 0n, 'C'], ['1000', 0n, 249_999_999n, null]]);
  const formM = sharedCost({ amountNgn: 100_000_000n, vehicleIds: ['A', 'B', 'C'], evidenceDocumentId: 'doc-formm' });
  assert.deepEqual(only(formM).map((l) => l[1]), [33_333_334n, 33_333_333n, 33_333_333n, 0n]);
  assert.equal(formM[3]?.evidenceDocumentId, 'doc-formm');
  entries.push(shipping, formM, sharedCost({ amountNgn: 15_000_000n, vehicleIds: ['A'] }));

  // Everything the completion needs comes from car A's own ledger history, nothing is typed in.
  assert.deepEqual(jobPosition(entries.flat(), 'A'), { carCurrency: 'CNY', carMinor: 4_000_000n, carNgn: 426_666_667n, costNgn: 558_333_334n, fundsHeldNgn: 600_000_000n });
  const done = completeAgentJob({ ...job('A'), quote: quoteA, history: entries.flat() });
  assert.equal(done.invoiceNgn, 645_000_000n);
  assert.deepEqual(only(done.lines), [
    ['2150', 600_000_000n, 0n, 'A'],
    ['1100', 45_000_000n, 0n, 'A'],
    ['1150', 0n, 558_333_334n, 'A'],
    ['4100', 0n, 55_000_000n, 'A'],
    ['4200', 0n, 18_333_333n, 'A'],
    ['7000', 0n, 13_333_333n, 'A'],
  ]);
  assert.equal(done.lines[1]?.counterpartyId, 'customer-A', 'the receivable names its debtor');
  entries.push(done.lines);

  for (const e of entries) assert.ok(balanced(e), 'every entry balances');
  assert.deepEqual(balances(entries.flat()), {
    '1000': -214_999_999n, // -10m -6m +6m +5m +6.5m -2,499,999.99 -1m -150k
    '1010': 320_000_000n, // CNY 30,000.00 left in the pool at NGN 3,200,000.00
    '2150': -1_150_000_000n, // B and C still held: 5m + 6.5m
    '1150': 1_086_666_665n, // still recoverable: B 4,899,999.99 + C 5,966,666.66
    '1100': 45_000_000n, // A owes 450,000.00
    '4100': -55_000_000n,
    '4200': -18_333_333n,
    '7000': -13_333_333n,
  });
  assert.equal(jobPosition(entries.flat(), 'A').costNgn, 0n, 'completion clears car A capitalized cost to exactly zero');
  assert.equal(Object.values(balances(entries.flat())).reduce((a, b) => a + b, 0n), 0n, 'trial balance nets to zero');
});

// Car X: CNY 10.00 paid at NGN 1,200.00, landed NGN 350.00, customer paid NGN 9,999.99.
const historyX: Line[] = [
  { account: '1010', debit: 0n, credit: 120_000n, currency: 'CNY', amountMinor: 1_000n, rate: '120.000000', rateSource: 'pool_average', vehicleId: 'X' },
  { account: '1150', debit: 120_000n, credit: 0n, currency: 'NGN', amountMinor: 120_000n, vehicleId: 'X' },
  { account: '1150', debit: 35_000n, credit: 0n, currency: 'NGN', amountMinor: 35_000n, vehicleId: 'X' },
  { account: '2150', debit: 0n, credit: 999_999n, currency: 'NGN', amountMinor: 999_999n, vehicleId: 'X', counterpartyId: 'customer-X' },
];

test('agent job edge cases: negative margin and FX loss post as debits; overpayment stays held; zero lines are left out', () => {
  // Quoted CNY 10.00 at 110 = NGN 1,100.00 (no markup); FX loss 1,200.00 - 1,100.00 = 100.00; landing 300.00 - landed 350.00 = -50.00.
  const r = completeAgentJob({ ...job('X'), quote: { currency: 'CNY', sellingMinor: 1_000n, rate: FIXTURE_RATE_QUOTE, landingChargeNgn: 30_000n }, history: historyX });
  assert.equal(r.invoiceNgn, 140_000n);
  assert.deepEqual(only(r.lines), [
    ['2150', 140_000n, 0n, 'X'], // only the invoice comes out of funds held; the rest is still owed back to the customer
    ['1150', 0n, 155_000n, 'X'],
    ['4200', 5_000n, 0n, 'X'],
    ['7000', 10_000n, 0n, 'X'],
  ]);
  assert.ok(balanced(r.lines));
});

test('clearing-only job: revenue is the landing charge minus the landed cost from the ledger', () => {
  const history: Line[] = [
    { account: '1150', debit: 150_000_00n, credit: 0n, currency: 'NGN', amountMinor: 150_000_00n, vehicleId: 'Y' },
    { account: '2150', debit: 0n, credit: 50_000_00n, currency: 'NGN', amountMinor: 50_000_00n, vehicleId: 'Y', counterpartyId: 'customer-Y' },
  ];
  const r = completeClearingJob({ ...job('Y'), landingChargeNgn: 200_000_00n, history });
  assert.equal(r.invoiceNgn, 200_000_00n);
  assert.deepEqual(only(r.lines), [['2150', 50_000_00n, 0n, 'Y'], ['1100', 150_000_00n, 0n, 'Y'], ['1150', 0n, 150_000_00n, 'Y'], ['4200', 0n, 50_000_00n, 'Y']]);
});

test('a manual rate carries its note through to the line', () => {
  const [line] = buyCurrency({ currency: 'CNY', amountMinor: 100n, rate: FIXTURE_RATE_BUY_1, rateSource: 'manual', rateNote: 'cash deal, no receipt' });
  assert.equal(line?.rateNote, 'cash deal, no receipt');
});

test('guards: bad amounts, duplicate cars, missing or mismatched supplier payments and negative funds are refused', () => {
  assert.throws(() => customerReceipt({ ...job('A'), amountNgn: -100n }), /receipt must be positive/);
  assert.throws(() => customerReceipt({ ...job('A'), amountNgn: 0n }), /receipt must be positive/);
  assert.throws(() => buyCurrency({ currency: 'CNY', amountMinor: 0n, rate: FIXTURE_RATE_BUY_1, rateSource: 'bdc_receipt' }), /amount must be positive/);
  assert.throws(() => sharedCost({ amountNgn: -300n, vehicleIds: ['A'] }), /cost must be positive/);
  assert.throws(() => sharedCost({ amountNgn: 1n, vehicleIds: [] }), /at least one car/);
  assert.throws(() => sharedCost({ amountNgn: 300n, vehicleIds: ['A', 'A'] }), /only once/);
  assert.throws(() => payFromPool({ pool: { balanceMinor: 10n ** 12n, costNgn: 1n }, currency: 'CNY', amountMinor: 1n, vehicleId: 'Z', spot: SPOT_CBN }), /rounds to zero/);
  assert.throws(() => payFromPool({ pool: { balanceMinor: 100n, costNgn: 100n }, currency: 'CNY', amountMinor: 1n, vehicleId: 'Z', spot: { rate: 0n, source: 'cbn' } }), /spot rate must be positive/);
  assert.throws(() => payFromPool({ pool: { balanceMinor: 100n, costNgn: 100n }, currency: 'CNY', amountMinor: 1n, vehicleId: 'Z', spot: { rate: FIXTURE_RATE_SPOT, source: 'manual' } }), /manual spot rate needs a note/);
  assert.throws(() => supplierInvoice({ vehicleId: 'D', supplierId: 's', currency: 'CNY', amountMinor: 0n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN }), /amount must be positive/);
  assert.throws(() => completeAgentJob({ ...job('X'), quote: { ...quoteA, currency: 'USD' }, history: historyX }), /quote is in USD but the car was paid in CNY/);
  assert.throws(() => completeAgentJob({ ...job('none'), quote: quoteA, history: historyX }), /no supplier payment/);
  assert.throws(() => completeAgentJob({ ...job('X'), quote: { ...quoteA, sellingMinor: 0n }, history: historyX }), /selling price must be positive/);
  assert.throws(() => completeAgentJob({ ...job('X'), quote: { ...quoteA, landingChargeNgn: -1n }, history: historyX }), /landing charge cannot be negative/);
  const twoCurrencies: Line[] = [...historyX, { account: '1010', debit: 0n, credit: 1n, currency: 'USD', amountMinor: 1n, vehicleId: 'X' }];
  assert.throws(() => jobPosition(twoCurrencies, 'X'), /one currency/);
  const refunded: Line[] = [...historyX, { account: '2150', debit: 2_000_000n, credit: 0n, currency: 'NGN', amountMinor: 2_000_000n, vehicleId: 'X' }];
  assert.throws(() => completeAgentJob({ ...job('X'), quote: quoteA, history: refunded }), /funds held for this job are negative/);
  assert.throws(() => completeClearingJob({ ...job('Y'), landingChargeNgn: 0n, history: [] }), /landing charge must be positive/);
});

// Realized FX on a payable (spec FX rule 5), hand-worked. Pool: CNY 100,000.00 costing NGN 10,000,000.00 (average 100).
//  1. Supplier invoice for car D: CNY 20,000.00 at the invoice rate FIXTURE_RATE_INVOICE (105) = NGN 2,100,000.00 -> Dr 1150, Cr 2000 (CNY payable).
//     The invoice-day spot rate (FIXTURE_RATE_SPOT, 108, from CBN) is recorded for the spot basis.
//  2. Pay it from the pool: CNY 20,000.00 x average 100 = NGN 2,000,000.00 out of the pool.
//     The payable comes off at its booked NGN 2,100,000.00: realized FX gain NGN 100,000.00 (7000).
const supplier = { vehicleId: 'D', supplierId: 'supplier-1' };
const invoiceD = supplierInvoice({ ...supplier, currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN, evidenceDocumentId: 'doc-inv' });

test('realized FX: a supplier invoice booked at one rate and paid from the pool at another', () => {
  assert.deepEqual(invoiceD, [
    { account: '1150', debit: 210_000_000n, credit: 0n, currency: 'NGN', amountMinor: 210_000_000n, vehicleId: 'D' },
    {
      account: '2000', debit: 0n, credit: 210_000_000n, currency: 'CNY', amountMinor: 2_000_000n, rate: '105.000000', rateSource: 'agent_invoice',
      spotRate: '108.000000', spotSource: 'cbn', vehicleId: 'D', counterpartyId: 'supplier-1', evidenceDocumentId: 'doc-inv',
    },
  ]);
  const paid = payPayableFromPool({
    ...supplier, pool: { balanceMinor: 10_000_000n, costNgn: 1_000_000_000n }, payable: { balanceMinor: 2_000_000n, costNgn: 210_000_000n },
    currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN, evidenceDocumentId: 'doc-voucher',
  });
  assert.deepEqual(paid.lines, [
    { account: '2000', debit: 210_000_000n, credit: 0n, currency: 'CNY', amountMinor: 2_000_000n, rate: '105.000000', rateSource: 'payable_average', vehicleId: 'D', counterpartyId: 'supplier-1', evidenceDocumentId: 'doc-voucher' },
    { account: '1010', debit: 0n, credit: 200_000_000n, currency: 'CNY', amountMinor: 2_000_000n, rate: '100.000000', rateSource: 'pool_average', spotRate: '108.000000', spotSource: 'cbn', counterpartyId: 'supplier-1', evidenceDocumentId: 'doc-voucher' },
    { account: '7000', debit: 0n, credit: 10_000_000n, currency: 'NGN', amountMinor: 10_000_000n, vehicleId: 'D' },
  ]);
  assert.deepEqual(paid.pool, { balanceMinor: 8_000_000n, costNgn: 800_000_000n });
  assert.deepEqual(paid.payable, { balanceMinor: 0n, costNgn: 0n });
  const history = [...invoiceD, ...paid.lines];
  assert.ok(balanced(invoiceD) && balanced(paid.lines));
  assert.equal(balances(history)['2000'], 0n, 'payable fully settled');
  // The car carries the invoice-rate cost; the currency gap was realized at payment, so completion won't count it twice.
  assert.deepEqual(jobPosition(history, 'D'), { carCurrency: 'CNY', carMinor: 2_000_000n, carNgn: 210_000_000n, costNgn: 210_000_000n, fundsHeldNgn: 0n });
});

test('realized FX loss: invoice booked at 95, cleared with currency that cost 100', () => {
  // Payable CNY 20,000.00 booked at FIXTURE_RATE_INVOICE_LOW (95) = NGN 1,900,000.00; the pool pays NGN 2,000,000.00 -> loss NGN 100,000.00.
  const loss = payPayableFromPool({
    ...supplier, pool: { balanceMinor: 10_000_000n, costNgn: 1_000_000_000n }, payable: { balanceMinor: 2_000_000n, costNgn: convert(2_000_000n, FIXTURE_RATE_INVOICE_LOW) },
    currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN,
  });
  assert.deepEqual(only(loss.lines), [['2000', 190_000_000n, 0n, 'D'], ['1010', 0n, 200_000_000n, null], ['7000', 10_000_000n, 0n, 'D']]);
});

test('part payments clear the payable to exactly zero; overpaying is refused', () => {
  // Invoice CNY 3,000.03 at 100.5 = NGN 301,503.0150 -> booked 30,150,302 kobo. Three payments of CNY 1,000.01:
  // 1st 30,150,302 x 1/3 = 10,050,100.67 -> 10,050,101; 2nd 20,100,201 x 1/2 = 10,050,100.5 -> 10,050,101; 3rd takes the remaining 10,050,100.
  let payable = { balanceMinor: 300_003n, costNgn: convert(300_003n, parseRate('100.500000')) }; // fixture invoice rate
  assert.equal(payable.costNgn, 30_150_302n);
  let pool = { balanceMinor: 10_000_000n, costNgn: 1_000_000_000n };
  const settledNgn: bigint[] = [];
  for (let i = 0; i < 3; i++) {
    const r = payPayableFromPool({ ...supplier, pool, payable, currency: 'CNY', amountMinor: 100_001n, spot: SPOT_CBN });
    settledNgn.push(r.lines[0]?.debit ?? 0n);
    ({ pool, payable } = r);
  }
  assert.deepEqual(settledNgn, [10_050_101n, 10_050_101n, 10_050_100n]);
  assert.deepEqual(payable, { balanceMinor: 0n, costNgn: 0n }, 'no kobo stranded on a settled payable');
  assert.throws(() => payPayableFromPool({ ...supplier, pool, payable: { balanceMinor: 100n, costNgn: 100n }, currency: 'CNY', amountMinor: 101n, spot: SPOT_CBN }), /exceeds what is owed to this supplier for this car/);
});

test('a reversed invoice or payment drops out of the car cost exactly', () => {
  const mirror = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
  // Invoice, reverse it, re-enter it: the car cost is one invoice, not two.
  const history = [...invoiceD, ...mirror(invoiceD), ...invoiceD];
  assert.deepEqual(jobPosition(history, 'D'), { carCurrency: 'CNY', carMinor: 2_000_000n, carNgn: 210_000_000n, costNgn: 210_000_000n, fundsHeldNgn: 0n });
  assert.equal(spotCarCost(history, 'D'), 216_000_000n, 'CNY 20,000.00 x spot 108');
  // Paying and then reversing the payment of the invoice leaves the car cost at the invoice.
  const settled = payPayableFromPool({ ...supplier, pool: { balanceMinor: 10_000_000n, costNgn: 1_000_000_000n }, payable: { balanceMinor: 2_000_000n, costNgn: 210_000_000n }, currency: 'CNY', amountMinor: 2_000_000n, spot: SPOT_CBN }).lines;
  assert.equal(jobPosition([...invoiceD, ...settled, ...mirror(settled)], 'D').carNgn, 210_000_000n);
  // A pool payment that was reversed leaves no cost behind.
  const paid = payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 2_000_000n, vehicleId: 'E', spot: SPOT_CBN }).lines;
  assert.deepEqual(jobPosition([...paid, ...mirror(paid)], 'E'), { carCurrency: undefined, carMinor: 0n, carNgn: 0n, costNgn: 0n, fundsHeldNgn: 0n });
  assert.equal(spotCarCost([...paid, ...mirror(paid)], 'E'), 0n);
  // A payment in the wrong currency, reversed, then the right one: the car is paid in CNY and completes (ledger audit of 0015).
  const usd = payFromPool({ pool: { balanceMinor: 100_000n, costNgn: 150_000_000n }, currency: 'USD', amountMinor: 100_000n, vehicleId: 'E', spot: SPOT_CBN }).lines;
  const history2 = [...usd, ...mirror(usd), ...paid];
  assert.equal(jobPosition(history2, 'E').carCurrency, 'CNY');
  assert.ok(completeAgentJob({ ...job('E'), quote: { ...quoteA, landingChargeNgn: 0n }, history: history2 }).lines.length > 0);
});

// Spot basis (ADR 0009: what clients see). Car A: CNY 40,000.00 paid from the pool on a day the CBN spot rate was 108 ->
// spot-basis cost NGN 4,320,000.00 (pool basis 4,266,666.67). Car D: invoiced CNY 20,000.00 on a day spot was 108 ->
// NGN 2,160,000.00 (the agent's invoice rate of 105 gives the firm's booked 2,100,000.00).
test('spot basis: each foreign cost at the spot rate on its own transaction day', () => {
  const a = payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines;
  assert.equal(spotCarCost(a, 'A'), 432_000_000n);
  assert.equal(jobPosition(a, 'A').carNgn, 426_666_667n, 'pool basis, for the firm only');
  assert.equal(spotCarCost(invoiceD, 'D'), 216_000_000n);
  assert.equal(spotCarCost(a, 'nobody'), 0n);
  // A cost line with no spot rate (e.g. posted before ADR 0009) counts at its booked NGN.
  assert.equal(spotCarCost(historyX, 'X'), 120_000n);
  const manual = payFromPool({ pool: { balanceMinor: 100n, costNgn: 10_000n }, currency: 'CNY', amountMinor: 100n, vehicleId: 'M', spot: { rate: parseRate('99.000000'), source: 'manual' } /* fixture */, rateNote: 'BDC receipt, CBN rate not yet published' });
  const [, poolLine] = manual.lines;
  assert.deepEqual([poolLine?.spotSource, poolLine?.rateNote], ['manual', 'BDC receipt, CBN rate not yet published']);
});

// Month-end revaluation (spec FX rule 6, ADR 0011). At the end of the worked example the pool holds CNY 30,000.00 at
// NGN 3,200,000.00, and supplier S is owed CNY 20,000.00 for car D, booked at 105 = NGN 2,100,000.00. The closing CBN
// rate is FIXTURE_RATE_CLOSE (112):
//   pool     30,000.00 x 112 = NGN 3,360,000.00, carrying 3,200,000.00 -> gain 160,000.00: Dr 1019 / Cr 7100
//   payables 20,000.00 x 112 = NGN 2,240,000.00, carrying 2,100,000.00 -> loss 140,000.00: Dr 7100 / Cr 2009
//   net unrealized FX (7100): gain NGN 20,000.00. The reversal on day 1 of the next period is the exact mirror.
// The pool (1010) and payables (2000) keep their cost: the adjustment lives on 1019 and 2009 only.
const FIXTURE_RATE_CLOSE = parseRate('112.000000');

test('worked example: month-end revaluation restates the pool and payables at the closing rate, to the kobo', () => {
  const r = revalue([
    { item: 'pool', currency: 'CNY', balanceMinor: 3_000_000n, carryingNgn: 320_000_000n, closingRate: FIXTURE_RATE_CLOSE },
    { item: 'payables', currency: 'CNY', balanceMinor: 2_000_000n, carryingNgn: 210_000_000n, closingRate: FIXTURE_RATE_CLOSE },
  ]);
  assert.deepEqual(only(r.lines), [['1019', 16_000_000n, 0n, null], ['7100', 0n, 16_000_000n, null], ['7100', 14_000_000n, 0n, null], ['2009', 0n, 14_000_000n, null]]);
  assert.ok(r.lines.every((l) => l.currency === 'NGN'));
  assert.ok(balanced(r.lines));
  assert.deepEqual(balances(r.lines), { '1019': 16_000_000n, '7100': -2_000_000n, '2009': -14_000_000n });
  assert.deepEqual(r.rows.map((x) => x.closingNgn), [336_000_000n, 224_000_000n]);
  assert.deepEqual(balances([...r.lines, ...r.reversal]), { '1019': 0n, '7100': 0n, '2009': 0n }, 'the day-1 reversal undoes it exactly');
});

test('revaluation: losses on the pool, gains on payables, nothing to post when carrying equals closing; bad input refused', () => {
  const r = revalue([
    { item: 'pool', currency: 'USD', balanceMinor: 100n, carryingNgn: 200_000n, closingRate: parseRate('1500.000000') }, // fixture: 1.00 USD carried at 2,000.00, closes at 1,500.00
    { item: 'payables', currency: 'USD', balanceMinor: 100n, carryingNgn: 200_000n, closingRate: parseRate('1500.000000') },
    { item: 'pool', currency: 'CNY', balanceMinor: 100n, carryingNgn: 11_200n, closingRate: FIXTURE_RATE_CLOSE }, // no change, no lines
  ]);
  assert.deepEqual(only(r.lines), [['1019', 0n, 50_000n, null], ['7100', 50_000n, 0n, null], ['7100', 0n, 50_000n, null], ['2009', 50_000n, 0n, null]]);
  assert.equal(r.rows.length, 3, 'every item is recorded, even with no difference');
  const item = { item: 'pool' as const, currency: 'CNY', balanceMinor: 1n, carryingNgn: 0n, closingRate: FIXTURE_RATE_CLOSE };
  assert.throws(() => revalue([{ ...item, currency: 'NGN' }]), /NGN is not revalued/);
  assert.throws(() => revalue([{ ...item, balanceMinor: -1n }]), /cannot be negative/);
  assert.throws(() => revalue([{ ...item, closingRate: 0n }]), /closing rate must be positive/);
  assert.throws(() => revalue([item, item]), /CNY pool is listed twice/);
});

// EMM-funded stock (principal accounting, ADR 0001, ADR 0012), worked by hand. Pool CNY 150,000.00 at NGN 16,000,000.00.
//  1. EMM pays the China supplier CNY 30,000.00 for car S from the pool: 16,000,000.00 x 30/150 = NGN 3,200,000.00 -> Dr 1200 S
//  2. Form M for car S, NGN 500,000.00 paid in cash                                                      -> Dr 1200 S
//  3. Car S reaches the yard: its NGN 3,700,000.00 in transit moves to 1210
//  4. A buyer pays a deposit of NGN 2,000,000.00 (2100, customer deposits)
//  5. Sold for NGN 4,500,000.00: Dr 2100 2,000,000.00 + Dr 1100 2,500,000.00 / Cr 4000 4,500,000.00 (gross),
//     and the full landed cost Dr 5000 / Cr 1210 3,700,000.00 -> gross profit NGN 800,000.00, all inventory cleared.
// Convert to stock (owner 2026-11-15: an abandoned job's customer funds are refunded, never forfeited): job A had
// NGN 4,266,666.67 + 1,316,666.67 = 5,583,333.34 capitalized in 1150 and NGN 6,000,000.00 held in 2150 ->
// Dr 1200 A / Cr 1150 A 5,583,333.34, and Dr 2150 / Cr 1000 6,000,000.00 back to the customer.
const stockPool = { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n };
const buyer = { vehicleId: 'S', counterpartyId: 'buyer-S' };
// More paid back to a customer than was held for them (a mistake the rule must refuse to build on).
const ngnRefund = (v: string, amount: bigint): Line[] => [
  { account: '2150', debit: amount, credit: 0n, currency: 'NGN', amountMinor: amount, vehicleId: v, counterpartyId: `customer-${v}` },
  { account: '1000', debit: 0n, credit: amount, currency: 'NGN', amountMinor: amount },
];

test('worked example: an EMM-funded stock car from purchase to gross sale, to the kobo', () => {
  const entries: Line[][] = [];
  entries.push(payFromPool({ pool: stockPool, currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'S', spot: SPOT_CBN, funding: 'emm_funded' }).lines);
  entries.push(sharedCost({ amountNgn: 50_000_000n, vehicleIds: ['S'], funding: 'emm_funded' }));
  assert.deepEqual(only(entries.flat().filter((l) => l.account === '1200')), [['1200', 320_000_000n, 0n, 'S'], ['1200', 50_000_000n, 0n, 'S']]);
  entries.push(arriveInYard({ vehicleId: 'S', history: entries.flat() }));
  assert.deepEqual(only(entries[2] ?? []), [['1210', 370_000_000n, 0n, 'S'], ['1200', 0n, 370_000_000n, 'S']]);
  entries.push(stockDeposit({ ...buyer, amountNgn: 200_000_000n }));
  const sale = sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: entries.flat() });
  assert.deepEqual(only(sale), [['2100', 200_000_000n, 0n, 'S'], ['1100', 250_000_000n, 0n, 'S'], ['4000', 0n, 450_000_000n, 'S'], ['5000', 370_000_000n, 0n, 'S'], ['1210', 0n, 370_000_000n, 'S']]);
  entries.push(sale);
  assert.ok(entries.every(balanced));
  const b = balances(entries.flat());
  assert.deepEqual([b['1200'], b['1210'], b['2100'], b['1100'], b['4000'], b['5000']], [0n, 0n, 0n, 250_000_000n, -450_000_000n, 370_000_000n]);
  assert.equal(-(b['4000'] ?? 0n) - (b['5000'] ?? 0n), 80_000_000n, 'gross profit NGN 800,000.00');
  assert.equal(entries.flat().filter((l) => ['1150', '2150', '4100', '4200'].includes(l.account)).length, 0, 'no agent accounts touched');
});

test('EMM-funded guards: in transit, nothing to move, deposits over the price; supplier invoices capitalize to 1200 too', () => {
  const paid = payFromPool({ pool: stockPool, currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'S', spot: SPOT_CBN, funding: 'emm_funded' }).lines;
  assert.throws(() => sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: paid }), /still in transit/);
  assert.throws(() => arriveInYard({ vehicleId: 'S', history: [] }), /in-transit cost must be positive/);
  const inYard = [...paid, ...arriveInYard({ vehicleId: 'S', history: paid })];
  assert.throws(() => sellStockCar({ ...buyer, priceNgn: 0n, history: inYard }), /price must be positive/);
  assert.throws(() => sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: [] }), /cost in the yard must be positive/);
  // Deposits over the price: the sale applies NGN 1,000,000.00 of the buyer's NGN 2,000,000.00; the other NGN 1,000,000.00 stays
  // theirs on 2100 until refunded (a real sale is recorded, never refused for it).
  const overpaid = sellStockCar({ ...buyer, priceNgn: 100_000_000n, history: [...inYard, ...stockDeposit({ ...buyer, amountNgn: 200_000_000n })] });
  assert.deepEqual(only(overpaid).slice(0, 2), [['2100', 100_000_000n, 0n, 'S'], ['4000', 0n, 100_000_000n, 'S']]);
  assert.throws(() => stockDeposit({ ...buyer, amountNgn: 0n }), /deposit must be positive/);
  const invoice = supplierInvoice({ ...supplier, vehicleId: 'S', currency: 'CNY', amountMinor: 2_000_000n, rate: FIXTURE_RATE_INVOICE, spot: SPOT_CBN, funding: 'emm_funded' });
  assert.deepEqual(only(invoice)[0], ['1200', 210_000_000n, 0n, 'S']);
  // A sale with no deposit is all receivable.
  assert.deepEqual(only(sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: inYard })).slice(0, 2), [['1100', 450_000_000n, 0n, 'S'], ['4000', 0n, 450_000_000n, 'S']]);
  // The sale invoice backs the revenue line, and only it.
  const invoiced = sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: inYard, evidenceDocumentId: 'doc-sale' });
  assert.deepEqual(invoiced.map((l) => [l.account, l.evidenceDocumentId]), [['1100', undefined], ['4000', 'doc-sale'], ['5000', undefined], ['1210', undefined]]);
});

test('convert to stock: the abandoned job\'s cost becomes inventory and the customer is repaid in full', () => {
  const history: Line[] = [
    ...customerReceipt({ ...job('A'), amountNgn: 600_000_000n }),
    ...payFromPool({ pool: stockPool, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines,
    ...sharedCost({ amountNgn: 131_666_667n, vehicleIds: ['A'] }),
  ];
  const c = convertToStock({ ...job('A'), history });
  assert.deepEqual(only(c), [['1200', 558_333_334n, 0n, 'A'], ['1150', 0n, 558_333_334n, 'A'], ['2150', 600_000_000n, 0n, 'A'], ['1000', 0n, 600_000_000n, null]]);
  assert.ok(balanced(c));
  const after = balances([...history, ...c]);
  assert.deepEqual([after['1150'], after['2150'], after['1200']], [0n, 0n, 558_333_334n]);
  // Nothing held yet (the customer hadn't paid): only the cost moves.
  const unpaid = history.filter((l) => l.account !== '2150' && !(l.account === '1000' && l.debit > 0n));
  assert.deepEqual(only(convertToStock({ ...job('A'), history: unpaid })).map((r) => r[0]), ['1200', '1150']);
  // The conversion's document backs the inventory line, so it is kept even when no cash moves.
  assert.deepEqual(convertToStock({ ...job('A'), history: unpaid, evidenceDocumentId: 'doc-convert' }).map((l) => [l.account, l.evidenceDocumentId]),
    [['1200', 'doc-convert'], ['1150', undefined]]);
  assert.throws(() => convertToStock({ ...job('A'), history: customerReceipt({ ...job('A'), amountNgn: 1n }) }), /job cost must be positive/);
  assert.throws(() => convertToStock({ ...job('A'), history: [...history, ...ngnRefund('A', 700_000_000n)] }), /negative/);
});

test('a car is a job or stock, never both; deposits belong to their buyer and can be refunded', () => {
  const paid = payFromPool({ pool: stockPool, currency: 'CNY', amountMinor: 3_000_000n, vehicleId: 'S', spot: SPOT_CBN, funding: 'emm_funded' }).lines;
  const quote = { currency: 'CNY', sellingMinor: 3_500_000n, rate: FIXTURE_RATE_QUOTE, landingChargeNgn: 0n };
  assert.throws(() => completeAgentJob({ ...buyer, quote, history: paid }), /this car is EMM stock/);
  assert.throws(() => completeClearingJob({ ...buyer, landingChargeNgn: 1n, history: paid }), /this car is EMM stock/);
  assert.throws(() => convertToStock({ ...buyer, history: paid }), /this car is EMM stock/);
  // A completed agent job can't be converted afterwards (it would be sold twice).
  const jobA = [...customerReceipt({ ...job('A'), amountNgn: 600_000_000n }), ...payFromPool({ pool: stockPool, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines];
  const done = completeAgentJob({ ...job('A'), quote: quoteA, history: jobA }).lines;
  assert.throws(() => convertToStock({ ...job('A'), history: [...jobA, ...done, ...sharedCost({ amountNgn: 1n, vehicleIds: ['A'] })] }), /already completed/);
  // Buyer B1 put down a deposit and walked away; B2 buys: B1's deposit isn't B2's, and B1 gets theirs back.
  const inYard = [...paid, ...arriveInYard({ vehicleId: 'S', history: paid })];
  const b1 = { vehicleId: 'S', counterpartyId: 'buyer-1' };
  const withB1 = [...inYard, ...stockDeposit({ ...b1, amountNgn: 200_000_000n })];
  assert.deepEqual(only(sellStockCar({ ...buyer, priceNgn: 450_000_000n, history: withB1 })).slice(0, 2), [['1100', 450_000_000n, 0n, 'S'], ['4000', 0n, 450_000_000n, 'S']]);
  assert.deepEqual(only(refundStockDeposit({ ...b1, amountNgn: 200_000_000n, history: withB1 })), [['2100', 200_000_000n, 0n, 'S'], ['1000', 0n, 200_000_000n, null]]);
  assert.throws(() => refundStockDeposit({ ...b1, amountNgn: 200_000_001n, history: withB1 }), /refund exceeds what this buyer paid/);
  assert.throws(() => refundStockDeposit({ ...buyer, amountNgn: 1n, history: withB1 }), /refund exceeds what this buyer paid/);
  assert.throws(() => refundStockDeposit({ ...b1, amountNgn: 0n, history: withB1 }), /refund must be positive/);
});

test('a clearing-only job is the customer\'s own car: it cannot become stock', () => {
  const clearing = [...customerReceipt({ ...job('K'), amountNgn: 200_000_000n }), ...sharedCost({ amountNgn: 150_000_000n, vehicleIds: ['K'] })];
  assert.throws(() => convertToStock({ ...job('K'), history: clearing }), /clearing-only job is the customer's own car/);
});

test('customer refund, receivable receipt and supplier credit: each within what the ledger says, naming the job', () => {
  const held = customerReceipt({ ...job('R'), amountNgn: 500_000n });
  assert.deepEqual(only(customerRefund({ ...job('R'), amountNgn: 500_000n, history: held })), [['2150', 500_000n, 0n, 'R'], ['1000', 0n, 500_000n, null]]);
  assert.throws(() => customerRefund({ ...job('R'), amountNgn: 500_001n, history: held }), /refund exceeds the customer funds held/);
  assert.throws(() => customerRefund({ ...job('R'), amountNgn: 0n, history: held }), /refund must be positive/);
  // Job A completed with NGN 450,000.00 still owed (the worked example's figures, on a fresh pool).
  const jobA = [...customerReceipt({ ...job('A'), amountNgn: 600_000_000n }), ...payFromPool({ pool: { balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, currency: 'CNY', amountMinor: 4_000_000n, vehicleId: 'A', spot: SPOT_CBN }).lines,
    ...sharedCost({ amountNgn: 131_666_667n, vehicleIds: ['A'] })];
  const owed = [...jobA, ...completeAgentJob({ ...job('A'), quote: quoteA, history: jobA }).lines];
  assert.deepEqual(only(receivableReceipt({ ...job('A'), amountNgn: 45_000_000n, history: owed })), [['1000', 45_000_000n, 0n, null], ['1100', 0n, 45_000_000n, 'A']]);
  assert.throws(() => receivableReceipt({ ...job('A'), amountNgn: 45_000_001n, history: owed }), /exceeds what this customer owes/);
  assert.throws(() => receivableReceipt({ vehicleId: 'A', counterpartyId: 'someone-else', amountNgn: 1n, history: owed }), /exceeds what this customer owes/);
  assert.throws(() => receivableReceipt({ ...job('A'), amountNgn: 0n, history: owed }), /receipt must be positive/);
  // A supplier's credit on car K's NGN costs: off what is owed to them for K, or as cash back; never more than K's job costs.
  const costs = sharedCost({ amountNgn: 150_000n, vehicleIds: ['K'] });
  const credit = supplierCredit({ vehicleId: 'K', amountNgn: 50_000n, history: costs, supplierId: 'supplier-1' });
  assert.deepEqual(only(credit), [['2000', 50_000n, 0n, 'K'], ['1150', 0n, 50_000n, 'K']]);
  assert.equal(credit[0]?.counterpartyId, 'supplier-1');
  assert.deepEqual(only(supplierCredit({ vehicleId: 'K', amountNgn: 150_000n, history: costs })), [['1000', 150_000n, 0n, null], ['1150', 0n, 150_000n, 'K']]);
  assert.throws(() => supplierCredit({ vehicleId: 'K', amountNgn: 150_001n, history: costs }), /credit exceeds the job costs/);
  assert.throws(() => supplierCredit({ vehicleId: 'K', amountNgn: 0n, history: costs }), /credit must be positive/);
});

test('a pool payment is positive and within the currency the pool holds: the rule refuses it in its own words', () => {
  const pool = { balanceMinor: 1_000_000n, costNgn: 100_000_000n };
  assert.throws(() => payFromPool({ pool, currency: 'CNY', amountMinor: 1_000_001n, vehicleId: 'A', spot: SPOT_CBN }), /payment exceeds the CNY held in the pool/);
  assert.throws(() => payFromPool({ pool, currency: 'CNY', amountMinor: 0n, vehicleId: 'A', spot: SPOT_CBN }), /amount must be positive/);
});

test('a zero settlement is the rule refusing it, not a pool error', () => {
  const payable = { balanceMinor: 2_000_000n, costNgn: 210_000_000n };
  assert.throws(() => payPayableFromPool({ vehicleId: 'D', supplierId: 'S', pool: { balanceMinor: 10_000_000n, costNgn: 1_000_000_000n }, payable, currency: 'CNY', amountMinor: 0n, spot: SPOT_CBN }),
    (err: unknown) => err instanceof RuleError && /amount must be positive/.test(err.message));
});

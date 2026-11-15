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
import { parseRate, type Pool } from '@app/money';
import { buyCurrency, completeAgentJob, completeClearingJob, customerReceipt, jobPosition, payFromPool, sharedCost, type Line } from './index.ts';

const FIXTURE_RATE_BUY_1 = parseRate('100.000000');
const FIXTURE_RATE_BUY_2 = parseRate('120.000000');
const FIXTURE_RATE_QUOTE = parseRate('110.000000');

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
    const r = payFromPool({ pool, currency: 'CNY', amountMinor, vehicleId });
    pool = r.pool;
    entries.push(r.lines);
    return r.lines;
  };
  assert.deepEqual(pay('A', 4_000_000n), [
    { account: '1150', debit: 426_666_667n, credit: 0n, currency: 'NGN', amountMinor: 426_666_667n, vehicleId: 'A' },
    { account: '1010', debit: 0n, credit: 426_666_667n, currency: 'CNY', amountMinor: 4_000_000n, rate: '106.666667', rateSource: 'pool_average', vehicleId: 'A' },
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
  assert.throws(() => payFromPool({ pool: { balanceMinor: 10n ** 12n, costNgn: 1n }, currency: 'CNY', amountMinor: 1n, vehicleId: 'Z' }), /rounds to zero/);
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

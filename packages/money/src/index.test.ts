import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, money, parseRate, convert, allocateEqual, allocateByWeight, divHalfUp, formatRate, poolSpend, rateOf, RATE_SCALE } from './index.ts';

// Seeded PRNG so failures reproduce. Rates here are test fixtures, not real rates.
let seed = 123456789n;
const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), (seed >> 11n) % max);

test('parseRate accepts up to 6 decimals and rejects everything else', () => {
  assert.equal(parseRate('210'), 210_000_000n);
  assert.equal(parseRate('0.5'), 500_000n);
  assert.equal(parseRate('219.520001'), 219_520_001n);
  for (const bad of ['', '-1', '1e3', '1.1234567', '.5', 'abc', '1,5']) assert.throws(() => parseRate(bad));
  assert.throws(() => parseRate('0.000000'));
});

test('convert rounds half-up, away from zero for negatives', () => {
  assert.equal(convert(1n, parseRate('0.5')), 1n); // 0.5 -> 1
  assert.equal(convert(1n, parseRate('0.499999')), 0n);
  assert.equal(convert(-1n, parseRate('0.5')), -1n);
  assert.equal(convert(-1n, parseRate('0.499999')), 0n);
  assert.equal(convert(100n, parseRate('200.14')), 20014n); // worked: 1.00 x 200.14 = 200.14 (fixture rate)
});

test('10k random conversions: always within half a minor unit of the exact product, no drift', () => {
  for (let i = 0; i < 10_000; i++) {
    const amount = rnd(10n ** 15n) * (rnd(2n) === 0n ? 1n : -1n);
    const rate = rnd(10n ** 9n) + 1n;
    const r = convert(amount, rate);
    const err = (r * RATE_SCALE - amount * rate) * 2n; // 2 * (rounded - exact), scaled
    assert.ok((err < 0n ? -err : err) <= RATE_SCALE, `drift: ${String(amount)} x ${String(rate)}`);
  }
});

test('allocateEqual: remainder on the first car, shares always sum to total', () => {
  assert.deepEqual(allocateEqual(249999999n, 3), [83333333n, 83333333n, 83333333n]);
  assert.deepEqual(allocateEqual(10n, 3), [4n, 3n, 3n]);
  assert.deepEqual(allocateEqual(-10n, 3), [-4n, -3n, -3n]);
  assert.deepEqual(allocateEqual(0n, 2), [0n, 0n]);
  for (let i = 0; i < 10_000; i++) {
    const total = rnd(10n ** 14n) - 5n * 10n ** 13n;
    const n = Number(rnd(12n)) + 1;
    assert.equal(allocateEqual(total, n).reduce((a, b) => a + b, 0n), total);
  }
  assert.throws(() => allocateEqual(1n, 0));
  assert.throws(() => allocateEqual(1n, 1.5));
});

test('add/sub refuse mixed currencies', () => {
  assert.deepEqual(add(money(5n, 'NGN'), money(7n, 'NGN')), money(12n, 'NGN'));
  assert.deepEqual(sub(money(5n, 'NGN'), money(7n, 'NGN')), money(-2n, 'NGN'));
  assert.throws(() => add(money(1n, 'NGN'), money(1n, 'CNY')));
});

test('divHalfUp rounds exact halves away from zero', () => {
  assert.equal(divHalfUp(5n, 2n), 3n);
  assert.equal(divHalfUp(-5n, 2n), -3n);
  assert.equal(divHalfUp(4n, 3n), 1n);
  assert.throws(() => divHalfUp(1n, 0n));
});

test('rateOf and formatRate: NGN 4,266,666.67 for CNY 40,000.00 is a rate of 106.666667', () => {
  assert.equal(rateOf(426_666_667n, 4_000_000n), 106_666_667n);
  assert.equal(formatRate(106_666_667n), '106.666667');
  assert.equal(formatRate(500_000n), '0.500000');
  assert.throws(() => formatRate(-1n), /negative/);
});

// Worked example (hand-computed, fixture rates): CNY 100,000.00 bought at 100 = NGN 10,000,000.00 and
// CNY 50,000.00 at 120 = NGN 6,000,000.00 -> pool CNY 150,000.00 costing NGN 16,000,000.00.
test('poolSpend: weighted-average cost out, and the pool empties to exactly zero', () => {
  const a = poolSpend({ balanceMinor: 15_000_000n, costNgn: 1_600_000_000n }, 4_000_000n); // 16,000,000 x 40/150 = 4,266,666.666.. -> .67
  assert.equal(a.costNgn, 426_666_667n);
  assert.deepEqual(a.pool, { balanceMinor: 11_000_000n, costNgn: 1_173_333_333n });
  const b = poolSpend(a.pool, 3_500_000n); // 11,733,333.33 x 35/110 = 3,733,333.33..
  assert.equal(b.costNgn, 373_333_333n);
  const c = poolSpend(b.pool, b.pool.balanceMinor); // empty it: takes the remainder, no drift
  assert.deepEqual(c.pool, { balanceMinor: 0n, costNgn: 0n });
  assert.equal(a.costNgn + b.costNgn + c.costNgn, 1_600_000_000n);
  assert.throws(() => poolSpend(c.pool, 1n));
  assert.throws(() => poolSpend(a.pool, 0n));
});

test('allocateByWeight: proportional, remainder on the first car, always sums to total', () => {
  assert.deepEqual(allocateByWeight(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(allocateByWeight(1_000_000_00n, [4_000_000n, 3_500_000n, 4_500_000n]), [33_333_334n, 29_166_666n, 37_500_000n]);
  assert.throws(() => allocateByWeight(1n, []));
  assert.throws(() => allocateByWeight(1n, [1n, 0n]));
});

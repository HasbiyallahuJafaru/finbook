import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub, money, parseRate, convert, allocateEqual, RATE_SCALE } from './index.ts';

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
    assert.ok((err < 0n ? -err : err) <= RATE_SCALE, `drift: ${amount} x ${rate}`);
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

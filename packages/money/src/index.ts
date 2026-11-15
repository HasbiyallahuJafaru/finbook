// bigint minor-unit money + scaled-bigint FX rates. No dependencies (ADR 0003).
export type Money = { readonly amount: bigint; readonly currency: string };

export const RATE_SCALE = 1_000_000n; // NUMERIC(18,6)

export const money = (amount: bigint, currency: string): Money => ({ amount, currency });

const same = (a: Money, b: Money) => {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
};
export const add = (a: Money, b: Money): Money => (same(a, b), money(a.amount + b.amount, a.currency));
export const sub = (a: Money, b: Money): Money => (same(a, b), money(a.amount - b.amount, a.currency));

/** Decimal string with up to 6 places -> rate scaled by 10^6. Rejects floats, signs, exponents. */
export function parseRate(s: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error(`invalid rate: ${s}`);
  const [whole, frac = ''] = s.split('.') as [string, string?];
  const rate = BigInt(whole) * RATE_SCALE + BigInt(frac.padEnd(6, '0'));
  if (rate === 0n) throw new Error('rate must be positive');
  return rate;
}

/** n / d rounded half-up (away from zero for negatives). d must be positive. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error('divisor must be positive');
  return n >= 0n ? (2n * n + d) / (2n * d) : -((-2n * n + d) / (2n * d));
}

/** amount * rate, rounded half-up (away from zero for negatives) to the minor unit. Same-exponent currencies only. */
export const convert = (amount: bigint, rate: bigint): bigint => divHalfUp(amount * rate, RATE_SCALE);

/** The 6-decimal rate implied by an NGN amount and a foreign amount (both minor units), rounded half-up. */
export const rateOf = (ngnMinor: bigint, amountMinor: bigint): bigint => divHalfUp(ngnMinor * RATE_SCALE, amountMinor);

/** Scaled rate -> the decimal string stored in NUMERIC(18,6), e.g. 106666667n -> "106.666667". */
export function formatRate(rate: bigint): string {
  if (rate < 0n) throw new Error('rate cannot be negative');
  return `${String(rate / RATE_SCALE)}.${String(rate % RATE_SCALE).padStart(6, '0')}`;
}

export type Pool = { readonly balanceMinor: bigint; readonly costNgn: bigint };

/**
 * Spend foreign currency from a weighted-average pool (spec → Currency and FX, rule 4).
 * Cost out = pool cost x spend / balance, half-up; emptying the pool takes all its remaining cost,
 * so the pool's NGN always returns to exactly zero.
 */
export function poolSpend(pool: Pool, spendMinor: bigint): { costNgn: bigint; pool: Pool } {
  if (spendMinor <= 0n || spendMinor > pool.balanceMinor) throw new Error('spend must be positive and within the pool balance');
  const costNgn = spendMinor === pool.balanceMinor ? pool.costNgn : divHalfUp(pool.costNgn * spendMinor, pool.balanceMinor);
  return { costNgn, pool: { balanceMinor: pool.balanceMinor - spendMinor, costNgn: pool.costNgn - costNgn } };
}

/** Equal split in minor units; the remainder goes on the first share, so shares always sum to total. */
export function allocateEqual(total: bigint, n: number): bigint[] {
  // eslint-disable-next-line no-restricted-globals -- n is a share count, not money
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  const count = BigInt(n);
  const share = total / count; // truncates toward zero
  const extra = total - share * count;
  return Array.from({ length: n }, (_, i) => (i === 0 ? share + extra : share));
}

/** Split in proportion to positive weights (e.g. car values); remainder on the first share, so shares sum to total. */
export function allocateByWeight(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0 || weights.some((w) => w <= 0n)) throw new Error('weights must be positive');
  const sum = weights.reduce((a, b) => a + b, 0n);
  const shares = weights.map((w) => (total * w) / sum); // truncates toward zero
  const extra = total - shares.reduce((a, b) => a + b, 0n);
  return shares.map((s, i) => (i === 0 ? s + extra : s));
}

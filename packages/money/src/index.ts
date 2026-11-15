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
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`invalid rate: ${s}`);
  const rate = BigInt(m[1]) * RATE_SCALE + BigInt((m[2] ?? '').padEnd(6, '0'));
  if (rate === 0n) throw new Error('rate must be positive');
  return rate;
}

/** amount * rate, rounded half-up (away from zero for negatives) to the minor unit. Same-exponent currencies only. */
export function convert(amount: bigint, rate: bigint): bigint {
  const p = amount * rate;
  const half = RATE_SCALE / 2n;
  return p >= 0n ? (p + half) / RATE_SCALE : -((-p + half) / RATE_SCALE);
}

/** Equal split in minor units; the remainder goes on the first share, so shares always sum to total. */
export function allocateEqual(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a positive integer');
  const count = BigInt(n);
  const share = total / count; // truncates toward zero
  const shares = Array<bigint>(n).fill(share);
  shares[0] += total - share * count;
  return shares;
}

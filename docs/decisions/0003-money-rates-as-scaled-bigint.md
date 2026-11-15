# 0003 — FX rates as scaled bigint, no decimal library

- Status: accepted
- Date: 2026-11-15

## Decision
- `packages/money` has no runtime dependencies. Amounts are `bigint` minor units; rates are decimal strings with up to 6 decimal places, parsed into a `bigint` scaled by 10^6 (the `NUMERIC(18,6)` column maps 1:1).
- Conversion: `minor × rate_scaled`, then divide by 10^6 and adjust for the minor-unit difference between currencies, rounding half-up (away from zero for negatives) in integer arithmetic.
- Weighted-average pool cost and any derived rate use the same integer division with half-up rounding at the final step.

## Why
The spec says the money package has "no deps". Scaled bigint is exact for 6-decimal rates, and a decimal library would add a dependency without making it more correct. It also keeps the maths auditable in one small file.

## Consequence
CLAUDE.md's "handled with the decimal library" now reads "handled as scaled bigint in `packages/money`". If we ever need rates with more than 6 decimal places, change the scale constant and the column together.

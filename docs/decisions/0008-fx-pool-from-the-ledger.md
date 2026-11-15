# 0008 — The foreign-currency pool is derived from the ledger

- Status: proposed (needs the owner's confirmation: it departs from the spec's `fx_pools` table)
- Date: 2026-11-15

## Decision
- There is no `fx_pools` table. A currency's pool is the sum of its lines on account 1010: foreign balance = foreign amounts in minus out, NGN cost = debits minus credits. The API reads it inside the posting transaction (under the tenant's ledger lock) and passes it to `payFromPool` in `packages/ledger`.
- Money leaving the pool carries the pool's exact weighted-average NGN cost (`poolSpend` in `packages/money`, half-up; emptying the pool takes all remaining cost, so it always returns to exactly zero).
- Those lines use the rate source `pool_average`. Their check runs the other way round from receipt lines: the stored rate must equal NGN ÷ amount rounded to 6 decimals, because the NGN figure is the fact and the rate only describes it (migration 0004). Lines from receipts keep the rule NGN = round(amount × rate).

- The database enforces it (migration 0004, `check_pool_line`): a `pool_average` line must be a credit, within the pool's balance, at exactly the cost `poolSpend` gives, re-computed from the ledger under the tenant's ledger lock. The lock is taken before reading and held to commit, so two concurrent payments can't both spend the same balance. The one allowed debit is inside a reversal, which the commit-time mirror check (now also matching rate source, car and customer) proves is exact.
- The posting rules take the car's own ledger history: supplier cost, capitalized cost and the customer's funds held are derived, never typed in. Every 2150 and 1100 line names its car and customer.

## Why
- CLAUDE.md: "Every balance comes from journal_lines. Nothing else stores a balance." A stored pool would be a second balance that can drift from the ledger.
- A 6-decimal rate can't reproduce an exact weighted-average cost for large amounts (CNY 200,000.00 × a 6-dp rate can be off by several kobo), so forcing NGN = round(amount × rate) on pool lines would either reject correct postings or need a rounding line on a foreign-currency account, which the currency rules forbid.

## Consequences
- The spec's Data model lists `fx_pools`. If the owner wants that table kept (for speed or reporting), it must be a cache rebuilt from the ledger, never the source.
- Realized FX on payables settled at a different rate, and month-end revaluation (7100, auto-reversing), are the next phase 2 slices. Revaluation lines must not count towards the pool cost (they reverse on day 1), so they'll post to a separate revaluation account, not 1010.
- Pool payments for one tenant are serialized from the first pool line to commit. Fine at our scale.
- Spec reading to confirm: spec rule 5 (currency leaving the pool at a rate other than its average posts to 7000) is met because pool spends always leave at average cost; the quote-vs-paid gap is taken at job completion (spec line 157).

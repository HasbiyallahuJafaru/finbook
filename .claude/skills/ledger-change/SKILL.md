---
name: ledger-change
description: Use for any change to posting rules, journal entries, the chart of accounts, FX handling, cost allocation, job-order accounting (agent vs principal), the cut calculation, period locking, or any report figure. Enforces test-first, to-the-kobo worked examples.
---

# Ledger change

Money bugs are silent. This procedure makes them loud.

## Before writing code

1. Read the relevant spec section in `docs/spec/build-spec.md` (Accounting core, Vehicle module, Currency and FX). Run `graphify query "<rule or account>"` to find every place that already touches it.
2. Write down, in the test file, the business event in plain words and the exact journal lines expected: account, debit or credit in NGN kobo, currency, foreign minor amount, rate.

## Write the failing test first

- Use the shared fixtures in `packages/ledger/test/fixtures/`. The EMM's Shop C4 container is the reference case: 3 cars, shared costs split equally, totals that must tie to the payments to the kobo.
- Fixture rates are labelled `FIXTURE_RATE_*`. Never use a real-looking rate inline.
- Assert all four: lines balance, each line's amount, the account balances afterwards, and the trial balance still nets to zero.
- For allocation: assert that the allocated shares add up exactly to the amount paid, with the remainder on the first car.
- For agent jobs (`customer_funded`): no inventory account is touched. The cut posts to 4100 (car markup at the quote-day rate) and 4200 (landing charge minus actual landed cost). The rate gap posts to 7000.
- For `emm_funded` jobs: inventory 1200/1210 is used and the sale posts gross. Postings go through before any sign-off; until a firm reviewer signs off the treatment, the job shows on `job_order_exceptions`.
- We are the client's bookkeepers (CLAUDE.md → Who we are): a rule refuses an entry only when the entry would make the books wrong or untraceable. A business-policy concern (paid before the customer paid, unconfirmed funding, costs before the quote) becomes an exception flag with a test proving it appears and clears, never a refusal.

## Implement

- Posting logic lives only in `packages/ledger`, as pure functions: event in, lines out. No DB access, no clock, no randomness.
- All arithmetic goes through `packages/money`.
- Persisting the lines happens in the API, in one transaction, with the idempotency key, the hash-chain field and an `audit_log` row.

## After

- Run the `verify` skill.
- Run the `ledger-auditor` subagent on the diff and fix what it reports.
- If the change alters how a figure is calculated, add an ADR in `docs/decisions/` that says why, and flag it to the user. An accountant may need to sign it off.

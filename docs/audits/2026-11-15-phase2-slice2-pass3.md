# Ledger audit — phase 2 slice 2 (spot rates + realized FX), pass 3

- Date: 2026-11-15
- Verdict: **FAIL** (two high findings). Code is committed (`2b4555f`), migration 0005 included, so every fix goes in a **new migration 0006**. Staging has not had 0005 applied yet: fix first, then apply 0005 + 0006 together.
- Tests at the time: ledger 10/10 (100% coverage), worker 6 (+1 Redis skip), DB integration 44/44.

## To fix (in order)

1. **High — NGN-currency lines bypass `check_foreign_account`** (0005, the early `currency = 'NGN'` return).
   - 2000 has no account currency, so Dr 2000 ₦2,000,000 (NGN line, supplier S, car A) / Cr 1000 "pays" a CNY invoice while its CNY balance stays open; it can then be paid again with `payPayableFromPool`.
   - 1010 is the pool for every currency (no account currency in production), so Dr 1150 car A / Cr 1010 as an NGN line raises the car's cost with no currency leaving any pool.
   - Tests miss it because the test chart sets 1010 to CNY.
   - Fix: refuse NGN lines on 1010; refuse NGN debits on 2000 that name a car or supplier with a foreign balance (or give 2000 one currency per account). Test with a 1010 that has no currency.
2. **High — "a car can't be paid twice" only guards one direction.**
   - (a) Pay car A from the pool, then post a supplier invoice for it: the cost doubles. Refuse an invoice for a car with net direct pool payments.
   - (b) Reversing a reversal re-posts a direct payment after an invoice exists. Forbid reversing an entry that is itself a reversal.
   - (c) A 1010 `pool_average` credit with no car skips the check. Require a car unless the entry has a `payable_average` line.
3. **Medium — foreign credits to 2000 aren't restricted to `agent_invoice`.** A `manual`/`bank_receipt` invoice needs no spot rate, is left out of car cost, and can be reversed after payments. Fix: a non-reversal foreign 2000 credit must be `agent_invoice`.
4. **Medium (reasoned) — `check_foreign_account` reads before taking the ledger lock.** An invoice and a direct pool payment for the same car in parallel can both commit. Fix: take the tenant advisory lock at the top for foreign lines on 1010/2000; add a race test.
5. **Low — tests that wouldn't fail without their fix:** per-car payables (add a two-car supplier test), latest CBN revision used by the trigger (post the revision-1 rate after revision 2 exists → refused), 8-day-old CBN rate (pin the boundary).
6. **Low — `fetched_at` can be set by the rates login.** Column-level INSERT without `fetched_at`, set it with `clock_timestamp()`; better, store the reference row (date, revision) on the line.
7. **Low — spot basis silently uses booked cost for lines without a spot rate** (pre-0005). Return a mixed-basis flag for reports.
8. **Low — over-blocking:** the invoice-reversal guard is per supplier+car, not per invoice; a foreign 2000 credit with no car can never be settled.

## Owner decisions raised

- **Evidence:** spec (Document storage) lets an entry post as "evidence pending"; CLAUDE.md's FX rule says every foreign line stores its evidence document, and CLAUDE.md ranks above the spec. Needs an owner ruling or ADR. Either way, the "evidence pending" flag, exception report and month-lock refusal don't exist yet and must be tracked.
- **Counterparty typing** deferred to the counterparties table (slice 3): auditor agrees, provided no endpoint writes `counterparty_id` before then.

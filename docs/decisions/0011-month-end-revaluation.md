# 0011 — Month-end revaluation: adjustment accounts, CBN closing rate, re-performed by the database

- Status: accepted (owner chose adjustment accounts and the CBN rate, 2026-11-15)
- Date: 2026-11-15
- Implements: spec → Currency and FX, rule 6

## Decision
- **What is revalued:** the foreign-currency pool (1010) and foreign supplier payables (2000), per currency. In the customer-funded (agent) model receivables (1100) are NGN only, so they aren't revalued. Inventory isn't (non-monetary, kept at cost).
- **Where the adjustment posts:** two new chart accounts, **1019 Foreign cash – revaluation** (asset) and **2009 Foreign payables – revaluation** (liability), against **7100 Unrealized FX**. 1010 and 2000 are never touched, so the pool's weighted-average cost and each payable's booked cost stay what was actually paid (migration 0006 keeps NGN off 1010 and limits NGN on 2000). The balance sheet shows 1010 + 1019 and 2000 + 2009 at the closing rate.
- **Closing rate:** the CBN central rate published on or before the period's last day, at most 7 days old, latest revision (the same rule as the spot basis, ADR 0010). With no such rate the revaluation is refused.
- **Dates:** a revaluation is dated its period's last day D and commits together with its exact reversal dated D + 1, the first day of the next period (which must exist and be open). So "auto-reverses" is guaranteed: there is no revaluation without its reversal.
- **Evidence:** every revaluation entry stores one `fx_revaluations` row per currency and item: foreign balance, carrying amount, the reference rate's date and revision, the rate and the closing NGN. Rows are append-only and can't be added once the entry posts.
- **Re-performed at commit** (migration 0007, `assert_fx_revaluation`, called by `post_journal_entry` just before the entry is hashed; 0006's whole-entry checks moved there too, because as separate deferred triggers they could be fired early with `SET CONSTRAINTS` and dodged by adding lines afterwards): the database recomputes each item's balance and carrying amount from the ledger on D, requires a row for every currency with a balance or a standing adjustment (and no others), checks each rate is the latest CBN rate, and checks 1019 and 2009 move by exactly the restated differences. Lines on 1019 or 2009 outside a revaluation are refused.
- **Carrying amount** = cost (1010) or booked amount (2000) on D, plus any earlier revaluation on or before D not yet reversed by D. A second revaluation for the same day (say after a backdated payment) therefore only posts the change.
- **Posting rule:** `revalue()` in `packages/ledger` (pure). A gain on the pool, or a fall in what is owed, credits 7100.

## Why
- Adjustment accounts keep the realized side clean: realized FX (7000) is always pool cost against the payable's booked cost, never mixed with month-end restatement. Tagging revaluation lines onto 1010/2000 would have meant every pool and payable calculation skipping them.
- The CBN rate is the official one an auditor expects, and the same source as the spot basis.
- Posting the reversal in the same transaction is simpler and stricter than a scheduled job that could fail.

## Consequences
- The default chart gains 1019 and 2009. The spec's chart (Claude Doc export) needs the same two rows; owner to tick it there.
- If the CBN feed is down for more than 7 days, no revaluation can post until a CBN row is added. Adding a reference rate by hand (with a note) needs a small admin path through the `finbook_rates` login; it arrives with the endpoints slice.
- Foreign money on the balance sheet may only sit on 1010 and 2000 (0007 refuses a foreign line on any other asset, liability or equity account), so nothing foreign escapes revaluation. Foreign receivables or a second pool would each need their own revaluation item first.
- The whole-entry checks are plain functions with EXECUTE revoked from PUBLIC; only `post_journal_entry` (owner) calls them.
- Reruns are safe because each query after the tenant lock takes a fresh snapshot (READ COMMITTED, which `withTenant` uses). Running ledger writes under REPEATABLE READ or SERIALIZABLE would break that; don't.
- To re-perform a row, use the entries dated on or before D whose hash `seq` is below the revaluation's own (the ledger as it stood when it posted), and the stored reference rate row. A re-perform view, or the chain head stored on each row, can come with reports (phase 4).
- **Stale revaluation (tracked for phase 4):** a posting backdated on or before D after the revaluation leaves it stale until someone reruns it. The database doesn't detect that yet; the period lock must refuse unless the latest revaluation still equals a fresh re-computation.
- Revaluation rows aren't in the hash chain. They can be re-performed from the ledger and the stored rates, which are append-only.
- Period close must run revaluation after the last posting of the month (spec: revaluation → review → lock). A posting backdated after revaluation needs a rerun; the period lock (phase 4) must refuse while the stored revaluation no longer matches (see Stale revaluation above).
- The bundle `schema_version` bump for the new table waits for the backup importer (phase 5).

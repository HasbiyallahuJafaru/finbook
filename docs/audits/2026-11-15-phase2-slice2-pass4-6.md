# Ledger audit — phase 2 slice 2, passes 4–6 (migration 0006)

- Date: 2026-11-15
- Verdict: **PASS WITH NOTES** (pass 6). Passes 4 and 5 were FAIL; their findings are fixed in 0006 (uncommitted at the time of each pass, so 0006 was revised rather than followed by 0007).
- Security review of 0006: PASS WITH NOTES; the medium finding (commit-time check blind if `app.tenant_id` changes before COMMIT) is fixed.
- Tests: DB integration 53/53 (with 0006 removed, the new tests fail); ledger 10/10 at 100% branch coverage; workspace lint, typecheck, unit and build green.

## What 0006 enforces

Row time (`check_foreign_account`, tenant lock taken before any read):
- 1010 takes no NGN line. Currency leaves it only as `pool_average`; a direct payment for a car with an open invoice is refused.
- A non-reversal foreign credit to 2000 is an `agent_invoice` naming supplier and car, refused if the car was already paid straight from the pool.
- A reversal can't be reversed (`check_reversal_target`).

Commit time (`check_foreign_entry`, definer, tenant-filtered):
- A supplier settlement holds only 2000 `payable_average`, 1010 `pool_average` (no car) and 7000 NGN lines, with settled = spent per currency and supplier, both ways. A missing chart account refuses, never passes.
- A car's pool payment or invoice puts the same amount on that car's 1150 in the same entry.
- Every non-reversal NGN line on 2000 names the supplier, and no supplier's NGN balance on 2000 goes into debit (advances go to 1300). Read under the tenant lock.
- The rates login can't set `fetched_at`.

## Known ceilings (ponytail comments in 0006)

- Accounts identified by chart code (1010, 1150, 2000, 7000): add an account role column when tenants get several.
- The invoice-reversal guard is per supplier and car, not per invoice.
- The 7000 line in a settlement can name any car: per-car realized FX could be mis-tagged (totals and job profit can't).

## Owner decisions raised

1. **Spec conflict, FX rule 5** (build-spec.md, Currency and FX): currency can now leave the pool only for one car or an invoice settlement. Selling leftover RMB back to naira, an RMB bank charge, or an RMB cost shared across cars (unless split per car) are refused. Each needs its own entry type and shape rule, or an ADR placing it outside phase 2.
2. **Top-up payments**: a direct pool payment after a car's invoice is fully settled is allowed and adds to car cost; the reverse order is refused. Allow both ways, or neither, with an ADR.
3. **Credit notes and discounts** on foreign invoices: a foreign invoice settles only from the pool, so these need an entry type (reversal plus a smaller invoice, or a supplier adjustment with evidence).
4. **Revaluation** posts to a separate account (1010 takes no NGN lines); ADR with the revaluation slice.
5. Still open from pass 3: evidence mandatory vs "evidence pending"; no endpoint writes `counterparty_id` before the counterparties table exists.

## Security notes, pre-existing (not from 0006)

- Any SQL session as `finbook_api` can take a tenant's ledger advisory lock at session level and freeze its postings until the connection recycles. Wrap the lock in one definer function, or `pg_advisory_unlock_all()` on pool release.
- No `lock_timeout` / `idle_in_transaction_session_timeout` / `statement_timeout`; 0006 takes the tenant lock on more lines.

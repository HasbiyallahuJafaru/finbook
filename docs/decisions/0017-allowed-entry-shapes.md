# 0017 — Allowed entry shapes: every posting rule is a named entry type the database checks

- Status: accepted (owner, 2026-11-17: "every posting rule becomes a named entry type with one shape"; landing charge per car, owner 2026-11-17)
- Date: 2026-11-17
- Implements: ADR 0016 → Consequences (allowed shapes; the completion endpoint blocker). Migration 0015.

## Context
Through 0014 the database judged free-form lines: it refused the shapes that had been found to break the books. Four ledger audits each found a new hand-crafted shape that got past those checks. A deny list can't be complete. Every entry the API will post comes from one rule in `packages/ledger`, so the database can instead allow only the shapes those rules produce.

The completion was the worst case: the database could not tell a right cut from a typed one, so every completion was flagged `completion_unverified`. Re-performing a car's cut needs that car's own landing charge, but the landing charge was stored once per job.

## Decision
**1. Each posting rule is an entry type** (`journal_entries.source_type`): `customer_receipt`, `customer_refund`, `receivable_receipt`, `currency_purchase`, `pool_payment`, `supplier_invoice`, `supplier_settlement`, `car_cost`, `supplier_credit`, `job_completion`, `stock_deposit`, `stock_deposit_refund`, `yard_arrival`, `stock_sale`, `stock_conversion`, `fx_revaluation`, and `manual_journal`. `packages/ledger` exports them as `EntryType`, and adds the three rules that had none (`customerRefund`, `receivableReceipt`, `supplierCredit`).

**2. The shapes are data**, in `entry_shapes`: one row per kind of line a type may hold. Each row gives the accounts, the side, NGN or foreign, the allowed rate sources, whether the line names a car, and who it names (nobody, a customer, or a supplier or agent, checked against the counterparty itself). It also gives how many such lines the entry may hold. `assert_entry_shape` runs first inside `post_journal_entry`. Every line must fit one slot, and every slot's count must be in range. An entry names one car (a `car_cost` may split over several) and one counterparty. An unknown type is refused. The table is owner-only: the app can't read or change it, and a change is a migration an auditor can read.

**3. A reversal keeps the type of the entry it reverses.** The mirror check already proves its lines.

**4. A manual journal names no car and keeps off the accounts the rules own**: 1010, 1019, 1100, 1150, 1200, 1210, 2009, 2100, 2150, 4000, 4100, 4200, 5000 and 7100, and foreign lines on 2000. An NGN supplier bill for a general expense (Dr expense / Cr 2000) is still a manual journal, because the books must take it.

**5. The database re-performs every completion** from the car's own quote and ledger, half-up to the kobo as in `packages/money`. Each car on a job order carries its own landing charge, and the cars' charges add up to the job's when the quote is accepted. Job costs cleared = the car's job costs. Car markup (4100) = the car's price at the quote rate minus its foreign cost at the quote rate. FX (7000) = that foreign cost at the quote rate minus what it cost in naira. Clearing margin (4200) = the car's landing charge minus its landed cost. The bill is paid first from funds held (2150), and the rest is owed (1100). Any other figure is refused, however it balances. A car's foreign cost counts only currencies that still net to something, so a payment in the wrong currency, reversed, doesn't block the car. `completion_unverified` is no longer raised. `cost_credited` now marks every `supplier_credit`, and a new flag, `negative_cut`, marks a completion whose car markup or clearing margin is below zero (CLAUDE.md: a negative cut posts and is flagged).

**5a. Receivables (1100)** never go below zero per car and customer, reversals included, and on a customer job they name the job's customer. 0008's conversion check reads a completion by type too, so a supplier credit no longer stops a car being converted (ledger audit of 0015).

**6. The ledger moves a job to `completed`** when its last car's completion posts, and back to `quote_accepted` when a completion is reversed. The app can't do it itself: `job_cars_completed` isn't executable by the app role.

**7. A sign-off takes the tenant's posting lock before it locks the job.** A posting now updates its job row under that lock, and the other order could deadlock. **The rule for every future endpoint:** take `pg_advisory_xact_lock(hashtextextended('ledger:' || tenant, 0))` before locking or updating a job row, or never lock job rows directly. An endpoint that locks the job first and then posts would hold the job while waiting for the ledger lock at commit, and deadlock against a sign-off (security review of 0015).

0014's line-pattern rules (funds held only by receipt, cut only in a completion, job costs down only in a completion, conversion or supplier credit, revenue naming its car) are now the shapes. `assert_job_entry` identifies completions and conversions by type rather than by line pattern. 0006–0008 stay as they were, as a second line behind the shapes.

## Consequences
- **Closed:** ADR 0016's completion blocker. Round 4's supplier credit note not tied to its car and supplier: the shape requires the Dr 2000 line to name both car and supplier. 0006 caps it at what is owed to that supplier across all their NGN bills, not per car: NGN 2000 credits can't name a car yet. Add a per-car cap when NGN car invoices arrive with `POST /costs`. The 10k phase-1 fuzz test now posts manual journals and currency purchases by type. A new job fuzz test walks 200 cars (customer-funded, clearing-only and EMM-funded) through receipts, refunds, receivable receipts, currency purchases, pool payments, supplier invoices and settlements, car costs, supplier credits, completions, deposits, arrivals and sales: about 3,000 postings. One in thirty is reversed straight away, completions included. Along the way it checks that tampered completions and mistyped entries are refused, each for its own reason. It doesn't post conversions or revaluations; their own tests do. At the end, each car's balances must equal the rules' figures to the kobo, the trial balance must net to zero and the hash chain must be intact.
- **Still not recordable, each needs its own entry type** (a gap in what can be recorded, not a judgement on the client):
  - ADR 0016's list (customer paying the China supplier directly; RMB receipts and refunds; a supplier's RMB refund into the pool; a credit note after completion);
  - **new:** paying a car's foreign payable straight in naira (Dr 2000 NGN naming car and supplier / Cr cash), which 0006 allowed as free lines;
  - a supplier credit on an EMM-funded car (1200);
  - an NGN supplier invoice for a car cost (Dr 1150 / Cr 2000 NGN). This waits for `POST /costs` and cost types;
  - a clearing-only completion with no job costs at all (the completion clears 1150, so there must be some), and a clearing job billed at NGN 0;
  - a foreign cost that isn't the car (freight paid from the pool, say). On a clearing-only job it is refused; on a car purchase it counts as the car's foreign cost, in its markup and FX. It needs a cost type with `POST /costs`.
- **Recordable, but split:**
  - one customer transfer covering two cars is two receipts, one per car (a receipt names one car);
  - a customer paying more than they owe after completion: a receivable receipt for what is owed, a customer receipt (2150) for the rest, then a refund;
  - correcting a completion that was already paid: reverse the payment first, then the completion (1100 never goes below zero). The payment is posted again as a new entry.
- **Flags on reversed entries stay** on `job_order_exceptions` until signed off (a flag never changes or disappears, ADR 0016). A reversed completion's `negative_cut` is answered by its sign-off; the corrected completion raises its own.
- **Rounding:** each car's price is converted at the quote rate on its own, half-up. If a quote shows the job's total in naira, the cars' figures can differ from it by up to half a kobo per car.
- **Cover still counts funds held only:** a customer settling a completion receivable (1100) isn't counted as cover for a later supplier payment, which is flagged conservatively anyway (`cost_after_completion` plus `supplier_cost_not_covered`).
- **Still open from the security review:** the app can take session-level advisory locks (pre-existing).
- **Lock timeouts:** every transaction waits at most 5 s for a lock and stays idle at most 30 s (`withTenant`); a write that times out returns 503 and retries safely with the same Idempotency-Key.
- **Bundle import** must restore `source_type` verbatim: a reversal is checked against the type of what it reverses.
- The posting endpoints set `source_type` from the rule they ran, never from the request.

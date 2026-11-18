# 0018: One posting endpoint; the books' dates, months and sources

- Status: accepted (owner, 2026-11-17: one route with a typed body; reversals by firm roles only; entries from go-live to today)
- Date: 2026-11-17
- Implements: ADR 0017 → Consequences (the posting endpoints). Migration 0016.

## Context
ADR 0017 made every posting rule a named entry type the database checks. The API now has to post them. Writing the first batch (customer money) raised four questions: what the request may carry, which months an entry may open, what an entry's `source_id` points to, and how a client's chart of accounts comes to exist. A security review and a ledger audit of the first batch shaped the answers.

## Decision
1. **`POST /postings`, one route with a typed body.** The body is a strict Zod discriminated union on `type`, with one schema per entry type, added batch by batch. Reversals will be `POST /postings/:entryId/reversal`, for firm roles only (firm admin, firm accountant). A correction is our accounting call.
2. **The request carries facts, never figures.** It holds the car, amount, date and evidence. The API reads everything else from the database: the car's job customer, its funding, its history, the pool and the payables. The rule in `packages/ledger` then builds the lines, and the API sets the entry type from the rule. The API never accepts lines, a customer or a type. Rule refusals are a typed `RuleError`, answered as a 422 in the rule's words. Any other error is a bug: it returns a 500 and goes to Sentry.
3. **The order inside the transaction:**
   1. the idempotency key;
   2. the tenant's ledger lock (ADR 0017 §7);
   3. the job and history reads;
   4. the rule;
   5. the month;
   6. the `postings` record and the entry;
   7. `SET CONSTRAINTS ALL IMMEDIATE`, so the commit-time checks and flags run before the answer. Running them early opens nothing: once the hash is written, no line can be added.
4. **Months open themselves.** A period is a calendar month, and the first entry dated in a month opens it. A month the firm set up differently is used as it is.
5. **The database sets which dates an entry may take** (owner): from the client's `go_live_on` to today, Lagos time. A client without a go-live date takes no postings. No month can open before go-live, or behind a locked month (that would be a gap month nobody closed). A month-end revaluation is exempt from the upper bound, because its automatic reversal is dated the 1st of the next month and 0007 pins that date. Earlier history comes in through the phase-5 opening-balance import, dated at go-live.
6. **Every entry's source is its posting.** `postings` keeps the type and the facts as they were asked for, append-only, with the creator and time stamped by the database. `journal_entries.source_id` points at that row. The hash covers `source_id`, so it must point at something that lasts; the idempotency answer expires after 7 days. Receipt and voucher numbers get their own numbered records in phase 3.
7. **Evidence is checked.** A line's evidence must be one of the tenant's own documents, with status stored (foreign key plus an insert-time trigger). A line's car and counterparty must also be the tenant's own (foreign keys). A pending upload, a missing document and another tenant's document all get the same answer.
8. **Each client's chart** is seeded by `seed_default_chart(tenant)` at onboarding. It holds the spec's default chart plus the accounts the rules use (1150, 2150, 4100, 4200, 1019, 2009). It refuses a system code that already exists with another type. Only the owner runs it until the phase-3 onboarding endpoint.

## Consequences
- **Evidence (owner, 2026-11-17; migration 0017):**
  - A **foreign-currency line needs its document**, as CLAUDE.md says: the rate is provable only from it. The contract requires it on every FX posting, and a database CHECK refuses a new foreign line without it (older lines are left as they were, `NOT VALID`).
  - Anything else without evidence posts, and shows on `entries_missing_evidence` until a document is attached with `POST /postings/:entryId/evidence`. Attaching adds one row to `entry_evidence`; the entry never changes. The spec says a month can't lock while this list has entries; that waits for the phase-4 lock. Exempt: completions (the accepted quote is their evidence), arrivals in the yard, revaluations (their own evidence table) and reversals. Still to confirm with the owner: whether a conversion with no cash leg, and manual journals, belong on the list.
  - **A document may back several standing entries** (this replaces "one document per entry", which the ledger audit showed would block real cases: one transfer paying for two cars posts as two entries, and a corrected entry needs its reversed original's slip). Each such file is listed on `evidence_shared`, with the entries it backs, for a firm reviewer; the same bytes uploaded twice count as one file. A reversed entry stands no more, so a correction shares nothing. The reviewer's confirmation (a sign-off) comes with the exception-report endpoints.
  - Four eyes also covers evidence attached later: a reviewer who attached or uploaded evidence for a car's entries doesn't sign off its flags.
- **Still open (ledger audit of 0017):** `evidence_shared` needs each entry's amount and date and a reviewer sign-off (with the exception-report endpoints). The reversal endpoint must carry the original's document, so a foreign entry posted before 0017 without one can still be corrected. A pool payment names no supplier (0015 shape): give its pool line the supplier, as a settlement's has.
- **FX batch:** currency purchase, pool payment, supplier invoice and settlement. The pool and each payable are read from the ledger; funding comes from the job. A supplier must be one of the tenant's suppliers or agents. A pool payment beyond what the pool holds is a rule refusal (422).
- **Batch 3 (2026-11-18): supplier credit, completion, reversal.**
  - A completion carries only the car and the date. The quote (each car's price and landing charge, the job's locked rate) comes from the job order; the rule works out the cut, and the database re-performs it.
  - `POST /postings/:entryId/reversal`, for firm accountants and admins, posts the exact mirror with the original's type. Each line keeps its original's evidence. A document in the request backs only lines whose original had none, which lets a foreign entry from before 0017 be corrected. Its `postings` row records which entry it reverses.
  - **Car cost moves to `POST /costs`:** every cash-paid car cost carries a cost type (owner default), and cost types arrive with that slice.
  - **Migration 0018:** the pool never holds less than nothing. Reversing a currency purchase after its currency was paid out took 1010 below zero, which would be currency spent with no source. After each entry touching 1010, every currency it touched must hold zero or more, at a cost of zero or more, and an empty pool must cost exactly zero.
  - **Migration 0018, reversals in the database** (security review and ledger audit of batch 3). These hold for every writer, not just the API:
    - posted by a firm accountant or admin of the business (`firm_access`), as a sign-off's role is checked; a revaluation's automatic reversal is exempt;
    - dated on or after the entry it reverses;
    - a currency purchase can't be reversed while a later payment from the pool in that currency stands, because those payments were costed at an average that included it: reverse them first;
    - a reversal that puts job costs back on a completed car posts, and is flagged `cost_after_completion`.
  - A reversal's document backs only foreign lines without one; a document that would back nothing is a 422.
  - **Still open:** the other per-car balance checks (2150, 1150, 1100, inventory) are all-time, not as of the entry date, so a backdated ordinary entry can still make an earlier day's balance read below zero. That needs an as-of check, or a rule that entries post in date order within a car; ask the accountant. Not tested: a supplier credit against a payable (Dr 2000), and the reversal's document filling a pre-0017 foreign line (the API can't create one). Before migrating staging to 0018, check that no 1010 currency is already below zero (staging has no postings today).
- **Batch 4 (2026-11-18): stock.** Covers deposit, deposit refund, arrival in the yard, sale and conversion to stock.
  - **Who the buyer is.** A stock car's buyer may be someone other than the job's customer (ADR 0012), so deposits, deposit refunds and sales name a `buyerId`, which must be one of the business's customers. This is the one place a request names a counterparty, because the buyer is a fact of the sale event. The rules still apply only that buyer's own deposits.
  - **What comes from the ledger.** Arrival and conversion carry only the car and the date. Their cost and the customer's funds held come from the ledger.
  - **Sale evidence.** The sale invoice backs the revenue line (4000).
  - **Who pays a balance owed.** `receivable_receipt` now names whoever owes for the car, read from its 1100 lines: after a stock sale that is the buyer, otherwise the job's customer. If two parties owe for one car at once, the receipt is refused until the request can name the payer. The ledger audit found no path that reaches this today, and it has no test.
  - **Deposits over the price (ledger audit, superseding ADR 0012's refusal).** A sale applies the buyer's deposits up to the price. The rest stays on 2100 as theirs until refunded. Refusing the sale would have blocked a real transaction, or forced the refund to be misdated before it.
  - **A conversion's document** backs its inventory line (1200), which every conversion has, so the document is kept even when no customer funds were held.
  - **Still open:** no flag yet for a deposit left on 2100 after its car is sold (overpaid, or another buyer's), or for a deposit taken after a sale. The books are right, since the liability stands, but nothing prompts a reviewer to see the refund through. These come with the exception-report endpoints (a new flag kind and a migration).
- **Next batch (FX):** a stock sale's receivable can be owed by a buyer other than the job's customer. When stock postings join, `receivable_receipt` must take the counterparty from the car's open balance.
- A customer receipt after the car's completion posts and is flagged `funds_after_completion`: it most likely pays the balance owed (1100).
- Our check messages reach the caller as 422s. They name only this tenant's figures today. A future definer `RAISE` that formats unfiltered data would leak it, so review every new `RAISE` with that in mind (security review of 0016).
- `finbook_app` can confirm a document as stored itself (0013), so "stored" proves the documents endpoint checked the file, not the worker.

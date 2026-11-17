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
- **Open for the owner:** whether a posting without evidence is flagged "evidence pending" (spec: posts and is flagged, and the month can't lock while such flags remain), and whether one document may back several entries.
- **Next batch (FX):** a stock sale's receivable can be owed by a buyer other than the job's customer. When stock postings join, `receivable_receipt` must take the counterparty from the car's open balance.
- A customer receipt after the car's completion posts and is flagged `funds_after_completion`: it most likely pays the balance owed (1100).
- Our check messages reach the caller as 422s. They name only this tenant's figures today. A future definer `RAISE` that formats unfiltered data would leak it, so review every new `RAISE` with that in mind (security review of 0016).
- `finbook_app` can confirm a document as stored itself (0013), so "stored" proves the documents endpoint checked the file, not the worker.

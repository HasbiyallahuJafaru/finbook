# 0006 — Ledger guarantees live in Postgres

- Status: accepted (revised the same day after the ledger-auditor and security-reviewer passes)
- Date: 2026-11-15
- Migrations: `packages/db/migrations/0001_ledger_guarantees.sql`, `0002_currencies_and_line_links.sql`, `0003_ledger_guarantees_v2.sql`

## Decision
The ledger rules are enforced by the database, so no code path (the API, a future Flutter client's API calls, or a bug) can break them.

**Roles**
- `finbook_api` is the API's login: not a superuser, not the owner, `NOINHERIT`, no privileges of its own. Its only power is `SET ROLE finbook_app`.
- `finbook_app` holds the app privileges, all under forced RLS. `withTenant()` (in `packages/db`) runs every unit of work as one transaction with `SET LOCAL ROLE finbook_app`, `app.tenant_id` and `app.user_id`. Any escape (`RESET ROLE`, an early `COMMIT`, a nested transaction) lands on `finbook_api`, which can read nothing. Nested drizzle transactions throw, and a COMMIT that Postgres turned into a rollback is reported as a failure.
- The owner login (`DATABASE_OWNER_URL`) is used only by migrations and admin jobs such as creating tenants and, later, importing backup bundles. The API never has it.
- Column-level grants: the app can't choose ids, timestamps, `created_by`, the audit actor or `is_system`, and can only rename accounts.

**Ledger**
1. *Balance at commit.* A deferred constraint trigger refuses an entry with fewer than 2 lines or with debits ≠ credits in kobo. A second deferred trigger on `journal_lines` refuses any line that isn't covered by its entry's hash, which closes the race where a line joins an entry another transaction is committing.
2. *Append-only.* Entries, lines, hashes and the audit log refuse UPDATE, DELETE and TRUNCATE, even from the owner. Lines can't be added once an entry is posted.
3. *Reversals.* A reversal must point at a posted entry of the same tenant, mirror its lines exactly (debit and credit swapped), and each entry can be reversed once.
4. *Periods.* An entry must fall inside an unlocked period (`FOR SHARE`, so a concurrent lock waits). Periods never overlap, their dates never change, and a locked period can't change or be deleted. Reopening is a later, firm-admin-only feature.
5. *Accounts.* Once an account has posted lines, its code, type and currency are fixed, even for the owner.
6. *FX lines.* Every currency must exist in `currencies` (only exponent-2 currencies for now, ADR 0003). A foreign line needs a rate, a rate source (manual needs a non-blank note), its account's currency, and NGN equal to `round(amount_minor × rate)` (half-up, the same as `packages/money`). NULLs count as failures, because a CHECK that evaluates to NULL passes.
7. *Who and when.* `journal_entries.created_by/created_at` and `audit_log.actor/at` are stamped from `app.user_id` and `now()` on the app path; a write without `app.user_id` is refused. The owner path keeps supplied values so restored history stays exact.
8. *Audit.* Inserts and updates of accounts and periods, and every posted entry, write an `audit_log` row in the same transaction.
9. *No existence oracle.* Insert-time checks run as the caller (`SECURITY INVOKER`), so another tenant's ids behave exactly like random ids. Only the commit-time posting triggers run as definer, after RLS has already checked the row. Every function pins `search_path`; `CREATE` on `public` and `TEMP` are revoked from PUBLIC.

**Hash chain**
- At commit, each posted entry gets a row in `journal_entry_hashes`: `sha256(prev_hash || payload)`, numbered per tenant under an advisory lock.
- *Hash format.* The payload is Postgres's `jsonb::text` rendering of an object holding the entry's fields (id, tenant_id, period_id, entry_date, memo, source_type, source_id, reverses_entry_id, idempotency_key, created_by) and its lines ordered by id (id, account_id, debit_ngn, credit_ngn, currency, amount_minor, rate, rate_source, rate_note). Version 2 adds evidence_document_id, vehicle_id and counterparty_id to each line, and `payload_version` to the entry. Keys appear sorted by length and then bytewise (jsonb's rule); bigints and rates are strings; dates are ISO `YYYY-MM-DD`; `prev_hash` is lowercase hex, and the first entry uses the empty string. A version's field list never changes; new fields mean a new version, and each hash row records the version it was made with.
- `ledger_chain_breaks(tenant)` re-computes the chain and lists every break: changed content, a wrong or missing predecessor, a hash row whose entry is gone, or an entry with no hash row. It refuses to run for a tenant other than the caller's.

## Why
- The spec says the invariants are "enforced in the database, not only in code".
- Railway's default Postgres user is a superuser, and superusers bypass RLS even when it's forced. The first version of this design ran the API as that user and dropped to `finbook_app` per transaction; both reviews showed that one injected statement or one nested transaction got back to superuser. A separate non-superuser login removes that path.
- Hashing in SQL at commit gives one canonical format, covers the lines, and needs no UPDATE of posted rows.

## Limits (be honest with auditors)
- The chain proves history wasn't changed **by anyone below the database owner**. A database superuser can delete the newest entries together with their hash rows, or rewrite the whole chain consistently, and an in-database check can't see that. The defence is an off-site anchor: the tenant's head (seq + hash) recorded outside Postgres, in the daily backup bundle manifest and the monthly integrity check (spec → Daily backup and import), and compared on every verification. Until that ships, tamper evidence against the owner is incomplete.
- Commits of one tenant's entries are serialized for the moment it takes to append the hash. Fine at our scale; revisit if a single tenant's posting rate becomes a bottleneck.
- Postgres stores `NUMERIC(18,6)`, so a rate with more decimals is silently rounded. The API contracts must reject more than 6 decimal places (`packages/money` `parseRate` already does).
- The checks assume READ COMMITTED. Under stricter isolation the hash trigger may read a stale chain head; it then fails on the unique `(tenant_id, seq)` and the entry is refused, never mis-chained.

## Not in phase 1
- `firm_access` and `memberships` (resolved in the API when Clerk auth lands).
- Gapless document numbers (job orders, invoices, receipts, vouchers: phase 2).
- The chart-of-accounts seed (onboarding, phase 3) and period reopen (phase 4).
- Foreign keys from `journal_lines.evidence_document_id`, `vehicle_id` and `counterparty_id`, added when those tables exist (phase 2).
- `journal_entries` has no draft status on purpose: drafts (such as manual journals awaiting review) live in their own tables and only become journal entries when approved and posted.
- The backup bundle `schema_version` (when the bundle format exists).

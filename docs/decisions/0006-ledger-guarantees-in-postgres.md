# 0006 — Ledger guarantees live in Postgres

- Status: accepted
- Date: 2026-11-15

## Decision
The ledger rules are enforced by the database (`packages/db/migrations/0001_ledger_guarantees.sql`), so no code path, including a future Flutter API client or a bug in the API, can break them:

1. **Balance at commit.** A deferred constraint trigger on `journal_entries` refuses an entry with fewer than 2 lines or with debits ≠ credits in NGN kobo.
2. **Append-only.** `journal_entries`, `journal_lines`, `journal_entry_hashes` and `audit_log` refuse UPDATE, DELETE and TRUNCATE (trigger, which also stops the owner), and the app role has no UPDATE/DELETE grant. Lines cannot be added once their entry is posted.
3. **Periods.** An entry must fall inside its period and the period must not be locked (checked with `FOR SHARE`, so a concurrent lock waits). Periods of a tenant never overlap. A locked period cannot change; reopening is a later, firm-admin-only feature.
4. **FX lines.** Every foreign line has a rate, a rate source (manual needs a note), and its NGN amount must equal `round(amount_minor × rate)` (half-up, same as `packages/money`). NULLs count as failures (`coalesce(…, false)`), because a CHECK that evaluates to NULL passes.
5. **Tenancy.** Every tenant table has RLS enabled and forced. The API connects as the owner but runs `SET LOCAL ROLE finbook_app` plus `set_config('app.tenant_id', …, true)` in every transaction (`withTenant` in `packages/db`). No tenant set = no rows. Composite foreign keys `(tenant_id, id)` stop a line, period, account or reversal from pointing at another tenant's row.
6. **Hash chain.** At commit, the posting trigger appends a row to `journal_entry_hashes`: `sha256(prev_hash || canonical JSON of the entry and its lines)`, numbered per tenant under an advisory lock. `ledger_chain_breaks(tenant)` re-computes the chain and lists every break.

## Why
- The spec says the invariants are "enforced in the database, not only in code".
- Railway's Postgres user is a superuser, and superusers bypass RLS even when it's forced. Switching to a non-superuser role per transaction keeps one connection string and still puts every app query under RLS.
- The hash is computed in SQL at commit, not in TypeScript: one canonical format, no risk of the app and the verifier disagreeing, and it covers the lines (which don't exist yet when the entry row is inserted). It's stored in its own append-only table so posted entries never need an UPDATE. The payload lists its fields explicitly, so adding a column later never changes an old entry's hash.

## Consequences
- Commits of one tenant's entries are serialized for the moment it takes to append the hash. Fine at our scale (20–100 tenants); revisit only if a single tenant's posting rate becomes a bottleneck.
- The migration runner must be the owner/superuser. Admin work that crosses tenants (creating tenants) runs as the owner, outside `withTenant`.
- Not in phase 1: `firm_access` (resolved in the API when auth lands), gapless document numbers (job orders and invoices, phase 2), period reopen (phase 4), backup bundle `schema_version` (when the bundle format exists).

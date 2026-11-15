---
name: db-migration
description: Use for any database schema change in packages/db - new table, column, index, constraint, trigger, RLS policy, sequence or seed. Migrations are forward-only and must keep the ledger guarantees.
---

# Database migration

1. **Never edit a committed migration.** The protect-files hook blocks it. Create a new one: `pnpm db:new <verb_noun>`, for example `add_job_order_funding`.
2. **Read first:** run `graphify query "<table>"` to see who reads or writes the table, and check the spec's Data model section.
3. **Every tenant-owned table** gets:
   - a `tenant_id uuid not null` FK
   - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`
   - a policy `USING (tenant_id = current_setting('app.tenant_id')::uuid)` plus the matching `WITH CHECK`
   - an index that starts with `tenant_id`
4. **Types:**
   - money: `BIGINT` minor units plus `currency char(3)`
   - rates: `NUMERIC(18,6)`
   - dates: `date`; timestamps: `timestamptz`
   - IDs: UUIDv7
   - never `real`, `double precision`, `float` or `money` (money-guard flags them)
5. **Ledger tables** (`journal_entries`, `journal_lines`, posted documents):
   - no UPDATE/DELETE grants to the app role
   - keep the deferred balance trigger and the period-lock trigger working
   - add a test that proves an unbalanced entry and an insert into a locked period both fail
6. **Gapless numbers** come from a per-tenant counter row locked with `SELECT … FOR UPDATE` inside the same transaction. Never use sequences (they leave gaps on rollback) and never `MAX()+1`.
7. **Expand, then contract:** add the new column or table, backfill, switch reads, and only later drop the old one in a separate migration. Nothing destructive in the same release as the code change.
8. **Test:** run the migration against a fresh Testcontainers Postgres, run the RLS cross-tenant test, and run the integration suite.
9. **Backup format:** if the change adds or renames a table or column, bump the bundle `schema_version`, add the forward step to the bundle importer, and add a fixture bundle test. Old bundles must still import.
10. Run the `verify` skill. Run the `security-reviewer` subagent if RLS, grants or roles changed.

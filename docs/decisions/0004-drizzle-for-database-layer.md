# 0004 — Drizzle for the database layer

- Status: accepted
- Date: 2026-11-15

## Decision
`packages/db` uses Drizzle ORM and drizzle-kit. Triggers (balance check, period lock, hash chain), RLS policies, deferred constraints and gapless sequences are written as plain SQL in forward-only migrations.

## Why
Most of the ledger's guarantees live in Postgres, not in app code. Drizzle stays close to SQL, so those guarantees are written directly instead of worked around, and `SET LOCAL app.tenant_id` sits naturally inside a Drizzle transaction. Prisma would need raw SQL for the same pieces plus more care around per-transaction session settings.

## Closes
Spec → Open decisions: "Prisma or Drizzle". The spec is exported from the Claude Doc, so tick it there.

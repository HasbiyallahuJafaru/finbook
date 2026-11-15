---
name: verify
description: Run before every commit and whenever a task is finished. Lints, typechecks, tests and builds the affected packages, checks the ledger invariants, and reports pass/fail with fixes. Use when the user says verify, check, are we green, or before committing.
---

# Verify

Run every step. Do not skip a step because it "probably passes". Stop at the first red step, fix it, then start again from step 1.

## 1. Work out what changed

```bash
git status --short
git diff --name-only HEAD
```

Map the changed files to workspace packages. Use `graphify query "what depends on <package>"` to find dependents, and verify those too.

## 2. Static checks (affected packages and their dependents)

```bash
pnpm turbo run lint typecheck --filter=...[HEAD]
```

## 3. Tests

```bash
pnpm turbo run test --filter=...[HEAD]
pnpm test:integration          # only if api, worker, db or ledger changed (needs Docker)
```

If `packages/money` or `packages/ledger` changed, branch coverage must stay at 100%:

```bash
pnpm --filter @app/money test -- --coverage
pnpm --filter @app/ledger test -- --coverage
```

## 4. Ledger invariants (if ledger, money, db, posting or reports changed)

- The fuzz test (10k random entries → trial balance nets to zero) passes.
- The EMM's Shop worked-example fixture passes to the kobo.
- No migration edits an existing migration. No table without `tenant_id` + an RLS policy (unless it's a global table listed in the spec, such as `fx_reference_rates`).

## 5. Build

```bash
pnpm turbo run build --filter=...[HEAD]
```

For `apps/web`, also run the Cloudflare preview build script so Workers-only breakage shows up before deploy.

## 6. Endpoint checks (if apps/api changed)

For each new or changed endpoint: call it in an integration test, confirm the cross-tenant test returns nothing, confirm an `audit_log` row is written for writes, and regenerate OpenAPI with `pnpm openapi`. Make sure the generated client diff is committed.

## 7. Report

Reply with a short table: step · result · what was fixed. List any bug fixed along the way. If something can't pass without weakening a rule in CLAUDE.md, stop and escalate. Never weaken the rule.

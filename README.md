# FinBook

Multi-tenant bookkeeping for vehicle importers. Our consultancy runs it for 20–100 client businesses. The first client, EMM's Shop, buys cars in China in RMB, clears them at Apapa in shared containers and sells them in naira.

Every balance comes from a double-entry ledger, every car is costed by VIN, and an auditor must be able to trace and re-perform every number down to the receipt behind it.

## Status

| Phase | State |
| --- | --- |
| 0 Foundations | Done apart from items waiting on account access (see `docs/deploy.md` → Open items) |
| 1 Ledger core | Gate test passes locally; in review |
| 2–6 | Not started |

The live state, next steps and open decisions are in [`docs/PROGRESS.md`](docs/PROGRESS.md). Read it before you start work.

## Repo layout

pnpm workspaces + Turborepo.

```
apps/
  api/        NestJS API (Railway): auth, tenancy, validation, ledger writes
  worker/     NestJS + BullMQ (Railway): PDFs, email, FX snapshots, backups
  web/        Next.js on Cloudflare Workers via vinext: UI only, calls the API
packages/
  money/      bigint money and FX maths (no dependencies, 100% branch coverage)
  db/         Drizzle schema, forward-only SQL migrations, RLS and ledger triggers
docs/
  spec/       build spec and client findings (source of truth, exported from the Claude Doc)
  decisions/  ADRs, one per non-obvious choice
  PROGRESS.md where the build is
  deploy.md   infrastructure and deploy runbook
```

Still to come, per the spec: `packages/contracts` (shared Zod schemas), `packages/ledger` (posting rules), `packages/reports`, `packages/ui`.

## Getting started

You need **Node 24+**, **pnpm 12** (the version is pinned in `package.json`) and **Docker** (for the database tests).

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test                 # unit tests
pnpm test:integration     # Postgres 18 in Testcontainers; needs Docker running
pnpm build
```

Run an app locally:

```
pnpm --filter @app/api build && pnpm --filter @app/api start        # http://localhost:3000/health
REDIS_URL=redis://localhost:6379 pnpm --filter @app/worker build && pnpm --filter @app/worker start
pnpm --filter @app/web dev                                          # http://localhost:3001
```

The worker needs a Redis (`docker run -p 6379:6379 redis:8-alpine`). The web dev server may ask you to approve the `workerd` install script first: `pnpm approve-builds workerd`.

Database:

```
pnpm db:generate          # new migration from changes to packages/db/src/schema.ts
pnpm db:new <verb_noun>   # empty SQL migration for triggers, policies, grants
pnpm db:migrate           # apply migrations to DATABASE_URL (local or staging only)
```

## Environment variables

Secrets live only in Railway and Cloudflare. Never commit a `.env` file.

| Variable | Used by | Notes |
| --- | --- | --- |
| `PORT` | api | Railway sets it; defaults to 3000 |
| `REDIS_URL` | worker (api later) | required by the worker |
| `DATABASE_URL` | db migrations (api from phase 1) | |
| `SENTRY_DSN` | api, worker | Sentry is off when unset |
| `SENTRY_ENVIRONMENT` | api, worker | `staging` or `production` |

## Rules that make the numbers trustworthy

The full list is in [`CLAUDE.md`](CLAUDE.md) under "Non-negotiable rules". The short version:

- Money is `bigint` minor units with a currency code. Never `number`, `parseFloat`, `toFixed` or `Math.round`; lint fails the build on them. FX rates are 6-decimal strings.
- Postgres enforces the ledger: entries must balance at commit, posted rows can't be changed or deleted (corrections are reversals), locked periods refuse entries, and each posted entry is hash-chained per tenant. See [ADR 0006](docs/decisions/0006-ledger-guarantees-in-postgres.md).
- Every tenant table has row-level security. App code reaches tenant data only through `withTenant()` in `packages/db`.
- Business rules live in the API, never only in the web app, because a Flutter client will use the same API.
- Migrations are forward-only. Never edit one that's committed.

## Deploys

Staging runs on Railway (api, worker, Postgres, Redis) and Cloudflare Workers (web). Production is deployed by the owner only. Both are covered in [`docs/deploy.md`](docs/deploy.md).

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit and integration tests, and build on every push to `main` and every pull request.

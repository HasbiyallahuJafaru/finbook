# Progress and handover

Read this first in every new session. Update it before you stop: current phase, what was done, what's next, open questions. Keep it short; history lives in git, decisions in `docs/decisions/`.

_Last updated: 2026-11-15_

## Current phase

**Phase 2 — Vehicles + FX** (in progress). Gate: a worked example (3 cars, 1 shared container, 3 different rates, 1 sale) matches the accountant's spreadsheet to the kobo.

- Done (slice 1; ledger-auditor: pass with notes, every finding fixed with a test): `packages/money` pool/rate/weighted-allocation maths; `packages/ledger` posting rules for the customer-funded flow (receipt, buy currency, pay supplier from the pool, shared/per-car costs, agent-job and clearing-job completion); migration 0004 (`pool_average` rate source); the hand-worked example passes in `packages/ledger` and posts cleanly through Postgres. The DB re-computes every pool payment under the tenant lock (no forged cost, no overspend, no race); completion derives costs and funds held from the car's ledger history; receipts and receivables name car and customer. Also reconciled against the real C4 container from EMM's workbook (scratchpad only, not committed): landed costs tie to the cashbook to the kobo. ADR 0008 (pool derived from the ledger, no `fx_pools` table) needs the owner's OK.
- **Gate blocker:** the accountant must re-perform the worked example (comment block at the top of `packages/ledger/src/index.test.ts`) and sign it off.
- Still open from the audit (needs the vehicle/job tables): refuse cost postings to a completed job; record the allocation basis per split (`cost_allocations`).
- Next slices: realized FX on payables, month-end revaluation (7100, auto-reverse), emm_funded (principal) path with approval, then the tables and API endpoints (vehicles with VIN check, job orders with gapless numbers and accepted-quote evidence, shipments, cost types) — the API endpoints need Clerk auth first (phase 0 item still open).

**Phase 1 — Ledger core: done** (2026-11-15). Gate evidence: the local pre-push run (ADR 0007) — 31 integration tests incl. 10k entries netting to zero and zero-row cross-tenant reads; migrations applied to staging.

**Phase 0** is done except owner-blocked items: web staging deploy (Cloudflare login), Railway↔GitHub, Sentry DSNs (see `docs/deploy.md` → Open items). Clerk auth is not wired yet.

## Done

- Repo docs in place: `CLAUDE.md`, spec, client review, ADR 0001 (agent accounting per job), ADR 0002 (FX actual vs quote rate).
- Claude tooling: hooks (`.claude/hooks`), skills (db-migration, ledger-change, new-endpoint, phase-gate, verify), agents (ledger-auditor, security-reviewer).
- Build approach set in `CLAUDE.md`: Ponytail for backend; `design-taste-frontend`, `frontend-design`, `ui-ux-pro-max` for frontend.
- Graphify graph built (`graphify-out/`, 151 nodes, 11 communities). It covers code and docs, not the build itself. It does not replace this file: it maps what exists, this file says where we are and what's next.
- First commit `ea9373f` on main; remote `origin` = github.com/HasbiyallahuJafaru/finbook. Push pending (user runs `git push -u origin main`; no network in Claude session). `pnpm-workspace.yaml` and root `package.json` in place.
- `packages/money` written and green: parseRate, convert (half-up), allocateEqual (remainder on first car), add/sub; 10k-conversion property test; 100% branch coverage. Uses node:test + Node 24 TypeScript stripping, zero dependencies (`pnpm --filter @app/money test`). Not yet wired to the toolchain below.
- Turborepo + TypeScript + shared tsconfig; strict type-aware ESLint (`eslint.config.mjs`) bans parseFloat, Number(), Math.round/floor/ceil/trunc, toFixed and non-null assertions (tests exempt from the Number/promise rules). `pnpm lint`, `pnpm typecheck`, `pnpm test` all green for @app/money.
- CI: `.github/workflows/ci.yml` (frozen install, lint, typecheck, test, build on push to main and PRs; pnpm/setup pinned by SHA, checkout v7). Not yet run on GitHub: it needs the push.
- `apps/api`: NestJS 12 (ESM, nodenext, decorators via tsc) with a public `GET /health`; test compiles with tsc then runs on node:test (Vitest can't emit decorator metadata). No auth, tenancy, DB or Sentry yet. `node apps/api/dist/main.js` listens on `PORT` (default 3000), 0.0.0.0.
- `apps/worker`: NestJS standalone + BullMQ (`@nestjs/bullmq`), one `system` queue with a `ping` job, requires `REDIS_URL`. Unit tests green; the real-Redis round-trip test is skipped locally (Docker wasn't running) and runs in CI against a `redis:8-alpine` service. `msgpackr-extract` build script explicitly denied in `pnpm-workspace.yaml` (optional native accelerator).
- `apps/web`: Next.js 16 + React 19 App Router running on Cloudflare Workers through vinext (Cloudflare's recommended path; `vinext check` = 100% compatible; OpenNext fallback not needed). One placeholder page. `dev` = `vite dev` on :3001, `build` = `vite build` (output `.cloudflare/output`). Init choices: no CDN cache, no KV data cache, no image optimization (add later if needed). `workerd` install script denied in `pnpm-workspace.yaml`: build works without it, but local `vite dev`/`preview` may need it approved (`pnpm approve-builds workerd`). Not deployed yet (needs the Cloudflare account). No Clerk, Tailwind, shadcn or design system yet.
- Sentry in `apps/api` and `apps/worker` (`@sentry/nestjs` 11.12): `src/instrument.ts` loaded by `node --import ./dist/instrument.js` (ESM), DSN/environment from `SENTRY_DSN` / `SENTRY_ENVIRONMENT` (no DSN = disabled). API has `SentryModule` + `SentryGlobalFilter`; BullMQ processor errors are auto-captured by the SDK. Unverified against a real Sentry project (needs a DSN). Known: Nest logs a harmless-looking warning that `SentryGlobalFilter` has no decorator metadata at index [0]; unhandled errors still return 500 (tested). Revisit if error responses misbehave.
- **Staging is live on Railway** (project `finbook`, env `staging`): Postgres, Redis, api (https://api-staging-c68d0388.up.railway.app/health → ok), worker (connected to Redis). Details and open items in `docs/deploy.md`. Policy: Claude does staging infra; production is user-run only (CLAUDE.md, settings.json deny rules).
- Web staging Worker `finbook-web-staging` not deployed: Cloudflare login expired (user must run `pnpm --filter @app/web exec cf login`). Dry run passes.
- `packages/db` (phase 1): Drizzle schema (`src/schema.ts`) + migrations `0000_init` (tables) and `0001_ledger_guarantees` (hand-written: RLS, `finbook_app` role, append-only triggers, period lock, deferred balance check, hash chain, `ledger_chain_breaks()`). `withTenant(apiPool, {tenantId, userId}, fn)` is the only way app code touches tenant data; the API logs in as `finbook_api` (non-superuser), migrations use the owner URL. 31 integration tests incl. the 10k fuzz gate and one per review finding. Open limit: chain tampering by a DB superuser needs an off-site anchor (backup manifest, phase 5). ADR 0006 explains the design. Not yet: `firm_access`, gapless numbers, period reopen, backup bundle versioning, packages/ledger posting rules (phase 2).
- ADRs 0003 (scaled-bigint rates), 0004 (Drizzle), 0005 (TypeScript pinned to ~6.0.3 because typescript-eslint doesn't support 7 yet) written.

## Next

1. Phase 0 remainder: deploy web staging after the user logs in to Cloudflare; owner browser steps in `docs/deploy.md` → Open items (Railway↔GitHub, healthcheck path, GitHub billing, Sentry DSNs); Sentry in web (blocked: Sentry's Cloudflare Vite plugin needs a wrangler config, but vinext uses `cloudflare.config.ts`; options: `instrumentation.ts` hook supported by vinext, or a wrangler config. Needs a docs-backed decision); tenant id + request id tags on Sentry events once auth/request-ids exist (phase 1); Cloudflare + Railway deploys (need user accounts and env vars); confirm CI green after the first push; verify `vite dev` works locally (may need workerd approved).
2. Then phase 1 prerequisites: Clerk JWT guard and tenancy in the api, `packages/db` (Drizzle), contracts, OpenAPI. Money keeps node:test (decided).
2. `packages/money` still lacks: weighted-average pool maths (phase 2), currency exponent handling beyond 2-decimal currencies.
3. Confirm CI is green on GitHub after the first push (including the worker's Redis test, never run locally); add the Testcontainers integration step when `packages/db` lands.
4. Deploy targets (need accounts/env vars from the user): Clerk, Sentry, Cloudflare (vinext compatibility check, OpenNext fallback), Railway (api, worker, Postgres, Redis).

## Open decisions / blockers

- Network note: `pnpm add` and `pnpm view` work in the Claude session; `npm view` and curl hang. Use pnpm for registry lookups.
- Push to GitHub still pending (user runs `git push -u origin main`).

- Decided 2026-11-15: Drizzle (ADR 0004); FX rates as scaled bigint, no decimal lib (ADR 0003). Tick "Prisma or Drizzle" in the Claude Doc spec and re-export.
- Spec line "Build standard" still names hasbiy-ui / impeccable / uiuxpromax / awesome-design.md; CLAUDE.md now names design-taste-frontend / frontend-design / ui-ux-pro-max. Spec is exported from the Claude Doc — update it there and re-export.
- Live FX rate provider, pricing model, statutory FX treatment for clients (spec → Open decisions).
- Accountant sign-offs: tax accounts, IAS 21 pool-vs-spot, retention term.

## Session notes

- (append one line per session: date, what changed, anything the next session must know)

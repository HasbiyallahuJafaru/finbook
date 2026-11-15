# Vehicle Bookkeeping Platform

Multi-tenant bookkeeping for vehicle importers (first client: EMM's Shop — cars bought in China in RMB, cleared at Apapa in shared containers, sold in NGN). Our consultancy runs it for 20–100 client businesses. Auditors must be able to trace and re-perform every number.

**Spec (source of truth):** `docs/spec/build-spec.md` · **Client findings:** `docs/spec/emms-ledger-review.md` · **Decisions:** `docs/decisions/` (ADRs, one per non-obvious choice).
If code and spec disagree, stop and ask. Never "fix" the spec silently.

**Handover:** `docs/PROGRESS.md` says where the build is. Read it at the start of every session (after the graph check). Update it before you stop, and whenever a phase step finishes: current phase, done, next, open decisions, one session-note line.

## Graphify — navigate by graph, not by grep

Graphify must be installed: `uv tool install graphifyy` (or `pipx install graphifyy`), then `graphify install` and, once per clone, `graphify claude install` and `graphify hook install` (see `scripts/setup-claude.sh`).

1. **Session start:** the SessionStart hook prints the graph's status. If it says there's no graph, run `/graphify .` before doing anything else.
2. **Before any codebase question or your first source read:** run `graphify query "<question>"` (add `--budget 800` for wide questions). Use `graphify path "A" "B"` to see how two things connect and `graphify explain "X"` for one concept. Read `graphify-out/GRAPH_REPORT.md` only for a broad architecture review or when query/path/explain don't surface enough.
3. **Grep/Glob/raw reads only after the graph:** use them for exact strings (an error message, an env var name) or lines the graph already located. Never use them to discover structure. Put this rule in every subagent prompt that explores code.
4. **After editing code:** the Stop hook runs `graphify update .` (local tree-sitter, no LLM, cached). After editing docs in `docs/`, run `/graphify . --update` yourself.
5. **Privacy:** graphify sends doc/image contents to the Claude API; code stays local. Real client files (workbooks, receipts, exports) must never be in the repo — `.graphifyignore` and `.gitignore` block `fixtures/private/`, `*.xlsx` and `bundles/`.

## Non-negotiable rules

Break any of these and the work is wrong, however good it looks.

**Money**
- Amounts are `bigint` minor units (kobo, fen, cents) paired with an ISO currency code. Never `number`, `parseFloat`, `toFixed`, or `Math.round` on money. All money maths goes through `packages/money`.
- Rates are decimal strings (`NUMERIC(18,6)` in Postgres) handled as bigint scaled by 10^6 in `packages/money` (ADR 0003, no decimal library). Rounding: half-up to the minor unit per line; any remainder becomes an explicit rounding line.
- Shared costs are allocated in minor units with the remainder on the first car, so allocations always add up exactly to the amount paid.

**Ledger**
- Every balance, profit and report figure comes from `journal_lines`. Nothing else stores a balance.
- Users record business events (job order, supplier payment, clearing cost, customer receipt, completion); `packages/ledger` turns them into balanced lines. Debits = credits in NGN, enforced by a deferred DB trigger.
- Posted entries are immutable. Corrections are reversals plus new entries (`reverses_entry_id`). No UPDATE/DELETE on posted rows, ever.
- Locked periods refuse inserts. Every entry has `source_type`, `source_id`, `created_by` and an idempotency key. Each entry stores a hash chained to the previous entry for its tenant.

**EMM's Shop business model** (see spec → Vehicle module)
- Job types: `car_purchase` and `clearing_only`. Funding is set per job: `customer_funded` (default, agent accounting: revenue = EMM's cut) or `emm_funded` (rare exception, principal accounting: the car is inventory, needs a reason plus reviewer approval).
- A supplier payment on a job with no customer receipt is blocked until the job is approved as `emm_funded`.
- The cut is never typed in: it is the accepted quote minus actual cost, split into car markup (4100) and clearing margin (4200). No posting to a job without an accepted quote document.
- The RMB selling price is converted at the quote-day rate locked on the job order. The gap against the rate actually paid posts to FX (7000), never into margin.

**FX**
- NGN is the functional currency. Every foreign line stores `currency`, `amount_minor`, `rate`, `rate_source` and its evidence document. The live rate only pre-fills a form; the user confirms or replaces it. Never hardcode a rate, in code, seeds or tests (tests use fixture rates that are clearly labelled as fixtures).
- Foreign cash is a weighted-average pool per currency. Month-end revaluation of monetary items goes to 7100 and auto-reverses.

**Tenancy and security**
- Every tenant-owned table has `tenant_id` plus an RLS policy. The API sets `SET LOCAL app.tenant_id` inside every transaction. Firm staff reach tenants only through `firm_access`.
- Roles and permissions live in one map in code (`apps/api/src/auth/permissions.ts`). Every endpoint has a guard. No endpoint without a test proving a cross-tenant request gets nothing.
- Secrets only in env vars. Never read, print or commit `.env*` files.

**Evidence and audit**
- Documents go to private R2 via presigned URLs (10-minute upload, 5-minute download). Never through the API, never public. Evidence is never replaced or deleted; superseding attaches a new file.
- Every write goes to `audit_log` with before/after. Gapless numbers for job orders, invoices, receipts and payment vouchers come from a locked per-tenant sequence, never `MAX()+1`.
- Dates are ISO `date` columns from a date picker; display is DD/MM/YYYY. Never parse user-typed date strings.
- VINs: 17 characters, no I/O/Q, check digit validated, unique per tenant. Invalid VINs import only with status `vin_needs_correction`.

## Build approach: Ponytail (backend)

Every backend coding task runs under the `ponytail` skill at **full** intensity: `apps/api`, `apps/worker`, `packages/money`, `packages/ledger`, `packages/contracts`, `packages/db`, the queries in `packages/reports`, migrations, scripts and their tests. Frontend work (`apps/web`, `packages/ui`, React PDF templates) follows the frontend skills under How to work instead. Load it at the start of any coding session. Lazy here means the least code that is still correct. It never means less correctness.

**Precedence:** Non-negotiable rules > spec > Definition of done > Ponytail. Ponytail decides *how little* to write. It never decides *whether* a rule applies. If the lazy path would weaken a rule, it isn't the lazy path: stop and ask.

**The ladder in this stack** (stop at the first rung that holds):
1. Not in the spec's current phase? Don't build it, and say so in one line.
2. Already in the repo? Reuse it (find it with `graphify query` first). Money maths lives in `packages/money`, posting in `packages/ledger`, schemas in `packages/contracts`. Never write a second copy.
3. Can Postgres do it? Prefer constraints, CHECKs, unique indexes, RLS, triggers, sequences and generated columns over app code.
4. Can the framework or platform do it? NestJS guards, pipes and interceptors, Zod, BullMQ retries, Clerk Organizations, R2 presigned URLs.
5. Is an installed dependency enough? Use it. A new dependency needs a stated reason (plus an ADR if it's structural) and a registry check for the latest stable version.
6. Only then: the minimum code that works.

**Where Ponytail never cuts:**
- Anything under Non-negotiable rules: bigint money, balanced lines, immutability and reversals, the hash chain, idempotency keys, RLS plus `SET LOCAL`, guards, `audit_log`, gapless sequences, evidence retention, VIN validation, FX evidence.
- Tests. Ponytail's "one small check" is the floor here, not the ceiling. The Definition of done wins: worked-example tests to the kobo, 100% branch coverage on `packages/money` and `packages/ledger`, a cross-tenant test for every endpoint, and the trial-balance fuzz test.
- Validation at trust boundaries (every API input goes through Zod), and error handling that prevents data loss.
- The package layout under Architecture. Don't merge packages to save files. Inside a package, though: no interface with one implementation, no repository that only wraps the ORM, no service/manager/helper layering, and no config for values that never change.

**Habits:**
- Read the spec section and trace the flow end to end before you climb the ladder.
- Write the shortest correct diff. Prefer deleting to adding, and use as few files as possible.
- Mark a corner cut with a known ceiling with a `ponytail:` comment that names the ceiling and the upgrade path, e.g. `// ponytail: one BullMQ queue, split per job type if PDFs starve email`. Never cut a corner on money, the ledger, tenancy or evidence.
- In replies, put the code first, then at most three lines: what was skipped and when to add it.

## Architecture

```
apps/web       Next.js (App Router) on Cloudflare Workers — UI only, calls the API, no DB access, no business logic in Server Actions
apps/api       NestJS on Railway — auth, tenancy, validation, ledger writes
apps/worker    NestJS standalone + BullMQ on Railway — PDFs, Resend email, FX snapshots, backups, exception reports
packages/money      bigint money + scaled-bigint FX maths (no runtime deps; 100% branch coverage)
packages/ledger     posting rules: events → balanced journal lines (100% branch coverage)
packages/contracts  Zod schemas shared by web and api; OpenAPI generated from them
packages/db         Drizzle schema (ADR 0004), forward-only SQL migrations, RLS policies, triggers, seed chart of accounts
packages/reports    report queries + React PDF templates
packages/ui         design tokens (also exported as JSON for the future Flutter app) + shared components
```

Data stores: Postgres + Redis on Railway; R2 buckets `evidence`, `reports`, `staging` (separate per environment). Auth: Clerk (Organizations = tenants). Errors: Sentry in web, api and worker, tagged with tenant id and request id.

The Flutter app (phase 6) will be another API client, so every rule must live in the API, never only in the web app.

## Commands

```
pnpm install
pnpm dev                     # all apps
pnpm lint | pnpm typecheck | pnpm test | pnpm build
pnpm test:integration        # Testcontainers Postgres — needs Docker
pnpm db:migrate              # local only
pnpm db:new <name>           # new forward-only migration
pnpm openapi                 # regenerate spec + typed web client
pnpm --filter <pkg> <script> # scope to one package
```

**Infrastructure and deploys (owner-authorized 2026-11-15, staging only):** Claude may create and deploy Railway, Cloudflare, Postgres and Redis resources for the **staging** environment. **Production is never touched from a Claude session**: no deploys, variables, migrations, seeds or SQL against it. The user runs production from `docs/deploy.md`. Rules:
- Work only in the `staging` Railway environment and the `finbook-web-staging` Worker. If a command could target production (no environment flag, or the linked environment isn't staging), check first with `railway status`.
- Never print, log or commit secret values. Set variables with `railway variable set`; never read them back (`railway variables`, `--json`, `--kv` and `railway run` are denied).
- Migrations run on staging only, and forward-only. No seeds or manual SQL with real client data.
- Every infra change is recorded in `docs/deploy.md` (what exists, how to recreate it) and `docs/PROGRESS.md`.
- Stop and ask before anything that spends money beyond the base plan, deletes a resource, or changes a domain or DNS.

## How to work

- **Docs first:** before writing any integration code (Clerk, Resend, R2, Railway, Cloudflare, BullMQ, Sentry, Drizzle), fetch the official docs. Never rely on remembered syntax or auth flows.
- **Latest versions:** check the registry for the latest stable version before adding or referencing any package or model. Never pin a version from memory.
- **Ledger or FX change:** use the `ledger-change` skill. Write the worked-example test first, to the kobo.
- **New endpoint:** use the `new-endpoint` skill. **Schema change:** use the `db-migration` skill.
- **Before every commit:** the `verify` skill runs. Do not commit with red checks.
- **Review:** after changes to `packages/ledger`, `packages/money`, posting, reports or permissions, run the `ledger-auditor` subagent. After auth, RLS or document access changes, run the `security-reviewer` subagent.
- **Frontend:** use the `design-taste-frontend`, `frontend-design` and `ui-ux-pro-max` skills with shadcn/ui. Ponytail does not apply to `apps/web` or `packages/ui`. Tabular figures, right-aligned amounts, ₦ and ¥ always shown, negatives in parentheses on reports, every total clickable down to its journal lines. WCAG AA, down to 360 px.
- **Backend:** use the `ponytail` skill (see Build approach).
- **Phases:** work in the spec's phase order. A phase is done only when its gate in `docs/spec/build-spec.md` passes (use the `phase-gate` skill).
- Fix obvious bugs you find and report them. Stop and escalate architectural problems (anything that weakens a rule above) instead of working around them.

## Definition of done

- lint, typecheck, unit and integration tests and build all pass for the affected packages
- every new endpoint has: Zod contract, guard, tenant test, idempotency where it writes, audit log entry, OpenAPI updated
- ledger/money/report changes: worked-example test to the kobo, trial balance still nets to zero in the fuzz test
- Sentry captures errors with tenant id and request id
- graph refreshed (the Stop hook does this) and any new decision recorded in `docs/decisions/`

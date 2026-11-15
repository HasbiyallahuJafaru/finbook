# Progress and handover

Read this first in every new session. Update it before you stop: current phase, what's built, what's next, open questions. Keep it a snapshot of now, not a diary; history lives in git, decisions in `docs/decisions/`.

_Last updated: 2026-11-15_

## Start here (next session)

1. **Re-run the ledger-auditor** on slice 2 (spot rates + realized FX: `packages/ledger`, `packages/db/migrations/0005_spot_rates.sql`, `apps/worker/src/rates.ts`). Two passes failed and were fixed; the third pass was still running when the session ended, so its result is unknown. Migration 0005 is committed, so any fix goes in a new migration (0006).
2. **Staging is behind:** apply 0005 and switch on the rate snapshot:
   - generate a password and pipe it in: `railway variable set -e staging -s migrate --skip-deploys --stdin FINBOOK_RATES_DB_PASSWORD`, then `railway up -s migrate -e staging --detach` (logs end with "migrations applied");
   - on the worker: `RATES_DATABASE_URL=postgresql://finbook_rates:${{migrate.FINBOOK_RATES_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`, then `railway up -s worker -e staging --detach`;
   - the first snapshot runs at the next 10:30 Lagos; check `fx_reference_rates` has cbn and market rows.
3. **Owner question still open:** build a clickable design prototype with sample data (no backend) to see the UI now, or carry on with the backend (month-end revaluation next)? The real web app is still a placeholder page.

## Where we are

| Phase | State |
| --- | --- |
| 0 Foundations | Done, except owner-blocked items (below) and Clerk auth, which isn't wired yet |
| 1 Ledger core | **Done.** Gate evidence: local pre-push run (ADR 0007): 10k random entries net to zero, cross-tenant reads return zero rows |
| 2 Vehicles + FX | **In progress.** Gate approved by the owner (2026-11-15, provisional: the accountant still reviews it and fixes come back here). Slice 1 built; slices 2–5 to build |
| 3–6 | Not started |

## Phase 2: now and next

Gate: a worked example (3 cars, 1 shared container, 3 different rates, 1 sale) matches the accountant's spreadsheet to the kobo. **Owner-approved 2026-11-15, provisionally**; the accountant's review is still to come, and any fix it finds is reopened here. ADR 0008 accepted; ADR 0009: clients see the spot basis.

Research behind the next slices: `docs/research/2026-11-15-existing-platforms.md` (Odoo, ERPNext, IAS 21, IFRS 15, TigerBeetle).

**Built (slice 1):**
- `packages/money`: weighted-average pool (`poolSpend`, empties to exactly zero), `divHalfUp`, `rateOf`, `formatRate`, `allocateEqual`, `allocateByWeight`.
- `packages/ledger`: posting rules for the customer-funded (agent) flow: customer receipt, buy currency into the pool, pay supplier from the pool, shared and per-car costs, agent-job and clearing-job completion. Completion derives costs and funds held from the car's own ledger history; receipts and receivables name the car and customer.
- Migration 0004: `pool_average` rate source; the DB re-computes every pool payment under the tenant lock (no forged cost, no overspend, no race); reversals mirror rate source, car and customer. Applied to staging.
- The hand-worked example is in the comment block at the top of `packages/ledger/src/index.test.ts`; it passes in the ledger tests and through Postgres.
- Reconciled against EMM's real container C4 (scratchpad only, never committed): landed costs tie to the cashbook to the kobo; the Song Plus markup is ₦2,018,200.00 (the workbook's ₦2,139,292 forgets the RMB 600 extra), and its ₦1,000,000.01 clearing margin comes from the unevidenced ₦1m CPH fee.

**Built (slice 2: spot rates + realized FX; two ledger-auditor passes):**
- Supplier invoices booked as foreign payables (2000) at the invoice rate, with the invoice-day spot rate, one payable per supplier and car. Paying them from the pool settles at the payable's weighted-average booked cost (read from the ledger, like the pool), so part payments end at exactly zero and overpaying is refused; the gap against the pool's cost is realized FX (7000) on that car.
- The DB enforces by account, not by label: currency leaves 1010 only at pool cost, a foreign payable is paid down only at booked cost, an invoiced car can't also be paid straight from the pool, and an invoice can't be reversed while payments stand against it.
- Spot rate + source (`cbn` / `manual` with a note) on every pool payment and supplier invoice; `spotCarCost` gives the client-facing spot basis (ADR 0009). Car cost is net of reversals.
- Migration 0005: `fx_reference_rates` (CBN + market, revisions, append-only), `spot_rate`/`spot_source` (check added NOT VALID so older rows can't block it), DB checks for cbn spot rates and payable settlements (under the tenant lock), `finbook_rates` login, hash payload v3.
- Worker: daily CBN + market snapshot at 10:30 Lagos (ADR 0010), exact decimal parsing (`roundRate`).
- Known gaps: no mixed v2/v3 hash-chain test across the upgrade; the 10k fuzz test doesn't include pool, payable or spot lines; `counterparty_id` isn't typed (customer vs supplier) until the counterparties table lands (slice 3). Evidence stays optional on purpose: the spec lets entries post as "evidence pending" and flags them on the exception report.

**Next slices, in order (build from the top):**
1. **Month-end revaluation** (research: Odoo). Foreign cash, receivables and payables restated at the closing reference rate; difference to 7100; auto-reversing entry on day 1 of the next period. Not on account 1010 (keep the pool cost clean): use a separate revaluation account.
2. **`emm_funded` (principal) path.** Inventory 1200/1210, gross sale 4000/5000, reason + reviewer approval before any supplier payment, convert-to-stock for abandoned jobs.
3. **Tables + endpoints.** Vehicles (VIN check digit, unique per tenant, `vin_needs_correction`), job orders (gapless numbers, accepted-quote evidence, funding field), shipments/containers, cost types, `cost_allocations` storing the split basis (borrowed from ERPNext's landed cost voucher), refuse costs on a completed job. Needs Clerk auth first (phase 0 item).
4. **Reports take a basis** (`spot` | `pool`); client-facing ones default to and only accept `spot` (ADR 0009).

## Waiting on the owner

- **Accountant review** of the phase 2 worked example (owner approved it provisionally; fixes come back here), and confirmation that customer funds are a liability until completion.
- **Spec export**: tick "Prisma or Drizzle" (decided: Drizzle) and update the frontend skills line in the Claude Doc, then re-export (`docs/spec/` is not hand-edited).
- **Browser steps** (`docs/deploy.md` → Open items): Cloudflare login (web staging deploy), Railway↔GitHub (auto-deploy), Railway healthcheck path, Sentry DSNs. GitHub Actions is billing-locked; the local pre-push gate replaces it (ADR 0007).
- **Accountant sign-offs from the spec**: tax accounts, IAS 21 pool-vs-spot treatment, retention term.
- The client workbook `EMM'S SHOP LEDGER.xlsx` sits in the repo root (git- and graphify-ignored). Move it out of the project folder.

## What exists

- **Apps:** `apps/api` (NestJS 12, `GET /health`, Sentry), `apps/worker` (NestJS + BullMQ, `system` queue with a `ping` job, Sentry), `apps/web` (Next.js 16 on Cloudflare Workers via vinext, placeholder page). No auth or business endpoints yet.
- **Packages:** `money`, `ledger`, `db` (Drizzle schema; migrations 0000–0004; `withTenant()`; `migrate()`).
- **Database guarantees** (ADR 0006): API logs in as `finbook_api` (non-superuser) and runs as `finbook_app` under forced RLS; owner URL only for migrations. Balance at commit, append-only ledger and audit log, period lock, reversals mirror exactly, accounts frozen once posted to, FX checks, DB-stamped actor and time, audit rows, per-tenant hash chain with `ledger_chain_breaks()`. Known limit: chain tampering by a DB superuser needs an off-site anchor (backup manifest, phase 5).
- **Tests:** money 9 and ledger 5 (100% branch coverage), api 2, worker 3 (1 needs Redis), db integration 35 (Testcontainers Postgres 18, needs Docker).
- **Quality gate:** `.githooks/pre-push` runs install, lint, typecheck, unit, integration and build before every push (ADR 0007). Strict type-aware ESLint bans float money (`parseFloat`, `Number()`, `Math.round` and friends, `toFixed`).
- **Staging (Railway project `finbook`, env `staging`):** Postgres 18, Redis, api (https://api-staging-c68d0388.up.railway.app/health), worker, and a one-off `migrate` service. Production environment exists, empty, owner-run only. Details: `docs/deploy.md`.
- **Decisions:** ADRs 0001–0010 in `docs/decisions/`. Research notes in `docs/research/`.

## Gotchas for the next session

- `npm view` and curl hang in the Claude session; use `pnpm view` for registry lookups and the web fetch tool for docs.
- The installed Railway CLI (5.41.2) ignores `railway environment edit --service-config`; build and start commands are set as `RAILPACK_*` variables.
- Turborepo can restore stale `dist/` from cache; if a test runs twice, delete the app's `dist/` and run with `--force`.
- TypeScript is pinned to `~6.0.3` until typescript-eslint supports 7 (ADR 0005).
- Install scripts are denied by default in `pnpm-workspace.yaml` (`allowBuilds`); approve one only if something breaks without it.
- Claude cannot read `fixtures/private/` (deny rule). Real client data never goes into committed code.

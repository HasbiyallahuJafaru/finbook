# Progress and handover

Read this first in every new session. Update it before you stop: current phase, what's built, what's next, open questions. Keep it a snapshot of now, not a diary; history lives in git, decisions in `docs/decisions/`.

_Last updated: 2026-11-17 (session: job orders in the ledger, record-then-flag, sign-offs)_

**We are the clients' bookkeepers, never part of their business** (CLAUDE.md → Who we are). The books record what the client did; the database refuses only what would make them wrong or untraceable, and flags policy questions for a firm reviewer.

## Start here (next session)

1. **Where the code is:** branch `phase2-revaluation` (**not merged to `main`**; ask the owner before merging or pushing). New since `69860c7`: the ledger side of job orders (migration 0014, ADR 0016).
   - Every car an entry names must be on a job order, and funding decides the side (1150 vs 1200).
   - Customer funds held (2150) come in only as a cash receipt from the job's customer, and leave only in a completion, a refund or a conversion.
   - The cut posts only in a completion that clears 1150 and needs the accepted quote. Revenue always names its car.
   - Each car on a car purchase has its own quoted price.
   - The database raises flags (`job_order_flags`) as each entry commits: EMM-funded, converted to stock, posted before the quote, supplier paid beyond the customer's funds, cost after completion. A flag never changes or disappears; a firm reviewer or admin who touched nothing it is about signs it off (`POST /job-orders/:id/sign-offs`). `job_order_exceptions` is the open worklist.
   - Reviews: four ledger audits (all FAIL) and four security reviews (all PASS WITH NOTES). Every finding is fixed, or recorded in ADR 0016 → Consequences as closed by the next slice (owner, 2026-11-17).

   **Next: allowed shapes** (owner, 2026-11-17, ADR 0016 → Consequences). Every posting rule becomes a named entry type with one shape the database checks. Manual journals can't touch the job accounts. The 10k fuzz test covers job postings. It is built with the posting endpoints. **Then** shipments/containers, cost types and `cost_allocations`, with `POST /costs`. Owner defaults (memory, ADR 0016):
   - split by value at pool cost;
   - evidence may be pending unless the cost type requires a receipt;
   - containers close for good;
   - every cash-paid car cost carries a cost type.

   The firm-admin endpoint for `firm_access` waits for phase 3; until then the owner adds `firm_staff`/`firm_access` rows on staging.
2. **Staging is on 0000–0008**; 0009–0014 are not applied yet (apply with the next api deploy). The API needs `CLERK_JWT_KEY`, `CLERK_ISSUER`, `CLERK_AUTHORIZED_PARTIES`, `CLERK_WEBHOOK_SIGNING_SECRET` and `WEBHOOK_DATABASE_URL` (plus `FINBOOK_HOOK_DB_PASSWORD` on migrate), and R2 buckets + the `R2_*` variables for documents (owner: create the Clerk application, the three custom org roles and the webhook endpoint, ADR 0013 → Consequences; until then guarded routes and the webhook answer 503). **FX snapshot check still open:** the worker logged nothing for the 2026-11-16 10:30 run (it logged no job outcomes at all, and Sentry has no DSN); psql isn't installed here to read `fx_reference_rates`. The worker now logs each job's outcome: after the next deploy, read `railway logs --service worker`.
3. **Owner rulings:**
   - (a) 2026-11-15: an abandoned job's customer funds are always refunded, never forfeited. Enforced in 0014: 2150 never leaves as income.
   - (b) 2026-11-17, superseding the 2026-11-15 "approval first" ruling: **record, then flag.** A conversion to stock, an EMM-funded job and a supplier payment the customer's funds don't cover all post. Each shows on `job_order_exceptions` until a firm reviewer or admin signs it off, or the customer pays.
   - (c) 2026-11-17: funding never changes after the job is created, and each car has its own quoted price.

   **Spec lines to update in the Claude Doc:** listed in ADR 0016 → Consequences.
4. **Open, for the accountant: cost of sales basis for EMM-funded stock cars.** The books carry a stock car at pool cost (the naira the pool actually spent), so 5000 Cost of vehicles sold is pool basis. Client reports show the spot basis (ADR 0009: each foreign cost at the CBN spot rate on its own day), so a stock car's gross profit in client reports would be price minus spot cost, and differ from the books by the gap between pool and spot. Options: (i) keep the books at pool and show spot cost of sales in client reports with a reconciling line (current design); (ii) book stock cars at spot and post the gap to 7000 when the pool pays (IAS 21 style, changes the posting rules); (iii) show both. The accountant decides; the stored data supports all three.
5. **Owner decisions open** (details in the pass 4–6 audit doc): (a) **spec conflict, FX rule 5**: 0006 lets currency leave the pool only for one car or an invoice settlement, so selling leftover RMB, RMB bank charges and car-less RMB costs are refused until each gets an entry type, or an ADR scopes them out; (b) top-up payment after a settled invoice: allow both ways or neither; (c) credit notes/discounts on foreign invoices; (d) evidence mandatory vs "evidence pending". And: build a clickable design prototype with sample data (no backend) to see the UI now, or carry on with the backend (tables + endpoints next, which needs Clerk)? The real web app is still a placeholder page.

## Where we are

| Phase | State |
| --- | --- |
| 0 Foundations | Done, except owner-blocked items (below). Clerk auth built (guard, permission map, `GET /me`); needs the Clerk app's keys on staging and the membership webhook |
| 1 Ledger core | **Done.** Gate evidence: local pre-push run (ADR 0007): 10k random entries net to zero, cross-tenant reads return zero rows |
| 2 Vehicles + FX | **In progress.** Gate approved by the owner (2026-11-15, provisional: the accountant still reviews it and fixes come back here). Ledger slices built (customer-funded flow, spot rates + realized FX, revaluation, EMM-funded), vehicles, job orders, evidence documents, and job orders in the ledger with flags and sign-offs (0014). Allowed entry shapes with the posting endpoints, then costs/containers and the report basis, to build |
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
- Migration 0006 (audit passes 4–6): 1010 takes no NGN lines; foreign payables only from supplier invoices naming supplier and car; a car is paid directly or invoiced, not both (race-safe, lock before read); reversals can't be reversed; at commit, a settlement holds only 2000/1010/7000 with settled = spent, a car's cost reaches its 1150, and NGN on 2000 names the supplier and never exceeds what's owed (advances go to 1300); the rates login can't set `fetched_at`.
- Migration 0007 (month-end revaluation, ADR 0011): pool and foreign payables restated at the latest CBN rate (at most 7 days old) to 7100 through 1019/2009, reversed on day 1 in the same transaction, evidence in `fx_revaluations`, re-performed by the database. The whole-entry checks (0006, 0007) now run inside `post_journal_entry` (as separate deferred triggers they could be fired early and dodged), EXECUTE revoked from PUBLIC. Foreign lines on the balance sheet only on 1010 and 2000.
- **Phase 4 gate item (ledger audit of 0007):** the period lock must refuse unless the period's latest revaluation equals a fresh re-computation, shipped before or with the first endpoint that locks a period (`finbook_app` can already UPDATE `periods.status`). Until then a posting backdated after a revaluation leaves it stale.
- Migration 0008 (EMM-funded, ADR 0012): `funding` on the cost rules (emm_funded → 1200), `stockDeposit`, `refundStockDeposit`, `arriveInYard`, `sellStockCar` (gross 4000, full cost to 5000), `convertToStock` (cost to 1200, customer refunded in full). The database reads each car's mode (job or stock) from its live entries: never both, convert is the only crossing (open job, supplier-paid car, whole cost, whole refund in cash), balances never cross zero, inventory only from real costs, moves only whole.
- **Job orders in the ledger: built** (0014, ADR 0016). Still open:
  - **Completion endpoint blocker:** re-perform each car's cut from its own quote, and move the job to `completed`. A typed cut up to the funds held still posts.
  - **`POST /costs` blocker:** every cash-paid car cost carries a cost type. A car bought for naira cash isn't seen as a supplier cost.
  - **Before the first correction:** cancelling a job and putting its car on a new one.
- **Endpoints slice:** Postgres check messages carry the tenant's own balances; map them before showing them to roles without report access or sending them to Sentry.
- Security follow-ups (pre-existing, low): a session-level advisory lock can freeze a tenant's postings; no lock/idle/statement timeouts on `finbook_api`.
- **Before any `R2_*` variable is set (documents slice review, 2026-11-16):** evidence bucket lock in place and tested (overwrite and delete refused), staging lifecycle rule (24 h) and CORS, and a check that R2 refuses a PUT whose length differs from the signed one. R2 tokens can't separate write from delete, so the lock is the protection (ADR 0015). Owner to confirm ADR 0015's deviation (the upload check runs in the API, not the worker).
- **Gate items from the vehicles-slice security review (2026-11-16):** a worker job deleting `idempotency_keys` older than 7 days (stored answers hold phones and TINs) before real client data; check whether Sentry events carry pg error `detail` or request bodies (VINs, TINs) before Sentry DSNs are set; confirm Railway's edge appends `X-Forwarded-For` (trust proxy 1).
- Endpoints slice: VIN rule built in `packages/contracts` (`vinProblem`, `vinStatus`, `VinInput`; ISO 3779 check digit, 100% branch coverage), and in the database (`vin_status_of`, 0011): `vehicles.vin_status` is generated, so a client can't mark a bad VIN good; a test runs both checks on 2,000 VINs.
- Endpoints slice: index `journal_lines (tenant_id, vehicle_id, account_id)` added (migration 0010, partial on `vehicle_id IS NOT NULL`).
- Known gaps: no mixed v2/v3 hash-chain test across the upgrade; the 10k fuzz test doesn't include pool, payable or spot lines; `counterparty_id` isn't typed (customer vs supplier) until the counterparties table lands (slice 3). Evidence stays optional on purpose: the spec lets entries post as "evidence pending" and flags them on the exception report.

**Next slices, in order (build from the top):**
1. **Allowed entry shapes + posting endpoints** (owner, 2026-11-17; ADR 0016 → Consequences):
   - every posting rule becomes a named entry type with one database-checked shape;
   - manual journals can't touch the job accounts;
   - the fuzz test covers job postings;
   - this closes the open round-4 findings and the completion re-performance blocker;
   - it adds the rules that can't be recorded yet (customer paying the supplier directly, RMB receipts and refunds).
2. **Shipments/containers, cost types, `cost_allocations` and `POST /costs`.** Split basis stored (borrowed from ERPNext's landed cost voucher). Owner defaults:
   - split by value at pool cost;
   - evidence may be pending unless the cost type requires a receipt;
   - containers close for good;
   - every cash-paid car cost carries a cost type, and the car price is never one.

   Vehicles, job orders and their ledger rules are built (0011–0014).
3. **Reports take a basis** (`spot` | `pool`); client-facing ones default to and only accept `spot` (ADR 0009).

## Waiting on the owner

- **Accountant review** of the phase 2 worked example (owner approved it provisionally; fixes come back here), and confirmation that customer funds are a liability until completion.
- **Spec export**: tick "Prisma or Drizzle" (decided: Drizzle) and update the frontend skills line in the Claude Doc, then re-export (`docs/spec/` is not hand-edited).
- **Browser steps** (`docs/deploy.md` → Open items): Cloudflare login (web staging deploy), Railway↔GitHub (auto-deploy), Railway healthcheck path, Sentry DSNs. GitHub Actions is billing-locked; the local pre-push gate replaces it (ADR 0007).
- **Accountant sign-offs from the spec**: tax accounts, IAS 21 pool-vs-spot treatment, retention term.
- The client workbook `EMM'S SHOP LEDGER.xlsx` sits in the repo root (git- and graphify-ignored). Move it out of the project folder.

## What exists

- **Apps:** `apps/api` (NestJS 12, `GET /health` public, `POST /webhooks/clerk` (Svix-signed), `GET /me`, `POST/GET /counterparties`, `POST/GET /vehicles`, `GET /vehicles/:id`, documents (presigned upload, confirm, download), job orders and their sign-offs behind the global Clerk guard and the Redis rate limiter, Sentry tagged with tenant and request id), `apps/worker` (NestJS + BullMQ, `system` queue with a `ping` job, Sentry), `apps/web` (Next.js 16 on Cloudflare Workers via vinext, placeholder page). No auth or business endpoints yet.
- **Packages:** `money`, `ledger`, `db` (Drizzle schema; migrations 0000–0014; `withTenant()`, `resolveAccess()`; `migrate()`), `contracts` (Zod, VIN rule; `pnpm openapi` writes `packages/contracts/openapi.json`).
- **Database guarantees** (ADR 0006): API logs in as `finbook_api` (non-superuser) and runs as `finbook_app` under forced RLS; owner URL only for migrations. Balance at commit, append-only ledger and audit log, period lock, reversals mirror exactly, accounts frozen once posted to, FX checks, DB-stamped actor and time, audit rows, per-tenant hash chain with `ledger_chain_breaks()`. Known limit: chain tampering by a DB superuser needs an off-site anchor (backup manifest, phase 5).
- **Tests:** money 10 and ledger 17 (100% branch coverage), api 2 unit + 36 integration (job-order sign-offs, documents via S3Mock, job orders, vehicles, counterparties, idempotency per tenant and user, races, 429, viewer 403, auth, template tokens refused, cross-tenant 404, suspended tenant, MFA, default deny, signed webhook, ordering, firm staff never mirrored), worker 7 (1 needs Redis), db integration 87 (Testcontainers Postgres 18, needs Docker).
- **Quality gate:** `.githooks/pre-push` runs install, lint, typecheck, unit, integration and build before every push (ADR 0007). Strict type-aware ESLint bans float money (`parseFloat`, `Number()`, `Math.round` and friends, `toFixed`).
- **Staging (Railway project `finbook`, env `staging`):** Postgres 18, Redis, api (https://api-staging-c68d0388.up.railway.app/health), worker, and a one-off `migrate` service. Production environment exists, empty, owner-run only. Details: `docs/deploy.md`.
- **Decisions:** ADRs 0001–0016 in `docs/decisions/`. Research notes in `docs/research/`.

## Gotchas for the next session

- Test tokens need the header `cat: 'cl_B7d4PD111AAA'` (Clerk's session-token category); `@clerk/backend` refuses tokens without it. API integration tests are `src/*.integration.ts` (not `.test.ts`, so the unit run skips them).

- `npm view` and curl hang in the Claude session; use `pnpm view` for registry lookups and the web fetch tool for docs.
- The installed Railway CLI (5.41.2) ignores `railway environment edit --service-config`; build and start commands are set as `RAILPACK_*` variables.
- Turborepo can restore stale `dist/` from cache; if a test runs twice, delete the app's `dist/` and run with `--force`.
- TypeScript is pinned to `~6.0.3` until typescript-eslint supports 7 (ADR 0005).
- Install scripts are denied by default in `pnpm-workspace.yaml` (`allowBuilds`); approve one only if something breaks without it.
- Claude cannot read `fixtures/private/` (deny rule). Real client data never goes into committed code.

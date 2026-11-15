# Progress and handover

Read this first in every new session. Update it before you stop: current phase, what was done, what's next, open questions. Keep it short; history lives in git, decisions in `docs/decisions/`.

_Last updated: 2026-11-15_

## Current phase

**Phase 0 — Foundations** (in progress: money package done, everything needing installs or deploys not started). Gate: both sides deployed from main; `money` property tests pass (10k random conversions, no float drift). See `docs/spec/build-spec.md` → Build phases.

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
- ADRs 0003 (scaled-bigint rates), 0004 (Drizzle), 0005 (TypeScript pinned to ~6.0.3 because typescript-eslint doesn't support 7 yet) written.

## Next

1. Phase 0 remainder: Sentry in web (blocked: Sentry's Cloudflare Vite plugin needs a wrangler config, but vinext uses `cloudflare.config.ts`; options: `instrumentation.ts` hook supported by vinext, or a wrangler config. Needs a docs-backed decision); tenant id + request id tags on Sentry events once auth/request-ids exist (phase 1); Cloudflare + Railway deploys (need user accounts and env vars); confirm CI green after the first push; verify `vite dev` works locally (may need workerd approved).
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

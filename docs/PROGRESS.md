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
- `git init` done (branch main, no commits yet). `pnpm-workspace.yaml` and root `package.json` in place.
- `packages/money` written and green: parseRate, convert (half-up), allocateEqual (remainder on first car), add/sub; 10k-conversion property test; 100% branch coverage. Uses node:test + Node 24 TypeScript stripping, zero dependencies (`pnpm --filter @app/money test`). Not yet wired to the toolchain below.
- ADRs 0003 (scaled-bigint rates) and 0004 (Drizzle) written.

## Next

1. Needs internet (blocked this session): check latest versions, add Turborepo, TypeScript, ESLint; create apps/web, apps/api, apps/worker skeletons. Decide whether money keeps node:test or moves to Vitest.
2. `packages/money` still lacks: weighted-average pool maths (phase 2), currency exponent handling beyond 2-decimal currencies.
3. CI: lint, typecheck, test, build.
4. Deploy targets (need accounts/env vars from the user): Clerk, Sentry, Cloudflare (vinext compatibility check, OpenNext fallback), Railway (api, worker, Postgres, Redis).

## Open decisions / blockers

- Blocker (2026-11-15): the npm registry was unreachable from the Claude session (`npm view` and curl returned nothing). CLAUDE.md requires checking latest stable versions before adding packages, so the scaffold hasn't started. Retry, or run `pnpm add` yourself where the network works.

- Decided 2026-11-15: Drizzle (ADR 0004); FX rates as scaled bigint, no decimal lib (ADR 0003). Tick "Prisma or Drizzle" in the Claude Doc spec and re-export.
- Spec line "Build standard" still names hasbiy-ui / impeccable / uiuxpromax / awesome-design.md; CLAUDE.md now names design-taste-frontend / frontend-design / ui-ux-pro-max. Spec is exported from the Claude Doc — update it there and re-export.
- Live FX rate provider, pricing model, statutory FX treatment for clients (spec → Open decisions).
- Accountant sign-offs: tax accounts, IAS 21 pool-vs-spot, retention term.

## Session notes

- (append one line per session: date, what changed, anything the next session must know)

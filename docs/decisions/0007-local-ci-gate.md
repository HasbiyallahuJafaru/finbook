# 0007 — Local CI gate while GitHub Actions is unavailable

- Status: accepted (revisit when GitHub billing is fixed)
- Date: 2026-11-15

## Decision
A tracked git `pre-push` hook (`.githooks/pre-push`) runs exactly the CI steps: frozen install, lint, typecheck, unit tests, integration tests (Testcontainers Postgres), build. Any red step blocks the push. Each clone enables it once with `git config core.hooksPath .githooks` (done by `scripts/setup-claude.sh`). `.github/workflows/ci.yml` stays and starts working again as soon as Actions jobs can run.

## Why
GitHub Actions jobs don't start (account billing lock). The owner chose not to depend on it for now. A pre-push hook is zero new infrastructure and runs the same commands.

## Limits
- It runs on the developer's machine, so it isn't independent evidence. `git push --no-verify` skips it. Phase gates should quote the hook's output (or the phase-gate skill's own run) as evidence.
- The machine needs Docker running for the integration tests.

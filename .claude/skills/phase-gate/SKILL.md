---
name: phase-gate
description: Use when the user asks whether a build phase is done, wants to move to the next phase, or asks for project status. Checks the phase's gate from the spec against real evidence.
---

# Phase gate

1. Open `docs/spec/build-spec.md`, section "Build phases and acceptance tests". Find the current phase and its gate.
2. For each gate criterion, find evidence by running it, not by reading code:
   - tests: run them and quote the result line
   - deploys: check the latest deploy status from CI output or logs the user provides (never deploy from here)
   - sign-offs (accountant, pilot client): ask the user, and record the answer and date in `docs/decisions/`
3. Report a table: criterion · evidence · pass/fail.
4. Pass only if every criterion passes. If any fails, list what's left as tasks in order. Don't start the next phase's work.
5. On pass, append a dated entry to `docs/decisions/phase-log.md`: the phase, the evidence summary, and who signed off.

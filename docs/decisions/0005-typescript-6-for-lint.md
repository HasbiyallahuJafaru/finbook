# 0005 — Pin TypeScript to 6.0.x until typescript-eslint supports 7

- Status: accepted (revisit when typescript-eslint's peer range includes TypeScript 7)
- Date: 2026-11-15

## Decision
Use TypeScript `~6.0.3` (latest 6.0.x) across the monorepo, not the current stable 7.0.2.

## Why
typescript-eslint 8.72.2 declares `typescript >=4.8.4 <6.1.0` and throws "does not support TS 7.0" at load time. Strict type-aware linting is how the money rules are enforced (no `parseFloat`, `Number()`, `Math.round`, `toFixed`, non-null assertions), so lint wins over being on the newest compiler.

## Consequence
CLAUDE.md says to use the latest stable version. This is the one recorded exception. When typescript-eslint supports 7, bump `typescript` and delete this ADR's pin.

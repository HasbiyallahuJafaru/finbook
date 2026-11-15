---
name: new-endpoint
description: Use when adding or changing a NestJS API endpoint, controller, or route in apps/api. Covers contract, auth guard, tenancy, idempotency, audit logging, OpenAPI and tests.
---

# New API endpoint

Checklist. Every item is required. Fetch the official NestJS and Clerk docs first if you touch auth or a framework feature you haven't used in this repo yet.

1. **Contract:** add request and response Zod schemas in `packages/contracts`. Money fields are strings of minor units (bigint serialised), plus a `currency` field. Dates are ISO `YYYY-MM-DD`.
2. **Controller:** thin. It validates against the contract and calls a service. No business logic in the controller.
3. **Guard:** add the permission to `apps/api/src/auth/permissions.ts`, then decorate the route. Default deny.
4. **Tenancy:** the service runs inside the tenant transaction helper, which sets `SET LOCAL app.tenant_id`. Never accept a `tenant_id` from the request body.
5. **Writes:** require an `Idempotency-Key` header. Write an `audit_log` row (before/after) in the same transaction. Ledger effects go through `packages/ledger` (see the `ledger-change` skill).
6. **Documents:** never accept file bytes. Issue presigned R2 URLs (10-minute upload to `staging`, 5-minute download), as described in the spec's Document storage section.
7. **Errors:** use typed domain errors mapped to HTTP codes. Unexpected errors go to Sentry with the tenant id and request id. Never leak stack traces or other tenants' data in messages.
8. **Rate limit:** writes and auth-adjacent routes use the Redis limiter.
9. **Tests (integration, real Postgres):**
   - happy path
   - validation failure
   - wrong role → 403
   - **another tenant's id → 404 with no data** (mandatory)
   - same idempotency key twice → one effect
   - audit row written
10. **OpenAPI:** run `pnpm openapi` and commit the regenerated client.
11. Run the `verify` skill. Run the `security-reviewer` subagent if the endpoint touches auth, roles, documents or firm access.

# 0013 — API auth: Clerk JWT, role from the database

- Status: proposed (built 2026-11-16; owner to confirm)
- Date: 2026-11-16
- Implements: spec → Multi-tenancy, roles, security → Request path

## Decision
- One global NestJS guard (`apps/api/src/auth/auth.guard.ts`). A route names a permission with `@Can` or is `@Public`; a route with neither gets 403 (default deny). Permissions map to roles in `permissions.ts` only.
- The Clerk session token is verified **networkless** with `CLERK_JWT_KEY` (the instance's PEM public key), `CLERK_ISSUER` (the instance's Frontend API URL, exact `iss`) and `CLERK_AUTHORIZED_PARTIES` (allowed `azp` origins). Any missing: every guarded route answers 503 (fail closed); `/health` keeps working. Only session tokens pass: header `cat` must be the session category (`@clerk/backend` would also accept JWT-template tokens signed with the same key), `v` must be 2, `sid` present, and `sts: pending` is refused. A repeated header is a 400.
- **Tenant:** the `X-Tenant-Id` header if sent (must be a UUID), else the token's active organization (`o.id`, matched to `tenants.clerk_org_id`). Neither: 400.
- **Role comes from our database, not from the token's `o.rol`:** exactly one row in `firm_access` (firm staff assigned by a firm admin) or `memberships` (the client's people, mirrored from Clerk by webhook). A client membership counts only while the token's active org **is** that tenant's org, so Clerk's live membership is a second check: a missed or late webhook can only narrow access. People in the global `firm_staff` list (which `firm_access` must point at) never hold a client role in any tenant. Tenants whose status isn't `active` give no access. Both are read under RLS in one transaction (`resolveAccess` in `packages/db`). The org lookup uses a narrow policy on `tenants` keyed by `app.clerk_org_id`, set for that one lookup only. No definer functions.
- No access, unknown tenant or another tenant's id: the same 404, so the API is not an existence oracle.
- Firm roles need a second factor: `fva[1]` must not be -1 (spec: MFA required for firm roles).
- Every guarded response carries an `x-request-id` the server generated (never the client's); Sentry's request scope is tagged with `request_id` and `tenant_id`. `DATABASE_URL` missing: the API refuses to start (pg would otherwise fall back to `PG*` variables).

- **Membership webhook** (`POST /webhooks/clerk`, public, authenticated by the Svix signature via `verifyWebhook` with `CLERK_WEBHOOK_SIGNING_SECRET`; unset: 503 so Clerk retries): mirrors `organizationMembership.created/updated/deleted`. Only the Clerk roles `org:client_owner`, `org:client_staff` and `org:client_viewer` grant anything; Clerk's `org:admin`/`org:member` and anything else map to no access. A removal sets `revoked_at` (rows are never deleted, so each change is audited). Each event applies only if its timestamp is newer than the last one applied for that member, so retries, duplicates and out-of-order deliveries are no-ops, and a removal that arrives first leaves a tombstone. Firm staff are never mirrored. `organization.deleted` revokes every membership of that tenant. A membership or organization event we can't read is a 500, so Clerk retries and Sentry sees it; an event for an org with no tenant is logged and sent to Sentry as a warning. The webhook writes through its own login, `finbook_hook` (role `finbook_sync`, `WEBHOOK_DATABASE_URL`): request handlers run as `finbook_app`, which can read access rows but not write them, so no handler bug can promote anyone.

## Why
- The DB role is auditable (audit triggers on both tables) and works the same for firm staff, who have no membership in the client's Clerk org. Token roles would need a custom Clerk role set per org and still not cover `firm_access`.
- Networkless verification has no Clerk API call in the request path and is testable with a local key.

## Consequences
- Clerk setup (owner): custom org roles `org:client_owner`, `org:client_staff`, `org:client_viewer`; a webhook endpoint to `/webhooks/clerk` subscribed to organizationMembership events. Organization and user deletions aren't mirrored yet; removing someone from the org (which Clerk does on user deletion) revokes them.
- A role change takes effect on the next request (no token lag); revoking a Clerk session still waits for the token to expire (60 s by default).
- Role downgrades still wait for the webhook (a daily reconciliation against the Clerk API is a later worker job).
- Suspended and closed tenants get no access at all; if auditors need read access to a closed tenant later, that is a new decision.
- MFA is "a second factor this session" (`fva[1] >= 0`); sensitive routes (period reopen, report release, firm_access grants) add a step-up check (`fva[1] <= N`).

# 0014 — Idempotent writes and rate limits

- Status: accepted (built 2026-11-16)
- Date: 2026-11-16
- Implements: CLAUDE.md → Ledger (idempotency key on every entry), new-endpoint checklist items 5 and 8, spec → Security baseline ("every login endpoint and write endpoint is rate limited in Redis")

## Decision
- **Every write takes an `Idempotency-Key` header** (8–200 printable characters; a UUID is ideal). `idempotentWrite` in `apps/api/src/write.ts` does the work and stores its answer in `idempotency_keys` (tenant, key, hash of route + validated body, status, response) **in the same transaction**:
  - same key, same request: the stored answer, no second effect;
  - same key, different request (or from another user of the tenant): 422;
  - two copies at once: the second waits on the key's unique index, finds the first committed, rolls its own work back and returns the first answer;
  - a write that fails stores nothing, so a retry runs again; but if ours failed because a copy committed first (on a business key such as the VIN), the copy's answer is returned.
- Keys are per tenant and bound to the user (in the request hash). Stored answers hold personal data (phones, TINs), so a worker job deletes keys older than 7 days: a gate item before real client data, not built yet.
- **Rate limits** with `@nestjs/throttler`, counted in Redis (`REDIS_URL`) so every api instance shares them. The limiter runs **before** the auth guard, so failed sign-ins and callers without access are counted too. Its counter is the client IP plus the user id the token claims (unverified, used only to pick a counter): people behind one mobile-carrier IP get their own counters, and a forged token can't use up someone else's unless it comes from their IP. Express trusts one proxy hop (Railway's edge), so a client can't forge its IP with `X-Forwarded-For`; if a proxy such as Cloudflare is ever put in front, this setting must change with it. Limits: 300 requests a minute per counter per route, 60 per write route (so the budget grows with the number of write routes). `/health` is never limited.
- **The Redis storage is our own 25 lines** (`RedisThrottlerStorage`, one Lua script) rather than the community `@nest-lab/throttler-storage-redis`, whose 1.2.0 doesn't support NestJS 12. It implements the library's `ThrottlerStorage` interface, so swapping to the package later is a one-line change.
- Without `REDIS_URL` (local runs, tests), or while Redis is unreachable, the limiter uses in-memory counters per process (and reports the Redis error to Sentry): still limited, never an outage.

## Why
- Retries are normal on Nigerian mobile networks; without a key, a retried "add receipt" would book the money twice.
- Storing the answer in the write's own transaction means there is no window where the effect exists without its key, or the reverse.

## Consequences
- Clients (web and Flutter) generate the key when the user presses save and reuse it on every retry of that save.

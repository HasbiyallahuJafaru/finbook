# Infrastructure and deploy runbook

Claude may build and deploy **staging** (CLAUDE.md → Infrastructure and deploys). **Production is user-run only**, from the steps at the bottom.

## What exists (2026-11-15)

Staging Postgres has migrations 0000–0008 applied (last run 2026-11-15, via the `migrate` service). The worker's daily rate snapshot (10:30 Lagos, ADR 0010) writes as `finbook_rates`.

### Railway project `finbook` (workspace: hasbiyallahujafaru's Projects)

| Environment | State |
| --- | --- |
| `staging` | Postgres, Redis, `api`, `worker`: all running |
| `production` | Created by Railway by default. Empty. User-run only. |

Staging services:

| Service | Source | Build (Railpack variable) | Start (Railpack variable) | Public URL |
| --- | --- | --- | --- | --- |
| Postgres | Railway template | n/a | n/a | private only |
| Redis | Railway template | n/a | n/a | private only |
| api | `railway up` from local tree | `RAILPACK_BUILD_CMD=pnpm turbo run build --filter=@app/api` | `RAILPACK_START_CMD=pnpm --filter @app/api start` | https://api-staging-c68d0388.up.railway.app (`/health` → `{"status":"ok"}`) |
| worker | `railway up` from local tree | `RAILPACK_BUILD_CMD=pnpm turbo run build --filter=@app/worker` | `RAILPACK_START_CMD=pnpm --filter @app/worker start` | none (no HTTP) |
| migrate | `railway up` from local tree; runs once and stops | `RAILPACK_BUILD_CMD=true` | `RAILPACK_START_CMD=pnpm db:migrate` | none |

Staging variables (values never printed or committed):

| Variable | api | worker | Value |
| --- | --- | --- | --- |
| `REDIS_URL` | yes | yes | `${{Redis.REDIS_URL}}` reference |
| `SENTRY_ENVIRONMENT` | yes | yes | `staging` |
| `SENTRY_DSN` | not yet | not yet | needs a Sentry project |
| `DATABASE_URL` (api only) | yes | no | `postgresql://finbook_api:${{migrate.FINBOOK_API_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (non-superuser login, ADR 0006) |
| `CLERK_JWT_KEY` (api only) | not yet | no | the Clerk instance's PEM public key (Dashboard → API keys → JWT public key). Unset: guarded routes answer 503 (ADR 0013) |
| `CLERK_ISSUER` (api only) | not yet | no | the Clerk instance's Frontend API URL (exact `iss` claim) |
| `CLERK_WEBHOOK_SIGNING_SECRET` (api only) | not yet | no | the signing secret of the Clerk webhook endpoint `https://<api>/webhooks/clerk`. Unset: the webhook answers 503 and Clerk retries |
| `CLERK_AUTHORIZED_PARTIES` (api only) | not yet | no | comma-separated web origins allowed as `azp`, e.g. the staging web URL |
| `DATABASE_OWNER_URL` (migrate only) | no | no | `${{Postgres.DATABASE_URL}}`: the owner; never on api or worker |
| `FINBOOK_API_DB_PASSWORD` (migrate only) | no | no | random, generated locally and piped in with `--stdin`; never printed |
| `FINBOOK_RATES_DB_PASSWORD` (migrate only) | no | no | random, generated locally and piped in with `--stdin`; never printed. `migrate` sets it as the `finbook_rates` login's password |
| `FINBOOK_HOOK_DB_PASSWORD` (migrate only) | no | no | random, generated locally and piped in with `--stdin`; never printed. `migrate` sets it as the `finbook_hook` login's password (ADR 0013) |
| `WEBHOOK_DATABASE_URL` (api only) | not yet | no | `postgresql://finbook_hook:${{migrate.FINBOOK_HOOK_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`: only the Clerk webhook writes memberships through it. Unset: the webhook answers 503 |
| `R2_ENDPOINT` (api only) | not yet | no | `https://<account>.r2.cloudflarestorage.com` (S3 API domain; presigned URLs don't work on custom domains) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (api only) | not yet | no | an R2 token scoped to the two buckets (Object Read & Write; R2 can't separate write from delete, so the evidence bucket lock is the protection, ADR 0015). Before setting these: bucket lock on evidence and a test that overwriting or deleting an existing object fails; staging lifecycle rule; and a check that a PUT with a different length than signed is refused (403) |
| `R2_STAGING_BUCKET`, `R2_EVIDENCE_BUCKET` (api only) | not yet | no | `finbook-staging-staging`, `finbook-staging-evidence` (names to confirm). Evidence: bucket lock, 7-year retention (accountant to confirm). Staging: lifecycle rule, delete after 24 h; CORS allowing PUT from the web origin |
| `RATES_DATABASE_URL` (worker only) | no | yes | `postgresql://finbook_rates:${{migrate.FINBOOK_RATES_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` (reference rates only, no tenant data) |

Build and start commands are set as Railpack variables because the installed Railway CLI (5.41.2) silently ignores `railway environment edit --service-config`. Node 24 comes from `engines` in the root `package.json`.

### Cloudflare

| Worker | State |
| --- | --- |
| `finbook-web-staging` | Not deployed yet: the Cloudflare login on this machine has expired. Dry run passes. |
| `finbook-web` (production) | User-run only. |

`apps/web/cloudflare.config.ts` deploys to `finbook-web-staging` unless `CF_WORKER_NAME` is set, so an accidental deploy can only hit staging.

## Staging: redeploy

```
railway up -s api -e staging --detach
railway up -s worker -e staging --detach
railway up -s migrate -e staging --detach   # after any new migration; logs end with "migrations applied"
railway service status -s api -e staging
pnpm --filter @app/web exec vinext-cloudflare deploy      # after `pnpm --filter @app/web exec cf login`
```

## Adding a client (until the phase-3 onboarding endpoint)

The owner, on the database's owner connection, in one transaction:

```sql
BEGIN;
SELECT set_config('app.user_id', '<your Clerk user id>', true);           -- every audit row names who did it
INSERT INTO tenants (legal_name, clerk_org_id, go_live_on) VALUES ('<legal name>', '<Clerk org id>', '<first day of the books>') RETURNING id;
SELECT seed_default_chart('<that id>');                                    -- the default chart of accounts (migration 0016)
COMMIT;
```

Periods need no setup: the first posting dated in a month opens that month. Entries are taken from the go-live date to today (Lagos time); a client with no go-live date takes none. Locking a month waits for the phase-4 close.

## Open items (need the owner, in a browser)

1. **Cloudflare login:** run `pnpm --filter @app/web exec cf login` in a terminal (it opens a browser). Then Claude deploys `finbook-web-staging`.
2. **Railway ↔ GitHub:** Railway → Account → Integrations → GitHub, give the Railway app access to `HasbiyallahuJafaru/finbook`. Then connect `api` and `worker` to the repo (branch `main`) with watch paths `/apps/api/**` + `/packages/**` and `/apps/worker/**` + `/packages/**`, so pushes auto-deploy staging.
3. **API healthcheck:** Railway → api (staging) → Settings → Healthcheck path `/health`.
4. **GitHub billing lock:** blocks CI (Actions jobs don't start).
5. **Sentry:** create projects for api, worker, web; give Claude the staging DSNs to set as variables.

## Production (user-run)

Do this only after staging is green and CI passes on `main`.

1. In Railway, switch to the `production` environment of `finbook`. Add Postgres and Redis; add `api` and `worker` services with the same build/start variables as staging, and `SENTRY_ENVIRONMENT=production`, `REDIS_URL=${{Redis.REDIS_URL}}`.
2. `railway up -s api -e production --detach` and the same for `worker` (or connect GitHub with a production branch).
3. `railway domain -s api -e production`, then check `/health`.
4. Web: `CF_WORKER_NAME=finbook-web pnpm --filter @app/web exec vinext-cloudflare deploy`.
5. Custom domains and DNS: decide with the team first.

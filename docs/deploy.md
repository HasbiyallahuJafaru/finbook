# Infrastructure and deploy runbook

Claude may build and deploy **staging** (CLAUDE.md → Infrastructure and deploys). **Production is user-run only**, from the steps at the bottom.

## What exists (2026-11-15)

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
| `DATABASE_OWNER_URL` (migrate only) | no | no | `${{Postgres.DATABASE_URL}}`: the owner; never on api or worker |
| `FINBOOK_API_DB_PASSWORD` (migrate only) | no | no | random, generated locally and piped in with `--stdin`; never printed |

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

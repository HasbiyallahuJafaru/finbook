# Deploy runbook (phase 0)

Claude sessions never deploy (CLAUDE.md, `settings.json` deny rules). You run these. Do staging first; production only after staging is healthy.

## Railway (api, worker, Redis; Postgres arrives in phase 1)

One Railway project per environment (`finbook-staging`, `finbook-prod`). Shared pnpm monorepo, so no root directory: set commands per service. Railway's config-as-code is deprecated, so use service settings (or `railway environment edit --service-config`).

| Service | Source | Build command | Start command | Healthcheck | Watch paths |
| --- | --- | --- | --- | --- | --- |
| redis | Railway Redis template | n/a | n/a | n/a | n/a |
| api | this repo | `pnpm turbo run build --filter=@app/api` | `pnpm --filter @app/api start` | `/health` | `/apps/api/**`, `/packages/**` |
| worker | this repo | `pnpm turbo run build --filter=@app/worker` | `pnpm --filter @app/worker start` | none (no HTTP) | `/apps/worker/**`, `/packages/**` |

Variables (set in Railway, never in the repo):

| Variable | api | worker | Value |
| --- | --- | --- | --- |
| `REDIS_URL` | yes | yes | reference the Redis service: `${{Redis.REDIS_URL}}` |
| `SENTRY_DSN` | yes | yes | from the Sentry project (separate project per app is fine) |
| `SENTRY_ENVIRONMENT` | yes | yes | `staging` or `production` |

`PORT` is injected by Railway; the api already reads it. Node 24 comes from `engines` in the root `package.json`.

Check: `curl https://<api-domain>/health` returns `{"status":"ok"}`; the worker log shows it connected to Redis with no errors.

## Cloudflare (web)

```
pnpm --filter @app/web build
pnpm --filter @app/web deploy      # vinext-cloudflare deploy; needs `cf` / wrangler login on your machine
```

Worker name is `finbook-web` (`apps/web/cloudflare.config.ts`). The page is a placeholder until Clerk and the API client land.

## Not set up yet

- Sentry in web (see docs/PROGRESS.md).
- Postgres, Clerk keys, R2 buckets: phase 1+.
- Custom domains and a staging/production split for the web Worker.

import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    // Staging by default; production deploys set CF_WORKER_NAME=finbook-web explicitly (user-run, see docs/deploy.md).
    name: process.env.CF_WORKER_NAME ?? "finbook-web-staging",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-15",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
});

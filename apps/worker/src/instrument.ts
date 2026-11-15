import * as Sentry from '@sentry/nestjs';

// Loaded with `node --import ./dist/instrument.js` so it runs before any other module (ESM).
// No SENTRY_DSN = Sentry disabled (local dev, CI). DSN and environment come from env vars only.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});

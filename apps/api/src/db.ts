import pg from 'pg';

export const POOL = 'PG_POOL';

/** The finbook_api login (ADR 0006): never the owner. Queries go through withTenant / resolveAccess only. */
export const poolProvider = {
  provide: POOL,
  useFactory: () => {
    // Without it pg falls back to PG* variables or localhost, which could be the owner login: refuse to start.
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (the finbook_api login) is required');
    return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  },
};

export const HOOK_POOL = 'HOOK_PG_POOL';

/** The finbook_hook login, used only by the Clerk webhook to write memberships. Unset: the webhook answers 503. */
export const hookPoolProvider = {
  provide: HOOK_POOL,
  useFactory: () => (process.env.WEBHOOK_DATABASE_URL ? new pg.Pool({ connectionString: process.env.WEBHOOK_DATABASE_URL, max: 2 }) : null),
};

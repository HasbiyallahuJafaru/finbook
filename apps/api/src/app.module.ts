import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import type pg from 'pg';
import { AuthGuard } from './auth/auth.guard.js';
import { ClerkWebhookController } from './clerk-webhook.controller.js';
import { HOOK_POOL, hookPoolProvider, POOL, poolProvider } from './db.js';
import { HealthController } from './health.controller.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [SentryModule.forRoot()],
  controllers: [HealthController, MeController, ClerkWebhookController],
  providers: [poolProvider, hookPoolProvider, { provide: APP_FILTER, useClass: SentryGlobalFilter }, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool, @Inject(HOOK_POOL) private readonly hookPool: pg.Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.hookPool?.end()]);
  }
}

import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { ThrottlerModule } from '@nestjs/throttler';
import type pg from 'pg';
import { AuthGuard } from './auth/auth.guard.js';
import { ClerkWebhookController } from './clerk-webhook.controller.js';
import { CounterpartiesController } from './counterparties.controller.js';
import { HOOK_POOL, hookPoolProvider, POOL, poolProvider, storageProvider } from './db.js';
import { DocumentsController } from './documents.controller.js';
import { JobOrdersController } from './job-orders.controller.js';
import { HealthController } from './health.controller.js';
import { MeController } from './me.controller.js';
import { CallerThrottlerGuard, DEFAULT_LIMIT, throttlerStorage } from './throttle.js';
import { VehiclesController } from './vehicles.controller.js';

@Module({
  imports: [SentryModule.forRoot(), ThrottlerModule.forRootAsync({ useFactory: () => ({ throttlers: [DEFAULT_LIMIT], storage: throttlerStorage() }) })],
  controllers: [HealthController, MeController, ClerkWebhookController, CounterpartiesController, VehiclesController, DocumentsController, JobOrdersController],
  providers: [poolProvider, hookPoolProvider, storageProvider, { provide: APP_FILTER, useClass: SentryGlobalFilter }, { provide: APP_GUARD, useClass: CallerThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }], // limits first, so failed sign-ins count
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: pg.Pool, @Inject(HOOK_POOL) private readonly hookPool: pg.Pool | null) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.hookPool?.end()]);
  }
}

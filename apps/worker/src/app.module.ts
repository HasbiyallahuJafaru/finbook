import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { redisClient } from './redis.js';
import { FxProcessor } from './fx.processor.js';
import { SystemProcessor } from './system.processor.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('REDIS_URL is required');
        return { connection: redisClient(url) };
      },
    }),
    BullModule.registerQueue({ name: 'system' }, { name: 'fx' }),
  ],
  providers: [SystemProcessor, FxProcessor],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { connectionFromUrl } from './redis.js';
import { SystemProcessor } from './system.processor.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('REDIS_URL is required');
        return { connection: connectionFromUrl(url) };
      },
    }),
    BullModule.registerQueue({ name: 'system' }),
  ],
  providers: [SystemProcessor],
})
export class AppModule {}

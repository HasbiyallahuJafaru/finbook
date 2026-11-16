import { Logger, type OnModuleInit } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import pg from 'pg';
import { fetchRates, storeRates } from './rates.js';

/** Daily CBN + market rate snapshot (ADR 0010). Runs after CBN's morning publication, Lagos time; retries with backoff. */
@Processor('fx')
export class FxProcessor extends WorkerHost implements OnModuleInit {
  constructor(@InjectQueue('fx') private readonly queue: Queue) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Upsert: the same id on every start, so restarts never duplicate the schedule.
    await this.queue.upsertJobScheduler('fx-snapshot-daily', { pattern: '0 30 10 * * *', tz: 'Africa/Lagos' }, {
      name: 'snapshot',
      opts: { attempts: 6, backoff: { type: 'exponential', delay: 60_000 } },
    });
  }

  async process(job: Job): Promise<{ inserted: number }> {
    if (job.name !== 'snapshot') throw new Error(`unknown job: ${job.name}`);
    const url = process.env.RATES_DATABASE_URL; // the finbook_rates login: reference rates only, no tenant data
    if (!url) throw new Error('RATES_DATABASE_URL is required for the rate snapshot');
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    try {
      return { inserted: await storeRates(db, await fetchRates()) };
    } finally {
      await db.end();
    }
  }

  // The only trace of the daily run until Sentry has a DSN: one line per outcome in the Railway logs.
  @OnWorkerEvent('completed')
  completed(job: Job<unknown, { inserted: number }>): void {
    Logger.log(`${job.name} done: ${String(job.returnvalue.inserted)} rate rows inserted`, 'FxProcessor');
  }

  @OnWorkerEvent('failed')
  failed(job: Job | undefined, err: Error): void {
    Logger.error(`${job?.name ?? 'job'} failed (attempt ${String(job?.attemptsMade ?? 0)}): ${err.message}`, 'FxProcessor');
  }
}

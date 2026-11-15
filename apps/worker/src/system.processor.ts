import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

// ponytail: one queue with a ping job proves the wiring. Real queues (pdf, email, fx-snapshot, backup) replace it per phase.
@Processor('system')
export class SystemProcessor extends WorkerHost {
  process(job: Job): Promise<{ pong: true }> {
    if (job.name === 'ping') return Promise.resolve({ pong: true });
    return Promise.reject(new Error(`unknown job: ${job.name}`));
  }
}

import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from './app.module.js';
import { redisClient } from './redis.js';
import { SystemProcessor } from './system.processor.js';

test('redisClient reads host, port and password from the URL and sets the BullMQ options', () => {
  const r = redisClient('redis://:p%40ss@cache.example:6380', { lazyConnect: true });
  assert.equal(r.options.host, 'cache.example');
  assert.equal(r.options.port, 6380);
  assert.equal(r.options.password, 'p@ss');
  assert.equal(r.options.maxRetriesPerRequest, null);
  assert.equal(r.options.family, 0);
});

test('SystemProcessor answers ping and rejects unknown jobs', async () => {
  const p = new SystemProcessor();
  assert.deepEqual(await p.process({ name: 'ping' } as Job), { pong: true });
  await assert.rejects(p.process({ name: 'nope' } as Job), /unknown job: nope/);
});

// Real Redis: set REDIS_URL (CI provides a service container; locally `docker run -p 6379:6379 redis`).
test('ping job round-trips through Redis', { skip: !process.env.REDIS_URL }, async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const events = new QueueEvents('system', { connection: redisClient(process.env.REDIS_URL ?? '') });
  try {
    const queue = app.get<Queue>(getQueueToken('system'));
    const job = await queue.add('ping', {});
    assert.deepEqual(await job.waitUntilFinished(events, 10_000), { pong: true });
  } finally {
    await events.close();
    await app.close();
  }
});

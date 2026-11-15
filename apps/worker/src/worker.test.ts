import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from './app.module.js';
import { connectionFromUrl } from './redis.js';
import { SystemProcessor } from './system.processor.js';

test('connectionFromUrl parses host, port, auth and tls', () => {
  assert.deepEqual(connectionFromUrl('redis://localhost'), { host: 'localhost', port: 6379 });
  assert.deepEqual(connectionFromUrl('rediss://u:p%40ss@cache.example:6380'), {
    host: 'cache.example', port: 6380, username: 'u', password: 'p@ss', tls: {},
  });
  assert.throws(() => connectionFromUrl('http://x'));
});

test('SystemProcessor answers ping and rejects unknown jobs', async () => {
  const p = new SystemProcessor();
  assert.deepEqual(await p.process({ name: 'ping' } as Job), { pong: true });
  await assert.rejects(p.process({ name: 'nope' } as Job), /unknown job: nope/);
});

// Real Redis: set REDIS_URL (CI provides a service container; locally `docker run -p 6379:6379 redis`).
test('ping job round-trips through Redis', { skip: !process.env.REDIS_URL }, async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const events = new QueueEvents('system', { connection: connectionFromUrl(process.env.REDIS_URL ?? '') });
  try {
    const queue = app.get<Queue>(getQueueToken('system'));
    const job = await queue.add('ping', {});
    assert.deepEqual(await job.waitUntilFinished(events, 10_000), { pong: true });
  } finally {
    await events.close();
    await app.close();
  }
});

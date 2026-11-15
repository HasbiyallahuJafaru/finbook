import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from './app.module.js';
import { redisClient } from './redis.js';
import { CBN_URL, fetchRates, marketUrl, parseCbn, parseMarket, storeRates } from './rates.js';
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

// Rate feeds, parsed from fixture bodies shaped like the real ones (values are fixtures, not live rates).
const FIXTURE_CBN_BODY = JSON.stringify([
  { id: 1, currency: 'YUAN/RENMINBI', ratedate: '2026-11-12', buyingrate: 1.1, centralrate: 1.2, sellingrate: 1.3 },
  { id: 2, currency: 'CFA', ratedate: '2026-11-13', buyingrate: 2.2696, centralrate: 2.2796, sellingrate: 2.2896 },
]).replace('}]', '},{"id":3,"currency":"YUAN/RENMINBI","ratedate":"2026-11-13","buyingrate":202.7657,"centralrate":202.84065,"sellingrate":202.9155},'
  + '{"id":4,"currency":"US DOLLAR","ratedate":"2026-11-13","buyingrate":1499.1,"centralrate":1500.0000001,"sellingrate":1500.9}]');
const FIXTURE_MARKET_BODY = '{"result":"success","time_last_update_utc":"Sun, 15 Nov 2026 00:02:32 +0000","base_code":"CNY","rates":{"CNY":1,"NGN":202.1144995,"USD":0.149485}}';

test('parseCbn keeps the latest CNY and USD central rates, exactly, rounded half-up to 6 places', () => {
  assert.deepEqual(parseCbn(FIXTURE_CBN_BODY), [
    { rateDate: '2026-11-13', currency: 'CNY', rate: '202.840650', source: 'cbn' },
    { rateDate: '2026-11-13', currency: 'USD', rate: '1500.000000', source: 'cbn' },
  ]);
  assert.throws(() => parseCbn('{"not":"an array"}'), /unexpected CBN feed shape/);
  assert.throws(() => parseCbn('[{"currency":"CFA","ratedate":"2026-11-13","centralrate":1}]'), /no CNY or USD rate/);
  assert.throws(() => parseCbn('[{"currency":"US DOLLAR","ratedate":"2026-11-13"}]'), /missing centralrate/);
  assert.throws(() => parseCbn('[1]'), /unexpected rate feed shape/);
  assert.throws(() => parseCbn('[{"currency":"US DOLLAR","ratedate":"05/11/2026","centralrate":1}]'), /not an ISO date/);
});

test('parseMarket reads NGN per unit of the base currency and the feed date', () => {
  assert.deepEqual(parseMarket(FIXTURE_MARKET_BODY, 'CNY'), { rateDate: '2026-11-15', currency: 'CNY', rate: '202.114500', source: 'market' });
  assert.throws(() => parseMarket('{"result":"error","error-type":"unsupported-code"}', 'CNY'), /returned error/);
  assert.throws(() => parseMarket('{"result":"success","time_last_update_utc":"Sun, 15 Nov 2026 00:02:32 +0000","rates":{}}', 'CNY'), /missing the NGN rate/);
});

test('fetchRates calls CBN and the market feed for CNY and USD, and fails loudly on a bad answer', async () => {
  const urls: string[] = [];
  const ok = (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(url.includes('cbn') ? FIXTURE_CBN_BODY : FIXTURE_MARKET_BODY));
  };
  const rows = await fetchRates(ok);
  assert.deepEqual(urls, [CBN_URL, marketUrl('CNY'), marketUrl('USD')]);
  assert.deepEqual(rows.map((r) => `${r.source}:${r.currency}`), ['cbn:CNY', 'cbn:USD', 'market:CNY', 'market:USD']);
  const down = () => Promise.resolve(new Response('busy', { status: 503 }));
  await assert.rejects(fetchRates(down), /answered 503/);
});

test('storeRates skips a rate it already has and stores a same-day restatement as the next revision', async () => {
  const stored: { rate: string; revision: number }[] = [];
  const db = {
    query: (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) return Promise.resolve({ rows: stored.slice(-1) });
      stored.push({ rate: String(params[2]), revision: Number(params[4]) });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Parameters<typeof storeRates>[0];
  const row = { rateDate: '2026-11-13', currency: 'CNY' as const, source: 'cbn' as const };
  assert.equal(await storeRates(db, [{ ...row, rate: '202.840650' }]), 1);
  assert.equal(await storeRates(db, [{ ...row, rate: '202.840650' }]), 0, 'same rate: nothing new');
  assert.equal(await storeRates(db, [{ ...row, rate: '202.900000' }]), 1, 'restated');
  assert.deepEqual(stored, [{ rate: '202.840650', revision: 1 }, { rate: '202.900000', revision: 2 }]);
});

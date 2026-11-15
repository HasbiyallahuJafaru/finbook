import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

test('GET /health returns ok', async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const res = await fetch(`${await app.getUrl()}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('an unhandled error returns 500 through the Sentry filter', async () => {
  const { Controller, Get, Module } = await import('@nestjs/common');
  const { APP_FILTER } = await import('@nestjs/core');
  const { SentryGlobalFilter } = await import('@sentry/nestjs/setup');
  @Controller('boom')
  class Boom {
    @Get()
    boom(): never {
      throw new Error('boom');
    }
  }
  @Module({ controllers: [Boom], providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }] })
  class BoomModule {}
  const app = await NestFactory.create(BoomModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(`${await app.getUrl()}/boom`)).status, 500);
  } finally {
    await app.close();
  }
});

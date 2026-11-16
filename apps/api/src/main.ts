import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // the Clerk webhook verifies the exact bytes
// Railway's edge proxy is one hop: req.ip is the client it saw, not a forwarded value the client can forge.
app.set('trust proxy', 1);
await app.listen(process.env.PORT ?? 3000, '0.0.0.0');

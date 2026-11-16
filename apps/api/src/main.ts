import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule, { rawBody: true }); // the Clerk webhook verifies the exact bytes
await app.listen(process.env.PORT ?? 3000, '0.0.0.0');

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// The Redis worker connection keeps the process alive; SIGTERM from Railway closes it cleanly.
const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();

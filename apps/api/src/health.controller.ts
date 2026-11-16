import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './auth/permissions.js';

// Public on purpose: liveness probe for Railway. Every other endpoint needs a permission (auth.guard.ts).
@Controller('health')
@SkipThrottle() // Railway's probe must never be limited or depend on Redis
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }
}

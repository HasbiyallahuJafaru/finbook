import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/permissions.js';

// Public on purpose: liveness probe for Railway. Every other endpoint needs a permission (auth.guard.ts).
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }
}

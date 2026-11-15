import { Controller, Get } from '@nestjs/common';

// Public on purpose: liveness probe for Railway. Every other endpoint needs a guard (CLAUDE.md).
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}

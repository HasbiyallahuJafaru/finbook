import { Controller, Get, Inject, Req } from '@nestjs/common';
import type pg from 'pg';
import { withTenant } from '@app/db';
import type { MeResponse } from '@app/contracts';
import { Can, permissionsOf } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';

@Controller('me')
export class MeController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Get()
  @Can('me.read')
  async me(@Req() req: { caller: Caller }): Promise<MeResponse> {
    const { tenantId, userId, role } = req.caller;
    const legalName = await withTenant(this.pool, { tenantId, userId }, async ({ client }) =>
      (await client.query<{ legal_name: string }>('SELECT legal_name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.legal_name ?? '');
    return { tenantId, legalName, userId, role, permissions: permissionsOf(role) };
  }
}

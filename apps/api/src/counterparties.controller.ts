import { Body, Controller, Get, Headers, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type pg from 'pg';
import { withTenant } from '@app/db';
import { CreateCounterparty, ListCounterpartiesQuery, type Counterparty } from '@app/contracts';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { WRITE_LIMIT } from './throttle.js';
import { idempotentWrite, input } from './write.js';

const COLUMNS = 'id, kind, name, phone, email, tin';

@Controller('counterparties')
export class CounterpartiesController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Post()
  @Can('counterparties.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): void }): Promise<Counterparty> {
    const c = input(CreateCounterparty, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /counterparties', body: c }, async ({ client }) => ({
      status: 201,
      body: (await client.query<Counterparty>(
        `INSERT INTO counterparties (tenant_id, kind, name, phone, email, tin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [req.caller.tenantId, c.kind, c.name, c.phone ?? null, c.email ?? null, c.tin ?? null])).rows[0] as Counterparty,
    }));
    res.status(out.status);
    return out.body;
  }

  @Get()
  @Can('counterparties.read')
  async list(@Req() req: { caller: Caller }, @Query() query: unknown): Promise<Counterparty[]> {
    const { kind } = input(ListCounterpartiesQuery, query);
    // ponytail: no paging yet; a client has hundreds of counterparties, not millions. Add keyset paging on id then.
    return withTenant(this.pool, req.caller, async ({ client }) => (await client.query<Counterparty>(
      `SELECT ${COLUMNS} FROM counterparties WHERE ($1::text IS NULL OR kind = $1) ORDER BY name, id`, [kind ?? null])).rows);
  }
}

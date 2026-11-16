import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type pg from 'pg';
import { withTenant } from '@app/db';
import { CreateVehicle, ListVehiclesQuery, vinProblem, type Vehicle } from '@app/contracts';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { WRITE_LIMIT } from './throttle.js';
import { conflictOn, idempotentWrite, input } from './write.js';

const COLUMNS = `id, vin, vin_status AS "vinStatus", make, model, year, colour, mileage, direction, status,
  to_char(purchase_date, 'YYYY-MM-DD') AS "purchaseDate", to_char(sold_date, 'YYYY-MM-DD') AS "soldDate"`;
type Row = Omit<Vehicle, 'vinProblem'>;
const withProblem = (v: Row): Vehicle => ({ ...v, vinProblem: vinProblem(v.vin) }); // the reason, for the user; the DB decides vinStatus

@Controller('vehicles')
export class VehiclesController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  /** A car with a VIN that fails the check is still recorded as typed, flagged vin_needs_correction (CLAUDE.md). */
  @Post()
  @Can('vehicles.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: { status(code: number): void }): Promise<Vehicle> {
    const v = input(CreateVehicle, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /vehicles', body: v }, async ({ client }) => {
      const row = (await client.query<Row>(
        `INSERT INTO vehicles (tenant_id, vin, make, model, year, colour, mileage, direction, purchase_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
        [req.caller.tenantId, v.vin, v.make, v.model, v.year, v.colour ?? null, v.mileage ?? null, v.direction, v.purchaseDate ?? null],
      ).catch(conflictOn('vehicles_tenant_vin', 'a vehicle with this VIN is already recorded'))).rows[0] as Row;
      return { status: 201, body: withProblem(row) };
    });
    res.status(out.status);
    return out.body;
  }

  @Get()
  @Can('vehicles.read')
  async list(@Req() req: { caller: Caller }, @Query() query: unknown): Promise<Vehicle[]> {
    const q = input(ListVehiclesQuery, query);
    // ponytail: no paging yet (spec sizes a client at ~200 cars); add keyset paging on id past a few thousand.
    return withTenant(this.pool, req.caller, async ({ client }) => (await client.query<Row>(
      `SELECT ${COLUMNS} FROM vehicles WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR vin_status = $2) ORDER BY id`,
      [q.status ?? null, q.vinStatus ?? null])).rows.map(withProblem));
  }

  @Get(':id')
  @Can('vehicles.read')
  async get(@Req() req: { caller: Caller }, @Param('id') id: string): Promise<Vehicle> {
    const vehicleId = input(z.uuid(), id);
    const row = await withTenant(this.pool, req.caller, async ({ client }) =>
      (await client.query<Row>(`SELECT ${COLUMNS} FROM vehicles WHERE id = $1`, [vehicleId])).rows[0]);
    if (!row) throw new NotFoundException(); // another tenant's car looks exactly like no car
    return withProblem(row);
  }
}

import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type pg from 'pg';
import { withTenant, type Tx } from '@app/db';
import { AddShipmentVehicle, CreateCostType, CreateShipment, RemoveShipmentVehicle, type CostType, type Shipment } from '@app/contracts';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { WRITE_LIMIT } from './throttle.js';
import { idempotentWrite, input, pgErrors } from './write.js';

type Status = { status(code: number): void };

// The database's own rules in our words (0019); our check messages (a closed container) pass through as 422s.
const ERRORS = pgErrors({
  cost_types_tenant_name: [409, 'a cost type with that name already exists'],
  shipments_tenant_code: [409, 'a container with that code already exists'],
  shipment_vehicles_one_per_car: [409, 'that car is already in a container'],
  shipment_vehicles_vehicle: [422, 'that car is not one of yours'],
}, true);

const COST_TYPE = 'SELECT id, name, default_basis AS "defaultBasis", requires_receipt AS "requiresReceipt", sort FROM cost_types';

/** A client's cost types (spec: kept per tenant, so another importer adds its own without code changes); seeded at onboarding. */
@Controller('cost-types')
export class CostTypesController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Get()
  @Can('cost_types.read')
  async list(@Req() req: { caller: Caller }): Promise<CostType[]> {
    return withTenant(this.pool, req.caller, async ({ client }) => (await client.query<CostType>(`${COST_TYPE} ORDER BY sort, name`)).rows);
  }

  @Post()
  @Can('cost_types.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<CostType> {
    const c = input(CreateCostType, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /cost-types', body: c }, async ({ client }) => ({
      status: 201,
      body: (await client.query<CostType>(
        `INSERT INTO cost_types (tenant_id, name, default_basis, requires_receipt, sort) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, default_basis AS "defaultBasis", requires_receipt AS "requiresReceipt", sort`,
        [req.caller.tenantId, c.name, c.defaultBasis, c.requiresReceipt, c.sort]).catch(ERRORS)).rows[0] as CostType,
    }));
    res.status(out.status);
    return out.body;
  }
}

/** One container with its cars; another tenant's looks exactly like none. */
async function shipmentOf(t: Tx, id: string): Promise<Shipment> {
  const row = (await t.client.query<Shipment>(
    `SELECT s.id, s.code, s.bill_of_lading AS "billOfLading", s.vessel, s.port, to_char(s.arrived_on, 'YYYY-MM-DD') AS "arrivedOn",
            to_char(s.cleared_on, 'YYYY-MM-DD') AS "clearedOn", s.closed_at AS "closedAt", s.closed_by AS "closedBy",
            coalesce((SELECT array_agg(v.vehicle_id ORDER BY v.created_at, v.id) FROM shipment_vehicles v WHERE v.shipment_id = s.id AND v.removed_at IS NULL), '{}') AS "vehicleIds"
       FROM shipments s WHERE s.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundException();
  return { ...row, closedAt: row.closedAt && new Date(row.closedAt).toISOString() };
}

/** Containers (spec → shipments): which cars share a container's costs. A container closes for good; no car or cost joins it after (0019). */
@Controller('shipments')
export class ShipmentsController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Get()
  @Can('shipments.read')
  async list(@Req() req: { caller: Caller }): Promise<Shipment[]> {
    // ponytail: no paging; a client has tens of containers a year. Keyset on id when it has thousands.
    return withTenant(this.pool, req.caller, async (t) => {
      const ids = (await t.client.query<{ id: string }>('SELECT id FROM shipments ORDER BY created_at DESC, id')).rows;
      return Promise.all(ids.map((r) => shipmentOf(t, r.id)));
    });
  }

  @Get(':id')
  @Can('shipments.read')
  async get(@Req() req: { caller: Caller }, @Param('id') id: string): Promise<Shipment> {
    const shipment = input(z.uuid(), id);
    return withTenant(this.pool, req.caller, (t) => shipmentOf(t, shipment));
  }

  @Post()
  @Can('shipments.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<Shipment> {
    const s = input(CreateShipment, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /shipments', body: s }, async (t) => {
      const id = (await t.client.query<{ id: string }>(
        'INSERT INTO shipments (tenant_id, code, bill_of_lading, vessel, port, arrived_on, cleared_on) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [req.caller.tenantId, s.code, s.billOfLading ?? null, s.vessel ?? null, s.port ?? null, s.arrivedOn ?? null, s.clearedOn ?? null]).catch(ERRORS)).rows[0]?.id ?? '';
      return { status: 201, body: await shipmentOf(t, id) };
    });
    res.status(out.status);
    return out.body;
  }

  @Post(':id/vehicles')
  @Can('shipments.write')
  @Throttle(WRITE_LIMIT)
  async addVehicle(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) res: Status): Promise<Shipment> {
    const shipment = input(z.uuid(), id);
    const { vehicleId } = input(AddShipmentVehicle, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /shipments/:id/vehicles', body: [shipment, vehicleId] }, async (t) => {
      await shipmentOf(t, shipment);
      await t.client.query('INSERT INTO shipment_vehicles (tenant_id, shipment_id, vehicle_id) VALUES ($1, $2, $3)', [req.caller.tenantId, shipment, vehicleId]).catch(ERRORS);
      return { status: 201, body: await shipmentOf(t, shipment) };
    });
    res.status(out.status);
    return out.body;
  }

  /** Take a car put in the wrong container out, with the reason; the database keeps the row and refuses it once a standing cost is split onto the car (0019). */
  @Post(':id/vehicles/:vehicleId/remove')
  @Can('shipments.write')
  @Throttle(WRITE_LIMIT)
  async removeVehicle(@Req() req: { caller: Caller }, @Param('id') id: string, @Param('vehicleId') vehicleId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<Shipment> {
    const [shipment, car] = [input(z.uuid(), id), input(z.uuid(), vehicleId)];
    const { reason } = input(RemoveShipmentVehicle, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /shipments/:id/vehicles/:vehicleId/remove', body: [shipment, car, reason] }, async (t) => {
      await shipmentOf(t, shipment);
      const done = await t.client.query('UPDATE shipment_vehicles SET removed_reason = $3 WHERE shipment_id = $1 AND vehicle_id = $2 AND removed_at IS NULL',
        [shipment, car, reason]).catch(ERRORS);
      if (done.rowCount !== 1) throw new NotFoundException('that car is not in this container');
      return { status: 200, body: await shipmentOf(t, shipment) };
    });
    res.status(out.status);
    return out.body;
  }

  /** Close a container for good once its costs are in (owner default: any recorder; it never reopens). Who and when come from the database. */
  @Post(':id/close')
  @Can('shipments.write')
  @Throttle(WRITE_LIMIT)
  async close(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Status): Promise<Shipment> {
    const shipment = input(z.uuid(), id);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /shipments/:id/close', body: shipment }, async (t) => {
      await shipmentOf(t, shipment);
      // the database takes the tenant's posting lock first, so no cost or car for this container is mid-post while it closes (0019)
      await t.client.query('UPDATE shipments SET closed_at = now() WHERE id = $1', [shipment]).catch(ERRORS);
      return { status: 200, body: await shipmentOf(t, shipment) };
    });
    res.status(out.status);
    return out.body;
  }
}

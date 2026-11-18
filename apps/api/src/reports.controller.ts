import { Controller, ForbiddenException, Get, Inject, Query, Req } from '@nestjs/common';
import type pg from 'pg';
import { withTenant } from '@app/db';
import { CarProfitQuery, type CarProfitReport } from '@app/contracts';
import { CAR_PROFIT_SQL, carProfitReport, readCarProfit, type CarProfitQueryRow } from '@app/reports';
import { Can, permissionsOf } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { input } from './write.js';

@Controller('reports')
export class ReportsController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  /** Per-car profitability (ADR 0020): a pure function of the tenant's journal lines, the range and the basis. */
  @Get('car-profit')
  @Can('reports.read')
  async carProfit(@Req() req: { caller: Caller }, @Query() query: unknown): Promise<CarProfitReport> {
    const q = input(CarProfitQuery, query);
    if (q.basis === 'pool' && !permissionsOf(req.caller.role).includes('reports.pool_basis')) throw new ForbiddenException('clients see the spot basis (ADR 0009)');
    // ponytail: one query for the whole range (tens of cars a month per client); page by sale date past a few thousand cars.
    const { asOfSeq, rows } = readCarProfit(await withTenant(this.pool, req.caller, async ({ client }) => (await client.query<CarProfitQueryRow>(CAR_PROFIT_SQL, [q.from, q.to])).rows));
    const cars = carProfitReport(rows, q.basis).map((r) => ({
      vehicleId: r.vehicleId, vin: r.vin, soldOn: r.soldOn, entryId: r.entryId, kind: r.kind, basis: r.basis, currency: 'NGN' as const,
      billedNgn: String(r.billedNgn), carCostNgn: String(r.carCostNgn), landedCostNgn: String(r.landedCostNgn), tradingProfitNgn: String(r.tradingProfitNgn),
      quoteFxNgn: String(r.quoteFxNgn), poolVsSpotNgn: String(r.poolVsSpotNgn), otherFxNgn: String(r.otherFxNgn), fxNgn: String(r.fxNgn),
      otherProfitNgn: String(r.otherProfitNgn), netProfitNgn: String(r.netProfitNgn), marginBp: r.marginBp === null ? null : String(r.marginBp),
    }));
    return { asOfSeq, cars };
  }
}

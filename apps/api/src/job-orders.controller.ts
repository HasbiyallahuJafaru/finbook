import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Query, Req, Res, UnprocessableEntityException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type pg from 'pg';
import { withTenant, type Tx } from '@app/db';
import { formatRate, parseRate } from '@app/money';
import { AcceptQuote, AddJobVehicle, CreateJobOrder, SignOffFlag, ListJobOrdersQuery, type JobOrder } from '@app/contracts';
import { Can } from './auth/permissions.js';
import type { Caller } from './auth/auth.guard.js';
import { POOL } from './db.js';
import { WRITE_LIMIT } from './throttle.js';
import { idempotentWrite, input, pgErrors } from './write.js';

const SELECT = `SELECT j.id, j.number, j.customer_id, j.job_type, j.funding, j.funding_reason, j.status, to_char(j.ordered_on, 'YYYY-MM-DD') AS ordered_on,
    j.car_price_minor::text AS car_price_minor, j.car_price_currency, j.quote_rate::text AS quote_rate, j.quote_rate_source, j.quote_rate_note,
    j.landing_charge_ngn::text AS landing_charge_ngn, j.accepted_quote_document_id,
    coalesce((SELECT json_agg(json_build_object('vehicleId', v.vehicle_id, 'carPriceMinor', v.car_price_minor::text) ORDER BY v.created_at)
      FROM job_order_vehicles v WHERE v.job_order_id = j.id), '[]') AS vehicles,
    coalesce((SELECT json_agg(json_build_object('id', f.id, 'kind', f.kind, 'vehicleId', f.vehicle_id, 'entryId', f.entry_id, 'raisedAt', f.raised_at,
        'signOff', CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('reason', s.reason, 'signedBy', s.signed_by, 'signedAt', s.signed_at) END) ORDER BY f.id)
      FROM job_order_flags f LEFT JOIN job_order_sign_offs s ON s.tenant_id = f.tenant_id AND s.flag_id = f.id WHERE f.job_order_id = j.id), '[]') AS flags
  FROM job_orders j`;
type Row = {
  id: string; number: number; customer_id: string; job_type: JobOrder['jobType']; funding: JobOrder['funding']; funding_reason: string | null;
  status: JobOrder['status']; ordered_on: string; car_price_minor: string | null; car_price_currency: string | null; quote_rate: string | null;
  quote_rate_source: 'cbn' | 'market' | 'manual' | null; quote_rate_note: string | null; landing_charge_ngn: string; accepted_quote_document_id: string | null; vehicles: JobOrder['vehicles'];
  flags: JobOrder['flags'];
};
const toJob = (r: Row): JobOrder => ({
  id: r.id, number: r.number, customerId: r.customer_id, jobType: r.job_type, funding: r.funding, fundingReason: r.funding_reason, status: r.status,
  orderedOn: r.ordered_on,
  carPrice: r.car_price_minor && r.car_price_currency ? { amountMinor: r.car_price_minor, currency: r.car_price_currency } : null,
  quoteRate: r.quote_rate && r.quote_rate_source ? { rate: r.quote_rate, source: r.quote_rate_source, note: r.quote_rate_note } : null,
  landingChargeNgn: r.landing_charge_ngn, acceptedQuoteDocumentId: r.accepted_quote_document_id, vehicles: r.vehicles, flags: r.flags,
});
const one = async (t: Tx, id: string): Promise<JobOrder> => {
  const row = (await t.client.query<Row>(`${SELECT} WHERE j.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundException(); // another tenant's job looks exactly like no job
  return toJob(row);
};
type Status = { status(code: number): void };

// The database's own rules (0013) turned into answers in our words. Nothing here echoes another tenant's data: a
// foreign key to another tenant's row fails exactly like one to a row that doesn't exist.
const JOB_ERRORS = pgErrors({
  job_orders_customer: [422, 'the customer must be one of your customers'],
  job_order_vehicles_vehicle: [422, 'that vehicle is not one of yours'],
  job_order_vehicles_one_job_per_car: [409, 'that vehicle is already on a job order'],
  job_orders_quote_document: [422, 'that document is not one of yours'],
  job_orders_one_job_per_quote: [409, 'that quote is already accepted on another job order'],
  job_order_sign_offs_one_per_flag: [409, 'that flag is already signed off'],
}, true);

/** Job orders (spec → Vehicle module): the quote is fixed when accepted, and nothing posts to a job before that. */
@Controller('job-orders')
export class JobOrdersController {
  constructor(@Inject(POOL) private readonly pool: pg.Pool) {}

  @Post()
  @Can('job_orders.write')
  @Throttle(WRITE_LIMIT)
  async create(@Req() req: { caller: Caller }, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<JobOrder> {
    const j = input(CreateJobOrder, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /job-orders', body: j }, async (t) => {
      const id = (await t.client.query<{ id: string }>(
        `INSERT INTO job_orders (tenant_id, customer_id, job_type, funding, funding_reason, ordered_on, car_price_minor, car_price_currency,
           quote_rate, quote_rate_source, quote_rate_note, landing_charge_ngn)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [req.caller.tenantId, j.customerId, j.jobType, j.funding, j.fundingReason ?? null, j.orderedOn, j.carPrice?.amountMinor ?? null, j.carPrice?.currency ?? null,
          j.quoteRate ? formatRate(parseRate(j.quoteRate.rate)) : null, j.quoteRate?.source ?? null, j.quoteRate?.note ?? null, j.landingChargeNgn],
      ).catch(JOB_ERRORS)).rows[0]?.id ?? '';
      return { status: 201, body: await one(t, id) };
    });
    res.status(out.status);
    return out.body;
  }

  @Get()
  @Can('job_orders.read')
  async list(@Req() req: { caller: Caller }, @Query() query: unknown): Promise<JobOrder[]> {
    const { status } = input(ListJobOrdersQuery, query);
    // ponytail: no paging yet (tens of jobs a month per client); add keyset paging on number past a few thousand.
    return withTenant(this.pool, req.caller, async ({ client }) =>
      (await client.query<Row>(`${SELECT} WHERE ($1::text IS NULL OR j.status = $1) ORDER BY j.number`, [status ?? null])).rows.map(toJob));
  }

  @Get(':id')
  @Can('job_orders.read')
  get(@Req() req: { caller: Caller }, @Param('id') id: string): Promise<JobOrder> {
    const jobId = input(z.uuid(), id);
    return withTenant(this.pool, req.caller, (t) => one(t, jobId));
  }

  @Post(':id/vehicles')
  @Can('job_orders.write')
  @Throttle(WRITE_LIMIT)
  async addVehicle(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<JobOrder> {
    const jobId = input(z.uuid(), id);
    const { vehicleId, carPriceMinor } = input(AddJobVehicle, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /job-orders/:id/vehicles', body: [jobId, vehicleId, carPriceMinor] }, async (t) => {
      await one(t, jobId); // 404 before anything else for another tenant's job
      await t.client.query('INSERT INTO job_order_vehicles (tenant_id, job_order_id, vehicle_id, car_price_minor) VALUES ($1, $2, $3, $4)', [req.caller.tenantId, jobId, vehicleId, carPriceMinor ?? null]).catch(JOB_ERRORS);
      return { status: 201, body: await one(t, jobId) };
    });
    res.status(out.status);
    return out.body;
  }

  /** The customer's acceptance: a stored accepted_quote document; from here the quote and the cars are fixed. */
  @Post(':id/accept-quote')
  @Can('job_orders.write')
  @Throttle(WRITE_LIMIT)
  async acceptQuote(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<JobOrder> {
    const jobId = input(z.uuid(), id);
    const { documentId } = input(AcceptQuote, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /job-orders/:id/accept-quote', body: [jobId, documentId] }, async (t) => {
      await one(t, jobId);
      await t.client.query("UPDATE job_orders SET status = 'quote_accepted', accepted_quote_document_id = $2 WHERE id = $1", [jobId, documentId]).catch(JOB_ERRORS);
      return { status: 200, body: await one(t, jobId) };
    });
    res.status(out.status);
    return out.body;
  }

  /**
   * A firm sign-off on one flag the database raised on this job (ADR 0016): it confirms our accounting treatment of what the
   * client recorded and clears that flag; it never unlocks a posting. The database stamps who and when, and refuses anyone
   * but a firm reviewer or admin of this business, and anyone who touched the job, its cars, its quote or the car's entries.
   */
  @Post(':id/sign-offs')
  @Can('job_orders.sign_off')
  @Throttle(WRITE_LIMIT)
  async signOff(@Req() req: { caller: Caller }, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Status): Promise<JobOrder> {
    const jobId = input(z.uuid(), id);
    const a = input(SignOffFlag, body);
    const out = await idempotentWrite(this.pool, req.caller, key, { route: 'POST /job-orders/:id/sign-offs', body: [jobId, a] }, async (t) => {
      await one(t, jobId);
      const signed = await t.client.query('INSERT INTO job_order_sign_offs (tenant_id, flag_id, reason) SELECT $1, f.id, $3 FROM job_order_flags f WHERE f.id = $2 AND f.job_order_id = $4',
        [req.caller.tenantId, a.flagId, a.reason, jobId]).catch(JOB_ERRORS);
      if (signed.rowCount !== 1) throw new UnprocessableEntityException('that flag is not on this job order');
      return { status: 201, body: await one(t, jobId) };
    });
    res.status(out.status);
    return out.body;
  }
}

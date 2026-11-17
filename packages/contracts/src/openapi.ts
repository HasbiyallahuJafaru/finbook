// pnpm openapi: writes openapi.json from the Zod contracts. Add each new route here with its contract.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AcceptQuote, AddJobVehicle, SignOffFlag, Counterparty, CreateCounterparty, CreateJobOrder, CreateUpload, CreateVehicle, Document, DownloadTicket, IdempotencyKeyHeader, JobOrder,
  ListCounterpartiesQuery, ListJobOrdersQuery, ListVehiclesQuery, MeResponse, TenantIdHeader, UploadTicket, Vehicle,
} from './index.ts';

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });
const tenantHeader = { name: 'X-Tenant-Id', in: 'header', required: false, schema: json(TenantIdHeader),
  description: 'The tenant to act for. Required for firm staff; client users may rely on their active organization.' };
const errors = Object.fromEntries(['400', '401', '403', '404', '503'].map((code) => [code, { description: 'Error' }]));
const writeErrors = Object.fromEntries(['400', '401', '403', '404', '409', '422', '429', '503'].map((code) => [code, { description: 'Error' }]));
const idempotencyHeader = { name: 'Idempotency-Key', in: 'header', required: true, schema: json(IdempotencyKeyHeader),
  description: 'Client-made id for this write; a retry with the same key and body returns the first answer, with no second effect.' };
const body = (schema: z.ZodType) => ({ required: true, content: { 'application/json': { schema: json(schema) } } });
const ok = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema: json(schema) } } });
const idPath = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const queryParams = (schema: z.ZodObject) => Object.entries(json(schema).properties ?? {}).map(([name, s]) => ({ name, in: 'query', required: false, schema: s }));

const doc = {
  openapi: '3.0.3',
  info: { title: 'FinBook API', version: '0' },
  components: { securitySchemes: { clerk: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  security: [{ clerk: [] }],
  paths: {
    '/health': { get: { security: [], responses: { 200: { description: 'Liveness' } } } },
    '/webhooks/clerk': { post: { security: [], description: 'Clerk organization-membership events, authenticated by their Svix signature (ADR 0013).',
      responses: { 200: { description: 'applied, stale, no_tenant or ignored' }, 400: { description: 'Bad signature' }, 503: { description: 'Not configured' } } } },
    '/counterparties': {
      get: { parameters: [tenantHeader, ...queryParams(ListCounterpartiesQuery)], responses: { 200: ok('Counterparties, by name', z.array(Counterparty)), ...errors } },
      post: { parameters: [tenantHeader, idempotencyHeader], requestBody: body(CreateCounterparty), responses: { 201: ok('Created', Counterparty), ...writeErrors } },
    },
    '/vehicles': {
      get: { parameters: [tenantHeader, ...queryParams(ListVehiclesQuery)], responses: { 200: ok('Vehicles', z.array(Vehicle)), ...errors } },
      post: { parameters: [tenantHeader, idempotencyHeader], requestBody: body(CreateVehicle),
        responses: { 201: ok('Recorded; a VIN that fails the check is kept and flagged vin_needs_correction', Vehicle), ...writeErrors } },
    },
    '/vehicles/{id}': {
      get: { parameters: [tenantHeader, { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: ok('Vehicle', Vehicle), ...errors } },
    },
    '/documents/uploads': { post: { parameters: [tenantHeader, idempotencyHeader], requestBody: body(CreateUpload),
      responses: { 201: ok('A 10-minute presigned PUT to staging for exactly this file', UploadTicket), ...writeErrors } } },
    '/documents/{id}/confirm': { post: { parameters: [tenantHeader, idempotencyHeader, idPath],
      responses: { 200: ok('Checked and stored in evidence', Document), 422: ok('Rejected for good, with the reason', Document), ...writeErrors } } },
    '/documents/{id}/download': { get: { parameters: [tenantHeader, idPath], responses: { 200: ok('A 5-minute presigned GET; the view is audited', DownloadTicket), ...errors } } },
    '/job-orders': {
      get: { parameters: [tenantHeader, ...queryParams(ListJobOrdersQuery)], responses: { 200: ok('Job orders by number', z.array(JobOrder)), ...errors } },
      post: { parameters: [tenantHeader, idempotencyHeader], requestBody: body(CreateJobOrder), responses: { 201: ok('Created as draft, numbered by the database', JobOrder), ...writeErrors } },
    },
    '/job-orders/{id}': { get: { parameters: [tenantHeader, idPath], responses: { 200: ok('Job order', JobOrder), ...errors } } },
    '/job-orders/{id}/vehicles': { post: { parameters: [tenantHeader, idempotencyHeader, idPath], requestBody: body(AddJobVehicle), responses: { 201: ok('Car added (draft only)', JobOrder), ...writeErrors } } },
    '/job-orders/{id}/accept-quote': { post: { parameters: [tenantHeader, idempotencyHeader, idPath], requestBody: body(AcceptQuote),
      responses: { 200: ok('Quote accepted; the quote and cars are now fixed', JobOrder), ...writeErrors } } },
    '/job-orders/{id}/sign-offs': { post: { parameters: [tenantHeader, idempotencyHeader, idPath], requestBody: body(SignOffFlag),
      responses: { 201: ok('One flag signed off by a firm reviewer or admin; who and when are stamped by the database', JobOrder), ...writeErrors } } },
    '/me': { get: { parameters: [tenantHeader], responses: { 200: { description: 'The caller in this tenant', content: { 'application/json': { schema: json(MeResponse) } } }, ...errors } } },
  },
};
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);

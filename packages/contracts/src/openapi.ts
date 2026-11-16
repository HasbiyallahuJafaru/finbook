// pnpm openapi: writes openapi.json from the Zod contracts. Add each new route here with its contract.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Counterparty, CreateCounterparty, CreateVehicle, IdempotencyKeyHeader, ListCounterpartiesQuery, ListVehiclesQuery, MeResponse, TenantIdHeader, Vehicle } from './index.ts';

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });
const tenantHeader = { name: 'X-Tenant-Id', in: 'header', required: false, schema: json(TenantIdHeader),
  description: 'The tenant to act for. Required for firm staff; client users may rely on their active organization.' };
const errors = Object.fromEntries(['400', '401', '403', '404', '503'].map((code) => [code, { description: 'Error' }]));
const writeErrors = Object.fromEntries(['400', '401', '403', '404', '409', '422', '429', '503'].map((code) => [code, { description: 'Error' }]));
const idempotencyHeader = { name: 'Idempotency-Key', in: 'header', required: true, schema: json(IdempotencyKeyHeader),
  description: 'Client-made id for this write; a retry with the same key and body returns the first answer, with no second effect.' };
const body = (schema: z.ZodType) => ({ required: true, content: { 'application/json': { schema: json(schema) } } });
const ok = (description: string, schema: z.ZodType) => ({ description, content: { 'application/json': { schema: json(schema) } } });
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
    '/me': { get: { parameters: [tenantHeader], responses: { 200: { description: 'The caller in this tenant', content: { 'application/json': { schema: json(MeResponse) } } }, ...errors } } },
  },
};
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);

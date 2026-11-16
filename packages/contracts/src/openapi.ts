// pnpm openapi: writes openapi.json from the Zod contracts. Add each new route here with its contract.
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { MeResponse, TenantIdHeader } from './index.ts';

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'openapi-3.0' });
const tenantHeader = { name: 'X-Tenant-Id', in: 'header', required: false, schema: json(TenantIdHeader),
  description: 'The tenant to act for. Required for firm staff; client users may rely on their active organization.' };
const errors = Object.fromEntries(['400', '401', '403', '404', '503'].map((code) => [code, { description: 'Error' }]));

const doc = {
  openapi: '3.0.3',
  info: { title: 'FinBook API', version: '0' },
  components: { securitySchemes: { clerk: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  security: [{ clerk: [] }],
  paths: {
    '/health': { get: { security: [], responses: { 200: { description: 'Liveness' } } } },
    '/webhooks/clerk': { post: { security: [], description: 'Clerk organization-membership events, authenticated by their Svix signature (ADR 0013).',
      responses: { 200: { description: 'applied, stale, no_tenant or ignored' }, 400: { description: 'Bad signature' }, 503: { description: 'Not configured' } } } },
    '/me': { get: { parameters: [tenantHeader], responses: { 200: { description: 'The caller in this tenant', content: { 'application/json': { schema: json(MeResponse) } } }, ...errors } } },
  },
};
writeFileSync(new URL('../openapi.json', import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);

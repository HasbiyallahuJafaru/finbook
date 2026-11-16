// Zod schemas shared by web and api (spec → Architecture). Money fields are strings of minor units plus a currency;
// dates are ISO YYYY-MM-DD.
import { z } from 'zod';
import { VinInput } from './vin.ts';

export { VinInput, vinProblem, vinStatus } from './vin.ts';

export const ROLES = ['firm_admin', 'firm_accountant', 'firm_reviewer', 'client_owner', 'client_staff', 'client_viewer'] as const;
export const Role = z.enum(ROLES);

/** X-Tenant-Id: firm staff name the client they act for; client users may omit it and use their active org. */
export const TenantIdHeader = z.uuid();

/** GET /me: who the caller is in the tenant they are acting for, and what they may do there. */
export const MeResponse = z.object({
  tenantId: z.uuid(),
  legalName: z.string(),
  userId: z.string(),
  role: Role,
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** Idempotency-Key on every write: a client-made id (a UUID is ideal), reused verbatim on a retry. */
export const IdempotencyKeyHeader = z.string().trim().min(8).max(200).regex(/^[\x21-\x7e]+$/);

const optionalText = z.string().trim().min(1).max(200).optional();

export const CounterpartyKind = z.enum(['supplier', 'agent', 'customer']);
export const CreateCounterparty = z.strictObject({
  kind: CounterpartyKind,
  name: z.string().trim().min(1).max(200),
  phone: optionalText,
  email: z.email().max(200).optional(),
  tin: optionalText,
});
export type CreateCounterparty = z.infer<typeof CreateCounterparty>;
export const Counterparty = CreateCounterparty.extend({ id: z.uuid(), phone: z.string().nullable(), email: z.string().nullable(), tin: z.string().nullable() });
export type Counterparty = z.infer<typeof Counterparty>;
export const ListCounterpartiesQuery = z.strictObject({ kind: CounterpartyKind.optional() });

const isoDate = z.iso.date(); // YYYY-MM-DD from the date picker; never parsed from free text
export const VehicleDirection = z.enum(['import', 'export', 'local']);
export const VehicleStatus = z.enum(['purchased', 'in_transit', 'at_port', 'in_yard', 'reserved', 'sold', 'delivered', 'written_off', 'returned']);
export const CreateVehicle = z.strictObject({
  vin: VinInput,
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  year: z.int().min(1950).max(2100),
  colour: optionalText,
  mileage: z.int().min(0).max(5_000_000).optional(),
  direction: VehicleDirection.default('import'),
  purchaseDate: isoDate.optional(),
});
export type CreateVehicle = z.infer<typeof CreateVehicle>;
export const Vehicle = z.object({
  id: z.uuid(), vin: z.string(), vinStatus: z.enum(['ok', 'vin_needs_correction']), vinProblem: z.string().nullable(),
  make: z.string(), model: z.string(), year: z.int(), colour: z.string().nullable(), mileage: z.int().nullable(),
  direction: VehicleDirection, status: VehicleStatus, purchaseDate: isoDate.nullable(), soldDate: isoDate.nullable(),
});
export type Vehicle = z.infer<typeof Vehicle>;
export const ListVehiclesQuery = z.strictObject({ status: VehicleStatus.optional(), vinStatus: z.enum(['ok', 'vin_needs_correction']).optional() });

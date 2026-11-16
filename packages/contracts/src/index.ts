// Zod schemas shared by web and api (spec → Architecture). Money fields are strings of minor units plus a currency;
// dates are ISO YYYY-MM-DD.
import { z } from 'zod';

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

export { VinInput, vinProblem, vinStatus } from './vin.ts';

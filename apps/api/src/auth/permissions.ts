// The one permission map (CLAUDE.md → Tenancy and security). Every route names a permission with @Can, or is
// explicitly @Public; a route with neither is refused (default deny, enforced in auth.guard.ts).
import { SetMetadata } from '@nestjs/common';
import { ROLES } from '@app/contracts';

type Role = (typeof ROLES)[number];

// Who records the business: firm accountants and admins, and the client's owner and staff.
const RECORDERS = ['firm_admin', 'firm_accountant', 'client_owner', 'client_staff'] as const;
// Who reads the books' detail: recorders plus firm reviewers. client_viewer (investor, partner) sees only dashboards
// and delivered reports (spec → roles), so never the counterparty register (phones, emails, TINs) or the car list.
const READERS = [...RECORDERS, 'firm_reviewer'] as const;

export const PERMISSIONS = {
  'me.read': ROLES,
  'counterparties.read': READERS,
  'counterparties.write': RECORDERS,
  'vehicles.read': READERS,
  'vehicles.write': RECORDERS,
  'documents.upload': RECORDERS,
  'documents.read': READERS,
  'job_orders.read': READERS,
  'job_orders.write': RECORDERS,
  'cost_types.read': READERS,
  // Cost types are the client's configuration and decide which costs need a receipt (security review of 0019): the firm's
  // accountants and admins and the client's owner add them, not client staff (a look-alike type could skip the receipt rule).
  'cost_types.write': ['firm_admin', 'firm_accountant', 'client_owner'],
  // A client's containers: kept by the people who record its costs (0019); any recorder closes one (owner default, 2026-11-17).
  'shipments.read': READERS,
  'shipments.write': RECORDERS,
  // Recording a business event in the ledger (ADR 0017): the same people who record the business.
  'postings.write': RECORDERS,
  // A correction is our accounting call (owner 2026-11-17): a reversal is posted by firm accountants and admins only.
  'postings.reverse': ['firm_admin', 'firm_accountant'],
  // A firm reviewer or admin signs off a flag the database raised on a client's job (owner 2026-11-17). It clears that flag and
  // never unlocks a posting. The database checks the role too, and refuses anyone who touched what the flag is about (0014).
  'job_orders.sign_off': ['firm_reviewer', 'firm_admin'],
  // Reports on screen (spec → Reports): the people who read the books' detail. Clients see the spot basis only (ADR 0009); the
  // pool basis is the firm's management view. ponytail: no per-client basis setting yet, add it when the firm moves a client to pool.
  'reports.read': READERS,
  'reports.pool_basis': ['firm_admin', 'firm_accountant', 'firm_reviewer'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const permissionsOf = (role: Role): Permission[] =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => (PERMISSIONS[p] as readonly Role[]).includes(role));

export const CAN = 'permission';
export const PUBLIC = 'public';
export const Can = (permission: Permission) => SetMetadata(CAN, permission);
export const Public = () => SetMetadata(PUBLIC, true);

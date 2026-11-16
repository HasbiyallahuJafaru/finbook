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
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const permissionsOf = (role: Role): Permission[] =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => (PERMISSIONS[p] as readonly Role[]).includes(role));

export const CAN = 'permission';
export const PUBLIC = 'public';
export const Can = (permission: Permission) => SetMetadata(CAN, permission);
export const Public = () => SetMetadata(PUBLIC, true);
